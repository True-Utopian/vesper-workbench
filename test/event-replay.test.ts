import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const token = 'owned-event-replay-fixture-token-00001';
class OwnedRuntime extends EventEmitter {
  submissions = 0;
  run = { id: 'owned-run', state: 'running', step: 0 };
  listAutomations() { return []; } list() { return [this.run]; }
  get() { return this.run; } submit() { this.submissions++; return this.run; }
  cancel() {} pause() {} resume() {} retryExport() {} done() {} provideInput() {}
  async screenshot() { return Buffer.alloc(0); }
  change(state: string) { this.run = { ...this.run, state, step: this.run.step + 1 }; this.emit('run', this.run); }
}
async function stream(url: string, cursor?: string) {
  const controller = new AbortController();
  const response = await fetch(url + '/api/v1/events', { headers: { authorization: `Bearer ${token}`, ...(cursor ? { 'last-event-id': cursor } : {}) }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  return {
    close: () => controller.abort(),
    async next() {
      for (;;) {
        const index = buffer.indexOf('\n\n');
        if (index >= 0) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1]; if (!type) continue;
          return { type, id: /^id: (.+)$/m.exec(frame)?.[1]!, data: JSON.parse(/^data: (.+)$/m.exec(frame)![1]!) };
        }
        const part = await reader.read(); if (part.done) throw Error('Event stream closed before expected update');
        buffer += decoder.decode(part.value, { stream: true });
      }
    },
  };
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('Expected durable event did not commit');
}
function childMessage(child: ChildProcess, type: string, milliseconds = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', failed); };
    const message = (value: any) => { if (value.type === type) { cleanup(); resolve(value); } else if (value.type === 'failure') failed(Error(value.message)); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = () => failed(Error('Owned fixture exited before ' + type));
    const timer = setTimeout(() => failed(Error('Owned fixture timed out: ' + type)), milliseconds);
    child.on('message', message); child.once('exit', exited); child.once('error', failed);
  });
}

test('authenticated reconnect replays disconnected updates once, then follows live committed events', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-event-api-'));
  const runtime = new OwnedRuntime(), config = await loadConfig({ WORKBENCH_DATA_DIR: directory, EXPORT_DIR: directory, WORKBENCH_TOKEN: token });
  const app = await createServer(config, runtime, { publicInventory: () => [] });
  let first: Awaited<ReturnType<typeof stream>> | undefined, second: typeof first;
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    first = await stream(url); assert.equal((await first.next()).type, 'reset');
    runtime.change('paused'); const paused = await first.next(); assert.equal(paused.data.state, 'paused');
    first.close(); runtime.change('saved');
    await waitFor(async () => JSON.parse(await readFile(join(directory, 'run-events.json'), 'utf8')).events.at(-1).data.includes('saved'));
    second = await stream(url, paused.id); const saved = await second.next();
    assert.equal(saved.type, 'run'); assert.equal(saved.data.state, 'saved'); assert.notEqual(saved.id, paused.id);
    runtime.change('interrupted'); const live = await second.next(); assert.equal(live.data.state, 'interrupted');
    assert.equal(Number(live.id.split(':')[1]), Number(saved.id.split(':')[1]) + 1);
    assert.equal(runtime.submissions, 0, 'Notification replay cannot admit another automation');
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ url: '/api/v1/events', headers: { ...headers, 'last-event-id': 'invalid' } })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/v1/events', headers: { 'last-event-id': saved.id } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/events', headers: { ...headers, origin: 'https://unrelated.example' } })).statusCode, 403);
    const docs = (await app.inject({ url: '/docs/openapi.json' })).json();
    assert.ok(docs.paths['/api/v1/events'].get.parameters.some((parameter: any) => parameter.name === 'last-event-id'));
  } finally { first?.close(); second?.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('normal service restart retains the cursor epoch and reconciles latest run state without action replay', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-event-restart-'));
  const config = await loadConfig({ WORKBENCH_DATA_DIR: directory, EXPORT_DIR: directory, WORKBENCH_TOKEN: token });
  const runtime = new OwnedRuntime(); let app = await createServer(config, runtime, { publicInventory: () => [] });
  let events: Awaited<ReturnType<typeof stream>> | undefined;
  try {
    let url = await app.listen({ host: '127.0.0.1', port: 0 }); events = await stream(url);
    await events.next(); runtime.change('saved'); const saved = await events.next();
    events.close(); await app.close();
    const restarted = new OwnedRuntime(); restarted.run = { ...runtime.run };
    app = await createServer(config, restarted, { publicInventory: () => [] });
    url = await app.listen({ host: '127.0.0.1', port: 0 }); events = await stream(url, saved.id);
    const reconciled = await events.next(); assert.equal(reconciled.type, 'run'); assert.equal(reconciled.data.state, 'saved');
    assert.equal(reconciled.id.split(':')[0], saved.id.split(':')[0]);
    assert.equal(Number(reconciled.id.split(':')[1]), Number(saved.id.split(':')[1]) + 1);
    assert.equal(runtime.submissions + restarted.submissions, 0);
  } finally { events?.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('history write failure closes existing streams and rejects later streams without stopping run-state reads', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-event-failure-'));
  const config = await loadConfig({ WORKBENCH_DATA_DIR: directory, EXPORT_DIR: directory, WORKBENCH_TOKEN: token });
  const runtime = new OwnedRuntime(), app = await createServer(config, runtime, { publicInventory: () => [] });
  const controller = new AbortController();
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(url + '/api/events', { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    const reader = response.body!.getReader(); await reader.read();
    const file = join(directory, 'run-events.json'); await rm(file); await mkdir(file); runtime.change('saved');
    while (!(await reader.read()).done) {};
    const headers = { authorization: `Bearer ${token}` };
    const rejected = await app.inject({ url: '/api/v1/events', headers }); assert.equal(rejected.statusCode, 503);
    assert.ok(!rejected.body.includes(directory));
    assert.equal((await app.inject({ url: '/api/v1/runs', headers })).json()[0].state, 'saved');
    assert.equal(runtime.submissions, 0);
  } finally { controller.abort(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('acknowledged notification history survives abrupt termination of only the owned service process', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-event-crash-'));
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  const observed: string[] = []; let phase = 'first-start';
  const start = () => { const owned = fork(new URL('./fixtures/run-event-service.mjs', import.meta.url), [directory], { execPath: process.execPath, execArgv: ['--import', 'tsx'], env: childEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }); owned.on('message', (message: any) => observed.push(phase + ':' + message.type + (message.name ? ':' + message.name : ''))); return owned; };
  let child = start(), events: Awaited<ReturnType<typeof stream>> | undefined;
  let stderr = ''; const errors = (part: Buffer) => { stderr = (stderr + part.toString()).slice(-2000); }; child.stderr?.on('data', errors);
  try {
    let ready = await childMessage(child, 'ready'); events = await stream(ready.origin); await events.next();
    child.send({ type: 'change', state: 'paused' }); const paused = await events.next();
    const change = childMessage(child, 'changed'); child.send({ type: 'change', state: 'saved' });
    assert.equal((await change).submissions, 0); const committed = await events.next(); assert.equal(committed.data.state, 'saved');
    events.close(); const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
    // Scheduler's unchanged process lease deliberately waits 10s before stale
    // owner recovery. Preserve that safeguard rather than deleting its lock.
    phase = 'restart'; child = start(); child.stderr?.on('data', errors); ready = await childMessage(child, 'ready', 16000);
    events = await stream(ready.origin, paused.id);
    const retained = await events.next(), reconciled = await events.next();
    assert.equal(retained.id, committed.id); assert.deepEqual(retained.data, committed.data);
    assert.equal(reconciled.type, 'run'); assert.equal(reconciled.data.state, 'saved');
    assert.equal(Number(reconciled.id.split(':')[1]), Number(retained.id.split(':')[1]) + 1);
    events.close(); const closed = childMessage(child, 'closed'), exited = once(child, 'exit'); child.send({ type: 'close' });
    assert.equal((await closed).submissions, 0); await exited;
  } catch (error) { throw new Error(String(error) + '\n' + phase + ' ' + observed.join(',') + (stderr ? '\n' + stderr : ''), { cause: error }); }
  finally { events?.close(); if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; } await rm(directory, { recursive: true, force: true }); }
});
