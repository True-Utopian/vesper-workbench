import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir, open, unlink, readdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {spawn} from 'node:child_process';
import {VesperBrowserClient} from '../packages/vesper-browser/dist/client.js';
import {createSeleniumDiscovery} from './lib/selenium-discovery.mjs';

const option = name => {const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1];};
for (const name of ['--data-root', '--driver', '--driver-sha', '--kernel-sha', '--output', '--python']) assert.ok(option(name), 'Provide ' + name);
const data = resolve(option('--data-root')), output = resolve(option('--output'));
const driver = resolve(option('--driver')), driverSha = option('--driver-sha'), kernelSha = option('--kernel-sha');
assert.match(driverSha, /^[a-f0-9]{64}$/); assert.match(kernelSha, /^[a-f0-9]{64}$/);
assert.equal(createHash('sha256').update(await readFile(driver)).digest('hex'), driverSha);
await mkdir(output, {recursive: true});
assert.equal((await readdir(output)).length, 0, 'Use a fresh output; preserve previous qualification work');
const lock = await open(join(output, 'qualification.lock'), 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close();
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const delay = ms => new Promise(done => setTimeout(done, ms));
const busy = new Set(['queued', 'preparing', 'starting', 'running', 'paused', 'awaiting_input', 'saving', 'recovering']);
const report = {schemaVersion: 1, at: new Date().toISOString(), state: 'running', platform: process.platform,
  scope: 'Real Selenium/ChromeDriver attachment to Browser-owned native profiles in the supplied running desktop pair; no substitute browser or universal WebDriver claim',
  actualInstalledProof: process.argv.includes('--actual-installed'), checks: [], errors: [], executableSha256: kernelSha, driverSha256: driverSha};
const owned = []; let runId, client, workbench, baselineProfiles, baselineRuns, fixture, ownedEffects = 0;
async function service(kind) {
  const record = await json(join(data, kind, 'service.json')), token = (await readFile(join(data, kind, 'admin-token'), 'utf8')).trim();
  assert.ok(Number.isInteger(record.port) && record.port > 0 && record.port < 65536);
  const url = 'http://127.0.0.1:' + record.port;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(url + '/api/v1' + path, {method, redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: {authorization: 'Bearer ' + token, ...(body ? {'content-type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
    assert.ok(response.ok, kind + ' HTTP ' + response.status);
    return response.headers.get('content-type')?.includes('json') ? response.json() : Buffer.from(await response.arrayBuffer());
  };
  return {url, api};
}
async function waitRun(state) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    const run = await workbench.api('/runs/' + runId);
    if (run.state === state) return run;
    assert.ok(!['failed', 'interrupted', 'export_failed', 'cancelled'].includes(run.state), run.error ?? run.state);
    await delay(100);
  }
  throw Error('Timed out waiting for owned run ' + state);
}
async function selenium(id, phase, url, marker) {
  const endpoint = new URL(await client.connectionUrl(id));
  assert.equal(endpoint.protocol, 'ws:'); assert.equal(endpoint.hostname, '127.0.0.1'); assert.ok(endpoint.port && !endpoint.username && !endpoint.password);
  const path = join(output, phase + '.json');
  const discovery = await createSeleniumDiscovery(endpoint.href);
  const args = [join(import.meta.dirname, 'qualify-selenium.py'), '--address', discovery.address, '--driver', driver,
    '--driver-sha256', driverSha, '--url', url, '--marker', marker, '--phase', phase, '--output', path];
  try {
  const child = spawn(option('--python'), args, {env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  const code = await new Promise((done, reject) => {child.once('error', reject); child.once('exit', done);});
  await writeFile(join(output, phase + '.log'), log); assert.equal(code, 0, 'Read the retained Selenium ' + phase + ' log');
  const result = await json(path); assert.equal(result.state, 'passed'); assert.equal(result.driverQuitPassed, true);
  // ChromeDriver must detach; only Vesper may stop or archive this owned profile.
  assert.equal((await client.listProfiles()).find(profile => profile.id === id)?.state, 'running');
  const response = await fetch('http://' + discovery.address + '/json/version', {signal: AbortSignal.timeout(10000)}); assert.ok(response.ok);
  report[phase] = result;
  } finally {await discovery.close();}
}
try {
  const browser = await service('browser'); workbench = await service('workbench');
  report.versions = {browser: (await browser.api('/capabilities')).version, workbench: (await workbench.api('/capabilities')).version};
  assert.deepEqual(report.versions, {browser: (await json('packages/vesper-browser/package.json')).version, workbench: (await json('package.json')).version});
  client = new VesperBrowserClient({url: browser.url, tokenFile: join(data, 'browser/admin-token'), timeoutMs: 120000});
  baselineProfiles = await client.listProfiles(); baselineRuns = await workbench.api('/runs');
  assert.ok(baselineProfiles.every(p => p.state !== 'running' && !p.lease));
  assert.ok(baselineRuns.every(r => !busy.has(r.state) && !r.cleanupRequired));
  assert.ok((await workbench.api('/schedules')).every(s => !s.enabled));
  report.checks.push('Matching installed services are idle before creating explicitly owned test work');
  const marker = 'vesper-selenium-' + randomUUID();
  fixture = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'POST' && req.url === '/effect') {ownedEffects++; res.end('ok'); return;}
    if (req.url === '/worker.js') {res.setHeader('content-type', 'text/javascript'); res.end('postMessage(42)'); return;}
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/frame') {res.end('<!doctype html><p id="frame-value">Owned frame</p>'); return;}
    res.end('<!doctype html><title>Owned Vesper Selenium fixture</title><script>window.firstIdentity={cpu:navigator.hardwareConcurrency,memory:navigator.deviceMemory}</script><h1>Owned Selenium fixture</h1><label>Message <input id="message"></label><button id="save" onclick="fetch(\'/effect\',{method:\'POST\'}).then(()=>{localStorage.setItem(\'vesper-selenium\',message.value);result.textContent=message.value})">Save</button><output id="result"></output><iframe id="owned-frame" src="/frame"></iframe>');
  });
  await new Promise(done => fixture.listen(0, '127.0.0.1', done)); const url = 'http://127.0.0.1:' + fixture.address().port + '/';
  const created = await workbench.api('/runs', 'POST', {automationId: 'inspect', preset: 'fast', inputs: {url, engine: 'vesper', identityPreset: 'desktop-4', protection: 'standard', webgl: 'restricted', audio: 'seeded', fonts: 'restricted'}});
  runId = created.id; const active = await waitRun('running'); owned.push(active.profileId); await client.claimProfile(active.profileId, runId);
  const unclaimed = new VesperBrowserClient({url: browser.url, tokenFile: join(data, 'browser/admin-token')});
  await assert.rejects(unclaimed.connectionUrl(active.profileId), error => [403, 409].includes(error.status));
  const environment = await client.environmentReport(active.profileId); assert.equal(environment.fingerprint.nativeKernel.qualification.executableSha256, kernelSha);
  report.checks.push('Workbench owns the native run lease; a client without that lease cannot obtain its endpoint');
  await selenium(active.profileId, 'seed', url, marker); assert.equal(ownedEffects, 1);
  report.checks.push('Real Selenium actions execute once and driver.quit leaves the Workbench-owned browser running');
  await workbench.api('/runs/' + runId + '/finish', 'POST', {}); const saved = await waitRun('saved');
  const archive = await workbench.api('/runs/' + runId + '/artifact'); assert.equal(createHash('sha256').update(archive).digest('hex'), saved.artifact.sha256);
  const file = join(output, 'owned-profile.workbench.tgz'); await writeFile(file, archive, {flag: 'wx', mode: 0o600});
  report.archive = {state: saved.state, bytes: archive.length, sha256: saved.artifact.sha256};
  report.checks.push('Workbench Finish stops the owned browser and saves a checksum-verified profile archive');
  const restored = await client.importProfile(file); owned.push(restored.id); assert.notEqual(restored.id, active.profileId);
  await client.claimProfile(restored.id, runId); await client.start(restored.id); await selenium(restored.id, 'restore', url, marker); assert.equal(ownedEffects, 1);
  await client.stop(restored.id); await client.releaseProfile(restored.id);
  report.checks.push('A separately imported profile restores Selenium-created cookie/storage without repeating the owned effect');
  assert.deepEqual((await client.listProfiles()).filter(p => baselineProfiles.some(o => o.id === p.id)), baselineProfiles);
  assert.deepEqual((await workbench.api('/runs')).filter(r => baselineRuns.some(o => o.id === r.id)), baselineRuns);
  report.originalProfilesPreserved = true; report.originalRunsPreserved = true;
  report.checks.push('Every pre-existing profile and historical run remains unchanged');
  report.state = 'passed';
} catch (error) {report.state = 'failed'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;}
finally {
  if (runId && workbench && report.state !== 'passed') {try {const r = await workbench.api('/runs/' + runId); if (busy.has(r.state)) await workbench.api('/runs/' + runId + '/cancel', 'POST', {});} catch (e) {report.errors.push('Owned run cleanup: ' + e.message);}}
  for (const id of owned) {try {await client.stop(id); await client.releaseProfile(id); await client.trash(id);} catch (e) {report.errors.push('Owned profile cleanup: ' + e.message);}}
  if (fixture) {fixture.closeAllConnections(); await new Promise(done => fixture.close(done));}
  if (report.errors.length) {report.state = 'failed'; process.exitCode = 1;}
  report.ownedEffects = ownedEffects; report.completedAt = new Date().toISOString();
  await writeFile(join(output, 'qualification.json'), JSON.stringify(report, null, 2), {flag: 'wx'}); await unlink(join(output, 'qualification.lock'));
}
console.log(JSON.stringify({state: report.state, checks: report.checks.length, errors: report.errors}));
