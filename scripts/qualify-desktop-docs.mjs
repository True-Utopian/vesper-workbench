import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { chromium, _electron } from 'playwright';
import * as tar from 'tar';
import plugin from '../desktop/plugin-contract.cjs';
import { readAsarText } from './lib/desktop-metadata.mjs';

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
assert.ok(option('--executable') && option('--output'), 'Provide --executable and a private --output directory');
const executable = await realpath(resolve(option('--executable'))), actual = args.includes('--actual'), standalone = args.includes('--standalone');
const packagedIntegration = args.includes('--packaged-integration');
assert.ok(!packagedIntegration || !actual, 'Packaged integration uses an owned fixture; actual installations use --integration');
await mkdir(resolve(option('--output')), { recursive: true }); const output = await realpath(resolve(option('--output')));
assert.ok(!option('--data-root') || actual, 'Explicit user stores require --actual; owned fixtures use a new private temporary store');
assert.ok(!standalone || !actual, 'Standalone qualification uses a new owned fixture');
assert.ok(!args.includes('--default-store') || actual, 'Default-store qualification requires the actual installed application and its explicit expected data root');
const data = await realpath(actual ? resolve(option('--data-root')) : await mkdtemp(join(tmpdir(), 'vesper-desktop-docs-')));
const root = resolve(import.meta.dirname, '..'), json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const versions = { browser: (await json(join(root, 'packages/vesper-browser/package.json'))).version, workbench: (await json(join(root, 'package.json'))).version };
const report = { at: new Date().toISOString(), state: 'running', platform: process.platform, versions, actualInstalledProof: actual, standalone, dataRoot: data, checks: [], screenshots: [], errors: [], visualReviewPassed: false };
await mkdir(output, { recursive: true });
let app, web, cdp, dispatchedBrowser, browserApi, workbenchApi, active = false;
const busy = new Set(['queued', 'preparing', 'starting', 'running', 'paused', 'awaiting_input', 'saving', 'recovering']);
const pause = ms => new Promise(r => setTimeout(r, ms));
async function unusedPort() { const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port; await new Promise(done => server.close(done)); return port; }
async function service(kind) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const record = await json(join(data, kind, 'service.json')), token = (await readFile(join(data, kind, 'admin-token'), 'utf8')).trim();
      assert.ok(Number.isInteger(record.port) && record.port > 0 && record.port < 65536);
      const origin = `http://127.0.0.1:${record.port}`;
      const api = async path => { const response = await fetch(origin + '/api/v1/' + path, { headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200); return response.json(); };
      assert.equal((await api('capabilities')).version, versions[kind]); return { api, origin };
    } catch { await pause(200); }
  }
  throw Error(kind + ' did not become ready at the expected version');
}
async function command(argv) {
  const child = spawn(process.execPath, argv, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '';
  child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  await writeFile(join(output, 'api-examples.log'), log); assert.equal(code, 0, 'Read the retained API/example receipt');
}
async function qualify(commandFile, argv, name, receipt) {
  const child = spawn(commandFile, argv, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '';
  child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  await writeFile(join(output, name + '.log'), log); assert.equal(code, 0, 'Read the retained ' + name + ' log');
  const record = await json(receipt); assert.equal(record.state, 'passed');
  if (record.versions) assert.deepEqual(record.versions, versions); else assert.equal(record.version, versions.workbench);
  return record;
}
async function quit() {
  const processExit = new Promise((done, reject) => { const timer = setTimeout(() => reject(Error('The desktop has not exited after normal Quit')), 60000); app.process().once('exit', () => { clearTimeout(timer); done(); }); });
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(i => i.label === 'Quit').click());
  if (standalone) {
    const deadline = Date.now() + 30000; let drained = false;
    while (Date.now() < deadline) { try { await readFile(join(data, 'workbench/service.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; drained = true; break; } await pause(100); }
    assert.equal(drained, true, 'Standalone Workbench must finish its database/service drain first');
    assert.ok((await browserApi.api('profiles')).every(p => p.state !== 'running' && !p.lease));
    const token = (await readFile(join(data, 'browser/admin-token'), 'utf8')).trim();
    const response = await fetch(browserApi.origin + '/api/service/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) }); assert.ok(response.ok);
  }
  // Windows launch uses a cmd wrapper which can wait for the deliberately
  // independent Browser owner. Clean up that empty owned fixture before
  // awaiting the launcher exit; never stop an actual user's independent owner.
  await processExit;
  await cdp?.close(); cdp = undefined; app = undefined;
}
async function screenshot(page, name) { const path = join(output, name + '.png'); await page.screenshot({ path, scale: 'css' }); report.screenshots.push(path); }
try {
  if (process.platform === 'win32') {
    const product = JSON.parse(await readAsarText(dirname(executable), 'desktop/product.json'));
    assert.equal(product.product, standalone ? 'workbench' : 'browser'); assert.equal(product.version, standalone ? versions.workbench : versions.browser);
    if (!actual && !standalone) {
      assert.ok(option('--addon-manifest'), 'Provide a signed --addon-manifest for an owned fixture');
      const verified = await plugin.verifyPlugin(resolve(option('--addon-manifest')), await readAsarText(dirname(executable), 'desktop/update-public-key.pem'), { platform: process.platform, arch: process.arch });
      assert.equal(verified.version, versions.workbench); await plugin.installPlugin(verified, data, tar);
    }
  }
  const port = await unusedPort(); report.debugPort = port;
  const env = { ...process.env, VESPER_DESKTOP_DATA_DIR: data }; for (const key of ['ELECTRON_RUN_AS_NODE', 'VESPER_BROWSER_EXECUTABLE', 'VESPER_BUNDLED_KERNEL_MANIFEST']) delete env[key];
  if (args.includes('--default-store')) {
    const saved = await json(join(homedir(), '.vesper/desktop-location.json'));
    assert.equal(saved.schemaVersion, 1); assert.equal(await realpath(saved.dataRoot), data);
    delete env.VESPER_DESKTOP_DATA_DIR;
  }
  let dispatchPort;
  if (args.includes('--dispatch') && process.platform === 'linux') {
    dispatchPort = await unusedPort(); const handler = join(output, 'docs-default-browser.py');
    const command = [join(dirname(executable), 'resources/vesper-kernel/chrome'), '--user-data-dir=' + join(output, 'docs-browser-data'), '--remote-debugging-port=' + dispatchPort, '--remote-debugging-address=127.0.0.1', '--disable-gpu', '--no-first-run', '--no-default-browser-check'];
    await writeFile(handler, '#!/usr/bin/python3\nimport sys,subprocess\nfrom urllib.parse import urlparse\nu=sys.argv[-1];p=urlparse(u)\nassert p.scheme=="http" and p.hostname=="127.0.0.1" and p.path=="/docs" and not p.query and not p.username\nlog=open(' + JSON.stringify(join(output, 'default-browser.log')) + ',"a")\nsubprocess.Popen(' + JSON.stringify(command) + '+[u],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)\n', { mode: 0o700 });
    env.BROWSER = handler; env.XDG_CURRENT_DESKTOP = ''; env.DESKTOP_SESSION = '';
  }
  app = await _electron.launch({ executablePath: executable, env, args: ['--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1'], timeout: 120000 });
  const page = await app.firstWindow(); await page.locator('#workspace:not([hidden])').waitFor({ timeout: 120000 });
  if (packagedIntegration) {
    const product = JSON.parse(await readAsarText(dirname(executable), 'desktop/product.json'));
    assert.equal(product.product, standalone ? 'workbench' : 'browser'); assert.equal(product.version, versions[product.product]);
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true, 'Packaged integration must launch the real packaged desktop');
    report.packagedIntegrationProof = true;
  }
  if (args.includes('--default-store')) {
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), join(data, 'browser-desktop'));
    report.defaultDataLocationPassed = true;
    report.checks.push('Installed Browser starts without a data-root environment override and selects the registered original profile store');
  }
  report.launch = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { bounds: w.getBounds(), visible: w.isVisible(), minimized: w.isMinimized() }; });
  await app.evaluate(({ BrowserWindow, shell }, dispatch) => {
    const w = BrowserWindow.getAllWindows()[0]; if (w.isMinimized()) w.restore(); w.show();
    const original = shell.openExternal.bind(shell); globalThis.__docsUrls = []; globalThis.__dispatchedDocs = [];
    shell.openExternal = async url => { globalThis.__docsUrls.push(url); if (dispatch && !globalThis.__dispatchedDocs.includes(url)) { await original(url); globalThis.__dispatchedDocs.push(url); } };
  }, args.includes('--dispatch'));
  browserApi = await service('browser'); workbenchApi = await service('workbench');
  const before = await browserApi.api('profiles'), runsBefore = await workbenchApi.api('runs');
  assert.ok(before.every(p => p.state !== 'running' && !p.lease)); assert.ok(runsBefore.every(r => !busy.has(r.state) && !r.cleanupRequired));
  assert.ok((await workbenchApi.api('schedules')).every(s => !s.enabled));
  report.originalProfiles = before.length; report.originalRuns = runsBefore.length;
  if (packagedIntegration) {
    assert.equal(before.length, 0, 'Automatic fixture activation requires a new empty owned profile store');
    assert.equal(runsBefore.length, 0, 'Automatic fixture activation requires no existing runs');
    const { VesperBrowserClient } = await import('../packages/vesper-browser/dist/client.js');
    const client = new VesperBrowserClient({ url: browserApi.origin, tokenFile: join(data, 'browser/admin-token'), timeoutMs: 180000 });
    const native = await realpath(join(dirname(executable), 'resources/vesper-kernel', process.platform === 'win32' ? 'chrome.exe' : 'chrome'));
    const state = await client.engineVersions();
    const candidate = state.staged.find(entry => entry.family === 'vesper' && entry.executablePath === native && entry.executableSha256 === option('--kernel-sha'));
    assert.ok(candidate, 'The packaged native kernel must already be staged by the real desktop');
    const activation = await client.activateEngine(candidate.buildId, 'vesper');
    assert.equal(activation.profilesBackedUp, 0); assert.equal(activation.qualification.state, 'passed');
    assert.equal(activation.qualification.nativeProof, true); assert.equal(activation.qualification.executableSha256, option('--kernel-sha'));
    assert.equal(activation.qualification.cases.length, 9);
    const backup = await json(join(activation.backup, 'activation.json')); assert.equal(backup.state, 'activated');
    report.ownedNativeActivation = { backup: activation.backup, nativeCases: 9, executableSha256: activation.qualification.executableSha256, operatorInstallationChanged: false };
    report.checks.push('Empty owned packaged store passes idle preflight, fresh nine-case native qualification and the guarded zero-profile activation backup; operator kernel selection is unchanged');
  }
  if (!standalone) {
    await screenshot(page, 'browser-manager-launched');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
    await page.waitForFunction(() => innerWidth < 1100); await screenshot(page, 'browser-manager-small');
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setSize(bounds.width, bounds.height), report.launch.bounds);
  }
  cdp = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  let child = page;
  if (!standalone) { const childReady = cdp.contexts()[0].waitForEvent('page', { timeout: 30000 }); await page.getByRole('button', { name: 'Workbench', exact: true }).click(); child = await childReady; }
  await child.locator('#workspace:not([hidden])').waitFor({ timeout: 30000 });
  await screenshot(child, 'native-launched');
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.show(); w.setSize(1000, 720); });
  await child.waitForFunction(limit => innerWidth < limit, standalone ? 1100 : 800, { timeout: 15000 });
  report.smallLayout = await child.evaluate(() => {
    const nav = document.querySelector('.workspace-navigation nav');
    return { width: innerWidth, height: innerHeight, navOverflow: nav.scrollWidth > nav.clientWidth, buttons: [...nav.querySelectorAll('button')].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { label: e.textContent.trim(), visible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; }) };
  });
  assert.equal(report.smallLayout.navOverflow, false); assert.ok(report.smallLayout.buttons.every(b => b.visible), 'Every primary tab must fit without clipping');
  await screenshot(child, 'native-small'); report.checks.push('Native Workbench fits launch and smaller windows; every primary toolbar control is fully visible');
  if (args.includes('--controls')) {
    await child.locator('#new-run-button').click(); await child.locator('#automation-select').selectOption('inspect');
    const fields = child.locator('#input-fields [data-field]'); assert.equal(await fields.count(), 14);
    const choose = async (name, value) => { const control = child.locator(`#input-fields [data-field="${name}"]`); const values = JSON.parse(await control.getAttribute('data-enum')); assert.ok(values.includes(value)); await control.selectOption(String(values.indexOf(value))); };
    await child.locator('#input-fields [data-field="url"]').fill('http://127.0.0.1:9/');
    const policies = { engine: 'vesper', identityPreset: 'desktop-8', protection: 'standard', webgl: 'restricted', audio: 'seeded', fonts: 'restricted' };
    for (const [name, value] of Object.entries(policies)) await choose(name, value);
    await child.locator('#input-mode-button').click(); const inputs = JSON.parse(await child.locator('#json-input').inputValue());
    for (const [name, value] of Object.entries(policies)) assert.equal(inputs[name], value);
    await child.locator('#input-mode-button').click();
    for (const [name, value] of Object.entries(policies)) { const control = child.locator(`#input-fields [data-field="${name}"]`); assert.equal(JSON.parse(await control.getAttribute('data-enum'))[Number(await control.inputValue())], value); }
    await screenshot(child, 'inspect-small');
    const footer = await child.locator('#new-run-dialog .drawer-footer').evaluate(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }); assert.equal(footer, true);
    await child.locator('#new-run-dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await child.locator('#new-run-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await workbenchApi.api('runs'), runsBefore); report.checks.push('All 14 Inspect fields render; native identity and surface policies survive form/JSON/form, footer fits and Cancel creates no run');
  }
  await child.getByRole('button', { name: 'API Docs', exact: true }).click();
  await child.getByRole('button', { name: 'Connections & API', exact: true }).click(); await child.locator('#system-dialog').getByRole('button', { name: 'API Docs', exact: true }).click(); await child.keyboard.press('Escape');
  let manager = page;
  if (standalone) { const ready = app.waitForEvent('window', { timeout: 30000 }); await child.getByRole('button', { name: /Browser profiles/ }).click(); manager = await ready; await manager.locator('#workspace:not([hidden])').waitFor({ timeout: 30000 }); }
  await manager.getByRole('button', { name: 'API Docs', exact: true }).click();
  const urls = await app.evaluate(() => globalThis.__docsUrls);
  assert.equal(urls.filter(url => url === workbenchApi.origin + '/docs').length, 2); assert.ok(urls.includes(browserApi.origin + '/docs'));
  report.checks.push('Native Browser and both embedded Workbench controls select the exact credential-free running service URLs');
  report.externalDispatch = 'Routing observed with an owned shell probe; no external website or token transmission';
  if (args.includes('--dispatch')) {
    const deadline = Date.now() + 30000; let accepted = [];
    while (Date.now() < deadline) { accepted = await app.evaluate(() => globalThis.__dispatchedDocs); if (accepted.includes(browserApi.origin + '/docs') && accepted.includes(workbenchApi.origin + '/docs')) break; await pause(100); }
    assert.ok(accepted.includes(browserApi.origin + '/docs') && accepted.includes(workbenchApi.origin + '/docs'), 'Both normal OS handoffs must complete successfully');
    report.externalDispatch = 'OS accepted both credential-free localhost docs handoffs; host default associations unchanged';
    if (dispatchPort) {
      const deadline = Date.now() + 30000;
      while (!dispatchedBrowser && Date.now() < deadline) { try { dispatchedBrowser = await chromium.connectOverCDP('http://127.0.0.1:' + dispatchPort, { timeout: 2000 }); } catch { await pause(200); } }
      assert.ok(dispatchedBrowser, 'Per-process xdg-open browser must become ready');
      for (const kind of ['browser', 'workbench']) {
        const origin = kind === 'browser' ? browserApi.origin : workbenchApi.origin;
        const deadline = Date.now() + 20000; let tab;
        while (!tab && Date.now() < deadline) { tab = dispatchedBrowser.contexts()[0].pages().find(p => p.url().startsWith(origin + '/docs')); if (!tab) await pause(100); }
        assert.ok(tab, 'xdg-open must open each correct local reference'); await tab.getByRole('heading', { name: `Vesper ${kind === 'browser' ? 'Browser' : 'Workbench'} API`, exact: true }).waitFor(); await screenshot(tab, 'os-dispatch-' + kind);
      }
      report.externalDispatch += '; Linux per-process BROWSER handler opened both real sandboxed native reference pages under Xvfb';
    }
    report.checks.push(report.externalDispatch);
  }
  const native = join(dirname(executable), 'resources/vesper-kernel', process.platform === 'win32' ? 'chrome.exe' : 'chrome');
  web = await chromium.launch({ executablePath: native, chromiumSandbox: true, headless: true, args: ['--disable-background-networking'] });
  const context = await web.newContext({ viewport: { width: 1380, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] }); const external = [];
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); return route.abort(); } return route.continue(); });
  const docs = await context.newPage(); docs.on('pageerror', error => report.errors.push(error.message));
  const examples = join(output, 'examples'); await mkdir(examples);
  for (const kind of ['browser', 'workbench']) {
    const origin = kind === 'browser' ? browserApi.origin : workbenchApi.origin;
    await docs.goto(origin + '/docs'); await docs.getByRole('heading', { name: `Vesper ${kind === 'browser' ? 'Browser' : 'Workbench'} API`, exact: true }).waitFor();
    await screenshot(docs, kind + '-overview'); await docs.getByLabel('Find an endpoint or guide').fill(kind === 'browser' ? 'profiles' : 'automations'); await docs.getByLabel('HTTP method').selectOption('GET');
    await docs.getByRole('link', { name: 'GET /' + (kind === 'browser' ? 'profiles' : 'automations'), exact: true }).click();
    for (const language of ['TypeScript', 'Python']) { await docs.getByLabel('Example language').selectOption(language); await writeFile(join(examples, kind + '-get.' + (language === 'Python' ? 'py' : 'ts')), await docs.locator('.reference-columns>section:last-child pre').innerText()); }
  }
  await docs.getByLabel('Find an endpoint or guide').fill('schedules/preview'); await docs.getByLabel('HTTP method').selectOption('POST'); await docs.getByRole('link', { name: 'POST /schedules/preview', exact: true }).click();
  await docs.getByLabel('Example language').selectOption('Python'); await writeFile(join(examples, 'workbench-preview.py'), await docs.locator('.reference-columns>section:last-child pre').innerText()); await screenshot(docs, 'calendar-preview');
  await docs.getByLabel('Find an endpoint or guide').fill('no-such-endpoint-qa'); await docs.getByText('No matches.', { exact: false }).waitFor(); await docs.getByLabel('Find an endpoint or guide').fill(''); await docs.getByLabel('HTTP method').selectOption('');
  await docs.getByRole('link', { name: 'Schedules and timezones', exact: true }).first().click(); await docs.setViewportSize({ width: 390, height: 844 }); await screenshot(docs, 'mobile-guide');
  assert.equal(await docs.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); assert.deepEqual(external, []);
  report.checks.push('Offline web reference, search/filter reset, guide navigation, code languages and mobile layout pass with external requests blocked');
  await command(['scripts/qualify-api-docs.mjs', '--data-root', data, '--output', join(output, 'docs-api.json'), '--scope', actual ? 'actual-installed' : 'owned-installed-binary', '--examples', examples, '--python', option('--python') || 'python3']);
  report.api = await json(join(output, 'docs-api.json')); assert.equal(report.api.state, 'passed'); report.checks.push(...report.api.checks);
  assert.deepEqual(await browserApi.api('profiles'), before); assert.deepEqual(await workbenchApi.api('runs'), runsBefore); report.state = 'functional-passed-awaiting-visual-review';
  if (args.includes('--controls') && !standalone) {
    await page.locator('#addons-view').click();
    const preconnect = createConnection({ host: '127.0.0.1', port: Number(new URL(workbenchApi.origin).port) });
    await new Promise((done, reject) => { preconnect.once('connect', done); preconnect.once('error', reject); });
    const stoppedAt = Date.now();
    try { await page.getByRole('button', { name: 'Disable add-on', exact: true }).click(); await page.getByRole('button', { name: 'Enable add-on', exact: true }).waitFor({ timeout: 15000 }); }
    finally { preconnect.destroy(); }
    report.disableMilliseconds = Date.now() - stoppedAt; assert.equal(await page.locator('#workbench-view').isVisible(), false);
    await page.getByRole('button', { name: 'Enable add-on', exact: true }).click(); await page.getByRole('button', { name: 'Disable add-on', exact: true }).waitFor();
    workbenchApi = await service('workbench'); assert.deepEqual(await workbenchApi.api('runs'), runsBefore); assert.deepEqual(await browserApi.api('profiles'), before);
    report.checks.push('Idle Add-ons controls drain an unused browser preconnection, disable/re-enable signed Workbench, hide/restore its entry and preserve original profiles and runs');
  }
  if (args.includes('--integration') || packagedIntegration) {
    assert.ok(actual || report.packagedIntegrationProof, 'Integration connects to installed or explicitly verified packaged desktop services, not substitute servers');
    report.integration = {};
    const specs = [
      ['api', 'scripts/qualify-installed-pair.mjs', ['--extended', '--catalog-removal', '--data-root', data], join(root, packagedIntegration ? 'test-results/desktop-followup/packaged-api-pair.json' : 'test-results/native-engine/installed-pair-qualification.json')],
      ['proxy', 'scripts/qualify-desktop-proxies.mjs', ['--data-root', data], join(root, packagedIntegration ? 'test-results/proxy-inventory/packaged-pair.json' : 'test-results/proxy-inventory/installed-pair.json')],
      ['identity', 'scripts/qualify-installed-identity.mjs', ['--data-root', data, '--kernel-sha', option('--kernel-sha'), '--output', join(output, 'identity.json')], join(output, 'identity.json')],
    ];
    assert.ok(/^[a-f0-9]{64}$/.test(option('--kernel-sha') || ''), 'Provide the qualified --kernel-sha');
    for (const [name, script, argv, receipt] of specs) {
      if (name !== 'identity') await copyFile(receipt, join(output, 'prior-' + name + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      report.integration[name] = await qualify(process.execPath, [script, ...argv, ...(packagedIntegration ? ['--packaged'] : [])], name, receipt);
      if (name !== 'identity') await copyFile(receipt, join(output, name === 'api' ? 'api-pair.json' : name + '.json'));
    }
    report.integration.python = await qualify(option('--python') || 'python3', ['scripts/qualify-installed-python.py', '--data-root', data, '--output', join(output, 'python.json')], 'python', join(output, 'python.json'));
    if (process.platform === 'linux') {
      const { VesperBrowserClient } = await import('../packages/vesper-browser/dist/client.js');
      const client = new VesperBrowserClient({ url: browserApi.origin, tokenFile: join(data, 'browser/admin-token') });
      const profile = await client.create({ name: 'Owned installed sandbox qualification', engine: 'vesper' }); let attached;
      try {
        await client.start(profile.id); attached = await chromium.connectOverCDP(await client.connectionUrl(profile.id));
        const tab = await attached.contexts()[0].newPage(); await tab.goto('chrome://sandbox'); const status = await tab.locator('body').innerText();
        assert.match(status, /PID namespaces\s+Yes/i); assert.match(status, /Network namespaces\s+Yes/i); assert.match(status, /Seccomp-BPF sandbox\s+Yes/i);
        report.sandboxStatus = status; report.sandboxVerified = true;
      } finally { await attached?.close(); await client.stop(profile.id); await client.trash(profile.id); }
      report.checks.push('Installed Linux native profile still reports PID/network namespaces and seccomp-BPF enabled');
    }
    const profilesAfter = await browserApi.api('profiles'), runsAfter = await workbenchApi.api('runs');
    assert.deepEqual(profilesAfter.filter(p => before.some(original => original.id === p.id)), before);
    assert.deepEqual(runsAfter.filter(r => runsBefore.some(original => original.id === r.id)), runsBefore);
    report.checks.push((actual ? 'Installed' : 'Owned packaged') + ' API, proxy, native identity and Python checks pass at matching versions; original profiles and historical runs are preserved');
  }
  if (args.includes('--restart')) {
    const preservedProfiles = await browserApi.api('profiles'), preservedRuns = await workbenchApi.api('runs');
    assert.ok(preservedProfiles.every(p => p.state !== 'running' && !p.lease)); assert.ok(preservedRuns.every(r => !busy.has(r.state) && !r.cleanupRequired)); assert.ok((await workbenchApi.api('schedules')).every(s => !s.enabled));
    const spare = createConnection({ host: '127.0.0.1', port: Number(new URL(workbenchApi.origin).port) });
    await new Promise((done, reject) => { spare.once('connect', done); spare.once('error', reject); }); const quitAt = Date.now();
    try { await quit(); } finally { spare.destroy(); }
    report.restartQuitMilliseconds = Date.now() - quitAt; app = await _electron.launch({ executablePath: executable, env, timeout: 120000 });
    const restarted = await app.firstWindow(); await restarted.locator('#workspace:not([hidden])').waitFor({ timeout: 120000 });
    browserApi = await service('browser'); workbenchApi = await service('workbench');
    assert.deepEqual(await browserApi.api('profiles'), preservedProfiles); assert.deepEqual(await workbenchApi.api('runs'), preservedRuns);
    if (!standalone) assert.equal(await restarted.locator('#workbench-view').isVisible(), true);
    report.normalRestartPassed = true; report.checks.push('Normal Quit and restart retain matching installed versions, Workbench availability and every original/qualification profile and run');
  }
} catch (error) { report.state = 'failed'; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
finally {
  await web?.close().catch(() => {});
  if (dispatchedBrowser) { try { const session = await dispatchedBrowser.newBrowserCDPSession(); await session.send('Browser.close'); } catch {} }
  if (app) {
    try {
      if (args.includes('--controls') && !standalone && workbenchApi) {
        try { await workbenchApi.api('capabilities'); }
        catch { await app.evaluate(() => window.vesperDesktop.setWorkbenchEnabled(true)); workbenchApi = await service('workbench'); }
      }
      const profiles = await browserApi?.api('profiles'), runs = await workbenchApi?.api('runs');
      active = !!profiles?.some(p => p.state === 'running' || p.lease) || !!runs?.some(r => busy.has(r.state) || r.cleanupRequired);
      if (!active) { await quit(); report.normalQuit = true; }
      else { report.cleanupPending = 'New activity appeared; leave this application and its profiles running.'; }
    } catch (error) { report.errors.push('Normal Quit: ' + error.message); report.state = 'failed'; process.exitCode = 1; }
  }
  report.completedAt = new Date().toISOString(); await writeFile(join(output, 'ui.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ state: report.state, versions, checks: report.checks.length, errors: report.errors, output, dataRoot: data }));
}
