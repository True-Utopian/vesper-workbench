import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const args = process.argv.slice(2), value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
if (!value('--data-root') || !value('--output')) throw new Error('Usage: node scripts/qualify-api-docs.mjs --data-root <running pair> --output <private receipt> [--examples <reviewed directory>] [--python <executable>]');
const root = resolve(import.meta.dirname, '..'), directory = resolve(value('--data-root')), output = resolve(value('--output'));
const report = { at: new Date().toISOString(), state: 'running', author: 'true-utopian', scope: value('--scope') || 'running-pair', versions: {}, checks: [], errors: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Git text checkout line endings do not change rendered documentation.
// Keep exact bytes for images and every other non-text resource.
const documentDigest = (file, bytes) => digest(/\.(?:html|css|js|json|svg|txt)$/.test(file) ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n','\n')) : bytes);
const clients = {};
async function privateSnapshot(relative) {
  const folder = join(directory, relative), files = [];
  async function visit(path) {
    let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink(), 'Credential snapshot does not follow links');
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child); else if (entry.isFile()) files.push([child.slice(folder.length), digest(await readFile(child))]);
    }
  }
  await visit(folder); return files.sort(([a], [b]) => a.localeCompare(b));
}
let privateBefore, schedulesBefore;
const privatePaths = ['browser/secrets', 'browser/proxy-inventory', 'workbench/scheduler'];
await mkdir(dirname(output), { recursive: true });
try {
  privateBefore = await Promise.all(privatePaths.map(privateSnapshot));
  for (const kind of ['browser', 'workbench']) {
    const record = JSON.parse(await readFile(join(directory, kind, 'service.json'), 'utf8'));
    assert.ok(Number.isInteger(record.port) && record.port > 0 && record.port < 65536);
    const secret = await readFile(join(directory, kind, 'admin-token')), token = secret.toString('utf8').trim(), origin = `http://127.0.0.1:${record.port}`;
    const request = async (path, authenticated = false) => fetch(origin + path, { headers: authenticated ? { authorization: `Bearer ${token}` } : {}, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const api = async path => { const response = await request('/api/v1/' + path, true); assert.equal(response.status, 200); return response.json(); };
    const before = await api(kind === 'browser' ? 'profiles' : 'runs');
    const capabilities = await api('capabilities'), metadata = JSON.parse(await readFile(join(root, kind === 'browser' ? 'packages/vesper-browser/package.json' : 'package.json'), 'utf8'));
    assert.equal(capabilities.version, metadata.version); report.versions[kind] = capabilities.version;
    clients[kind] = { origin, token, api, before, secretHash: digest(secret) };
    if (kind === 'workbench') schedulesBefore = await api('schedules');
    const context = await (await request('/docs/context.json')).json();
    assert.equal(context.product, kind === 'browser' ? 'Browser' : 'Workbench'); assert.equal(context.version, capabilities.version); assert.equal(context.apiVersion, capabilities.apiVersion);
    if (context.browserDocs) assert.equal(context.browserDocs, clients.browser.origin + '/docs');
    for (const [path, source] of [['/docs', 'index.html'], ['/docs/', 'index.html'], ['/docs/app.js', 'app.js'], ['/docs/styles.css', 'styles.css'], ['/docs/guides.json', 'guides.json'], ['/docs/vesper-mark.svg', '../vesper-mark.svg']]) {
      const response = await request(path); assert.equal(response.status, 200, path); assert.ok(response.headers.get('content-security-policy')?.includes("script-src 'self'"));
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(documentDigest(source,bytes), documentDigest(source,await readFile(join(root, 'packages/vesper-browser/public/docs', source))), `${kind} has the reviewed bundled ${source}`);
      assert.ok(!bytes.toString().includes(token));
    }
    const schema = await (await request('/docs/openapi.json')).json();
    const privateSchema = await api('openapi.json');
    const paths = Object.fromEntries(Object.entries(privateSchema.paths).filter(([p]) => kind === 'browser' || p.startsWith('/api/v1/')));
    assert.deepEqual(schema.paths, paths);
    assert.equal((await request('/api/v1/openapi.json')).status, 401);
    assert.equal((await request('/api/v1/' + (kind === 'browser' ? 'profiles' : 'runs'))).status, 401);
    assert.equal((await request('/docs/admin-token')).status, 404);
    report.checks.push(`${kind}: current version, exact reviewed offline assets and versioned contract; token remains private and API authentication is unchanged`);
    const handbookResponse = await request('/docs/handbook/offline-manifest.json'); assert.equal(handbookResponse.status, 200);
    const handbook = await handbookResponse.json();
    const expectedHandbook = JSON.parse(await readFile(join(root, 'packages/vesper-browser/public/docs/handbook/offline-manifest.json'), 'utf8'));
    assert.deepEqual(handbook, expectedHandbook);
    assert.equal(handbook.release.browser, report.versions.browser);
    for (const file of handbook.files) {
      const response = await request('/docs/handbook/' + file); assert.equal(response.status, 200, file);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(documentDigest(file,bytes), documentDigest(file,await readFile(join(root, 'packages/vesper-browser/public/docs/handbook', file))), `${kind}: reviewed handbook ${file}`);
      assert.ok(!bytes.toString().includes(token));
    }
    assert.equal((await request('/docs/handbook/wiki/private.html')).status, 404);
    report.checks.push(`${kind}: all ${handbook.files.length} full-handbook files match reviewed source, stay read-only and preserve private API access`);
  }
  if (value('--examples')) {
    // These are the exact read-only samples copied from the reviewed docs UI.
    const examples = resolve(value('--examples')), exec = promisify(execFile);
    for (const kind of ['browser', 'workbench']) for (const [language, executable] of [['ts', process.execPath], ['py', value('--python') || 'python3']]) {
      const path = join(examples, `${kind}-get.${language}`), source = await readFile(path, 'utf8');
      assert.ok(source.includes(clients[kind].origin + '/api/v1/' + (kind === 'browser' ? 'profiles' : 'automations')));
      assert.ok(source.includes('"GET"')); assert.ok(!source.includes(clients[kind].token));
      const result = await exec(executable, [path], { windowsHide: true, timeout: 45000, env: { ...process.env, VESPER_TOKEN: clients[kind].token } });
      const data = JSON.parse(result.stdout); assert.ok(Array.isArray(data));
      report.checks.push(`${kind}: copied ${language === 'ts' ? 'TypeScript' : 'Python'} GET example executed successfully`);
    }
    const preview = join(examples, 'workbench-preview.py');
    const source = await readFile(preview, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (source) {
      assert.ok(source.includes(clients.workbench.origin + '/api/v1/schedules/preview')); assert.ok(source.includes('"POST"')); assert.ok(!source.includes(clients.workbench.token));
      const result = await exec(value('--python') || 'python3', [preview], { windowsHide: true, timeout: 45000, env: { ...process.env, VESPER_TOKEN: clients.workbench.token } });
      const data = JSON.parse(result.stdout); assert.equal(data.occurrences.length, 5); assert.equal(new Date(data.occurrences[0]).toISOString(), '2026-03-30T08:00:00.000Z');
      report.checks.push('Copied Python calendar preview returns the expected London DST occurrences without creating a schedule');
    }
  }
  for (const kind of ['browser', 'workbench']) {
    assert.deepEqual(await clients[kind].api(kind === 'browser' ? 'profiles' : 'runs'), clients[kind].before);
    assert.equal(digest(await readFile(join(directory, kind, 'admin-token'))), clients[kind].secretHash);
  }
  assert.deepEqual(await clients.workbench.api('schedules'), schedulesBefore);
  assert.deepEqual(await Promise.all(privatePaths.map(privateSnapshot)), privateBefore);
  report.checks.push('Opening documentation and running read-only examples preserves profile/run/schedule records, credential bytes and encrypted Browser proxy vaults');
  report.state = 'passed';
} catch (error) { report.state = 'failed'; report.errors.push(error.message); process.exitCode = 1; }
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ state: report.state, scope: report.scope, versions: report.versions, checks: report.checks.length, errors: report.errors }));
