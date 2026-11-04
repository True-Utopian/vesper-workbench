import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compileFlow } from './flows/compiler.js';
import { compareFlowVersions as compareVersions, nextFlowPatch as nextPatch } from './flows/versions.js';
import type { FlowPack, FlowManifest } from './flows/types.js';
import { durableWrite } from './managed/storage.js';
export interface FlowDocument { id: string; revision: number; pack: FlowPack; manifest: FlowManifest; hash: string; updatedAt: string; versionFloor?: string; layout?: Record<string,{x:number;y:number}> }
export interface FlowPublisher { flowDefinitions?(): Array<{ pack: FlowPack; manifest: FlowManifest; hash: string }>; installFlow?(pack: FlowPack, manifest: FlowManifest): Promise<unknown> }
const validId = (id: string) => { if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw Object.assign(new Error('Use a lowercase flow ID with letters, numbers and hyphens'), { statusCode: 400 }); return id; };
export class FlowLibrary {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private runtime: FlowPublisher) {}
  async list() {
    await mkdir(this.directory,{ recursive: true });
    const drafts = await Promise.all((await readdir(this.directory)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(this.directory,name),'utf8')) as FlowDocument));
    return { installed: this.runtime.flowDefinitions?.() ?? [], drafts };
  }
  save(pack: FlowPack, manifest: FlowManifest, expectedRevision: number, layout?: Record<string,{x:number;y:number}>) {
    const next = this.queue.catch(() => {}).then(async () => {
      const id = validId(pack.id), file = join(this.directory, `${id}.json`);
      // Keep the caller's draft immutable; every successful save returns the
      // exact version/hash the editor must use for publication.
      pack=structuredClone(pack);let compiled=compileFlow(pack,manifest);
      if(layout && (Object.keys(layout).length>1000 || Object.entries(layout).some(([key,position])=>!Object.hasOwn(pack.steps,key)||!position||Object.keys(position).some(key=>!['x','y'].includes(key))||!Number.isFinite(position.x)||!Number.isFinite(position.y)||position.x<0||position.y<0||position.x>10000||position.y>10000)))throw Object.assign(new Error('Invalid graph layout'),{statusCode:400});
      let prior: FlowDocument | undefined;
      try { prior = JSON.parse(await readFile(file,'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if ((prior?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('Flow changed. Reload the current draft before saving.'),{ statusCode: 409 });
      const published=this.runtime.flowDefinitions?.().find(value=>value.pack.id===id);
      const known=[prior,published].filter((value): value is NonNullable<typeof value>=>!!value);
      let floor=prior?.versionFloor??known[0]?.pack.version??pack.version;
      for(const version of [prior?.versionFloor,...known.map(value=>value.pack.version)])if(version&&compareVersions(version,floor)>0)floor=version;
      if(known.length&&!known.some(value=>value.hash===compiled.hash)&&compareVersions(pack.version,floor)<=0){
        pack.version=nextPatch(floor);compiled=compileFlow(pack,manifest);floor=pack.version;
      }
      if(compareVersions(pack.version,floor)>0)floor=pack.version;
      const savedLayout=layout??prior?.layout;
      const document: FlowDocument = { id, revision: expectedRevision + 1, pack, manifest, hash: compiled.hash, versionFloor:floor, updatedAt: new Date().toISOString(), ...(savedLayout ? {layout:savedLayout} : {}) };
      await durableWrite(file,JSON.stringify(document)); return document;
    }); this.queue = next.catch(() => {}); return next;
  }
  async publish(id: string, revision: number) {
    await this.queue;
    if (!this.runtime.installFlow) throw Object.assign(new Error('Enable the local coordinator to publish flows'),{ statusCode: 409 });
    const document = JSON.parse(await readFile(join(this.directory, `${validId(id)}.json`),'utf8')) as FlowDocument;
    if (document.revision !== revision) throw Object.assign(new Error('Flow changed. Reload before publishing.'),{ statusCode: 409 });
    const result = await this.runtime.installFlow(document.pack,document.manifest); return { ...document, published: true, result };
  }
}
