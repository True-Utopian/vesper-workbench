import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManagedRuntime } from '../src/managed/runtime.js';
import { LocalDatabase } from '../src/coordinator/local-database.js';
import { fixturePolicies } from '../src/fixture.js';
import { stableId } from '../src/managed/storage.js';
import { compileFlow } from '../src/flows/compiler.js';
import type { FlowPack, FlowManifest } from '../src/flows/types.js';

test('owned demo rebinding reserves a new immutable version, survives repeated restarts and preserves published edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-published-rebind-'));
  const pack: FlowPack = JSON.parse(await readFile('flows/owned-site.flow.json', 'utf8'));
  const manifest: FlowManifest = JSON.parse(await readFile('flows/owned-site.manifest.json', 'utf8'));
  pack.version = '1.0.0';
  const tenantId = randomUUID(), nodeId = randomUUID(), flowsDir = join(directory, 'flows');
  let runtime: ManagedRuntime | undefined;
  const open = async (origin: string) => {
    const database = await LocalDatabase.open(join(directory, 'db'));
    runtime = new ManagedRuntime({ databaseUrl: '', tenantId, nodeId, teamKey: 'owned-rebind-test',
      browserBudget: 1, engineUrl: 'http://127.0.0.1:1', dataDir: directory, flowsDir,
      localExportDir: join(directory, 'exports'), engineExportDir: join(directory, 'exports'),
      maxConcurrency: 1, runTimeoutMs: 60000, idleTimeoutMs: 30000,
      policies: fixturePolicies('owned-not-live', origin), fixtureOrigin: origin, database, engine: {} as any });
    await runtime.init();
    return runtime;
  };
  try {
    await mkdir(flowsDir);
    await writeFile(join(flowsDir, `${pack.id}.flow.json`), JSON.stringify(pack));
    await writeFile(join(flowsDir, `${pack.id}.manifest.json`), JSON.stringify(manifest));
    let current = await open('http://127.0.0.1:41001');
    const first = current.flowDefinitions()[0]!;
    assert.equal(first.pack.version, '1.0.1');
    const originalBytes = await readFile(join(directory, 'packs', `${first.hash}.json`));
    const edited = { ...first.pack, title: 'Published edit survives seed reload', version: '99999999999999999999.0.0' };
    await current.installFlow(edited, first.manifest);
    // Publication must reject a conflicting version before replacing the bundle/map.
    const bundle = await readFile(join(flowsDir, `${pack.id}.vflow.json`));
    await assert.rejects(current.installFlow({ ...edited, title: 'Conflicting bytes' }, first.manifest), { code: 'pack_version_conflict' });
    assert.deepEqual(await readFile(join(flowsDir, `${pack.id}.vflow.json`)), bundle);
    assert.equal(current.flowDefinitions()[0]!.pack.title, edited.title);
    const versionsBefore = await current.coordinator.packVersions(tenantId, pack.id);
    assert.equal(versionsBefore.length, 2);
    assert.equal((await current.coordinator.db.query('SELECT id FROM workbench_coordinator.flow_instances')).rows.length, 0);
    await current.close(); runtime = undefined;

    current = await open('http://127.0.0.1:41002');
    const rebound = current.flowDefinitions()[0]!;
    assert.equal(rebound.pack.version, '99999999999999999999.0.1');
    assert.equal(rebound.pack.title, edited.title);
    assert.equal(rebound.manifest.origins[pack.start.originRef], 'http://127.0.0.1:41002');
    assert.notEqual(rebound.hash, first.hash);
    assert.deepEqual(await readFile(join(directory, 'packs', `${first.hash}.json`)), originalBytes);
    const versions = await current.coordinator.packVersions(tenantId, pack.id);
    assert.equal(versions.length, 3);
    assert.equal(versions.find(v => v.version === first.pack.version)!.hash, first.hash);
    assert.equal(versions.find(v => v.version === rebound.pack.version)!.siteId, stableId(`site:${tenantId}:http://127.0.0.1:41002`));
    await current.close(); runtime = undefined;

    current = await open('http://127.0.0.1:41002');
    assert.equal(current.flowDefinitions()[0]!.hash, rebound.hash, 'Same origin restart is idempotent');
    assert.equal((await current.coordinator.packVersions(tenantId, pack.id)).length, 3);
    assert.equal(compileFlow(pack, manifest).pack.version, '1.0.0', 'Authored seed is unchanged');
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('stable external flows retain identity and reject a changed seed at a reserved version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-external-publish-'));
  const pack: FlowPack = JSON.parse(await readFile('flows/owned-site.flow.json', 'utf8'));
  const manifest: FlowManifest = JSON.parse(await readFile('flows/owned-site.manifest.json', 'utf8'));
  pack.version = '1.0.0';
  pack.execution.profilePolicyId = 'external-profile';
  manifest.profilePolicyIds = ['external-profile'];
  const tenantId = randomUUID(), nodeId = randomUUID();
  let runtime: ManagedRuntime | undefined;
  const open = async () => {
    runtime = new ManagedRuntime({ databaseUrl: '', tenantId, nodeId, teamKey: 'owned-external-test', browserBudget: 1,
      engineUrl: 'http://127.0.0.1:1', dataDir: directory, flowsDir: join(directory, 'flows'),
      localExportDir: join(directory, 'exports'), engineExportDir: join(directory, 'exports'),
      maxConcurrency: 1, runTimeoutMs: 60000, idleTimeoutMs: 30000,
      policies: { ...fixturePolicies('owned-not-live', 'https://owned.test'), profiles: { 'external-profile': () => ({}) } },
      database: await LocalDatabase.open(join(directory, 'db')), engine: {} as any });
    await runtime.init(); return runtime;
  };
  try {
    await mkdir(join(directory, 'flows'));
    const seedFile = join(directory, 'flows', `${pack.id}.flow.json`);
    await writeFile(seedFile, JSON.stringify(pack));
    await writeFile(join(directory, 'flows', `${pack.id}.manifest.json`), JSON.stringify(manifest));
    let current = await open();
    const hash = compileFlow(pack, manifest).hash;
    assert.equal(current.flowDefinitions()[0]!.hash, hash);
    assert.equal(current.flowDefinitions()[0]!.pack.version, '1.0.0');
    await current.installFlow(pack, manifest);
    assert.equal((await current.coordinator.packVersions(tenantId, pack.id)).length, 1);
    await assert.rejects(current.installFlow({ ...pack, title: 'Changed' }, manifest), { code: 'pack_version_conflict' });
    assert.equal(current.flowDefinitions()[0]!.hash, hash);
    await current.close(); runtime = undefined;
    current = await open();
    assert.equal(current.flowDefinitions()[0]!.hash, hash);
    assert.equal((await current.coordinator.packVersions(tenantId, pack.id)).length, 1);
    await current.close(); runtime = undefined;
    // Remove only the owned test's unchanged published bundle so its edited seed
    // is loaded, as on an external pack deployment. The immutable guard holds.
    await rm(join(directory, 'flows', `${pack.id}.vflow.json`));
    await writeFile(seedFile, JSON.stringify({ ...pack, title: 'Changed seed at same version' }));
    await assert.rejects(open(), { code: 'pack_version_conflict' });
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
