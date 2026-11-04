import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunEventJournal, parseEventCursor } from '../src/run-events.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-events-'));
  const file = join(directory, 'events.json'), journal = new RunEventJournal(file);
  await journal.init();
  return { file, journal, close: async () => { await journal.drain(); await rm(directory, { recursive: true, force: true }); } };
}

test('committed run snapshots remain ordered and replay exactly across restart', async () => {
  const f = await fixture();
  try {
    const cursor = f.journal.cursor, commits: string[] = [];
    f.journal.on('commit', event => commits.push(f.journal.id(event)));
    const run = { id: 'owned', state: 'running', logs: [] as string[] };
    const first = f.journal.append(run); run.state = 'saved'; run.logs.push('later mutation');
    const second = f.journal.append(run); await Promise.all([first, second]);
    const replay = f.journal.replay(cursor);
    assert.equal(replay.reset, false); assert.deepEqual(replay.events.map(e => JSON.parse(e.data).state), ['running', 'saved']);
    assert.deepEqual(JSON.parse(replay.events[0]!.data).logs, []);
    assert.deepEqual(commits.map(id => parseEventCursor(id).sequence), [1, 2]);
    const reopened = new RunEventJournal(f.file); await reopened.init();
    assert.deepEqual(reopened.replay(cursor), replay);
    assert.deepEqual(reopened.replay(commits[0]).events.map(e => JSON.parse(e.data).state), ['saved']);
    assert.equal(reopened.replay(commits[1]).events.length, 0);
    await reopened.append({ id: 'owned', state: 'interrupted' });
    assert.equal(parseEventCursor(reopened.cursor).sequence, 3);
  } finally { await f.close(); }
});

test('bounded history signals refresh for expired, foreign and future cursors', async () => {
  const f = await fixture();
  try {
    const old = f.journal.cursor;
    for (let i = 0; i < 514; i++) await f.journal.append({ id: 'owned', state: String(i) });
    assert.equal(f.journal.replay(old).reset, true);
    const epoch = parseEventCursor(old).epoch;
    assert.equal(f.journal.replay(epoch + ':1').reset, true);
    const retained = f.journal.replay(epoch + ':2'); assert.equal(retained.reset, false); assert.equal(retained.events.length, 512);
    assert.equal(f.journal.replay(epoch + ':999').reset, true);
    assert.equal(f.journal.replay('00000000-0000-0000-0000-000000000000:2').reset, true);
    assert.equal(f.journal.replay().reset, true);
    const reopened = new RunEventJournal(f.file); await reopened.init();
    assert.deepEqual(reopened.replay(epoch + ':2'), retained);
  } finally { await f.close(); }
});

test('invalid and unsafe event cursors are rejected instead of silently skipping updates', () => {
  for (const value of ['', '7', 'invalid:1', '00000000-0000-0000-0000-000000000000:-1', '00000000-0000-0000-0000-000000000000:01', '00000000-0000-0000-0000-000000000000:9007199254740992', '00000000-0000-0000-0000-000000000000:1\n']) {
    assert.throws(() => parseEventCursor(value), (error: any) => error.statusCode === 400, value);
  }
});

test('corrupted history is preserved and refuses startup rather than resetting cursors', async () => {
  const f = await fixture();
  try {
    await f.journal.append({ id: 'owned', state: 'saved' });
    const value = JSON.parse(await readFile(f.file, 'utf8')); value.events[0].sequence = 4;
    const damaged = JSON.stringify(value); await writeFile(f.file, damaged);
    await assert.rejects(new RunEventJournal(f.file).init(), /Invalid run event/);
    assert.equal(await readFile(f.file, 'utf8'), damaged);
  } finally { await f.close(); }
});

test('failed persistence never emits a committed ID and makes replay explicitly unavailable', async () => {
  const f = await fixture(); let commits = 0, failures = 0;
  try {
    f.journal.on('commit', () => commits++); f.journal.on('unavailable', () => failures++);
    await rm(f.file); await mkdir(f.file);
    await assert.rejects(f.journal.append({ id: 'owned', state: 'saved' }));
    await assert.rejects(f.journal.append({ id: 'owned', state: 'running' }));
    assert.equal(commits, 0); assert.equal(failures, 1);
    assert.throws(() => f.journal.replay(), (error: any) => error.statusCode === 503);
    assert.equal(parseEventCursor(f.journal.cursor).sequence, 0);
  } finally { await f.close(); }
});

test('byte retention remains bounded and oversized events cannot advertise a commit', async () => {
  const f = await fixture();
  try {
    const old = f.journal.cursor;
    for (let i = 0; i < 36; i++) await f.journal.append({ id: 'owned', log: 'x'.repeat(240 * 1024), step: i });
    assert.ok((await readFile(f.file)).length <= 8 * 1024 * 1024);
    assert.equal(f.journal.replay(old).reset, true);
    const before = await readFile(f.file, 'utf8');
    await assert.rejects(f.journal.append({ id: 'owned', log: 'x'.repeat(1024 * 1024) }), /capacity/);
    assert.equal(await readFile(f.file, 'utf8'), before);
  } finally { await f.close(); }
});
