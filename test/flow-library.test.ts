import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FlowLibrary } from '../src/flow-library.js';
import { LocalDatabase } from '../src/coordinator/local-database.js';
import { DurableCoordinator } from '../src/coordinator/index.js';
import { compileFlow } from '../src/flows/compiler.js';
import { randomUUID } from 'node:crypto';
test('flow drafts validate, serialize optimistic edits and publish exact revisions',async()=>{const directory=await mkdtemp(join(tmpdir(),'vesper-flow-library-'));const pack=JSON.parse(await readFile('flows/owned-site.flow.json','utf8')),manifest=JSON.parse(await readFile('flows/owned-site.manifest.json','utf8'));const published:any[]=[];let library=new FlowLibrary(directory,{installFlow:async(p,m)=>{published.push({p,m});return {id:p.id};}});try{const first=await library.save(pack,manifest,0);assert.equal(first.revision,1);const results=await Promise.allSettled([library.save({...pack,title:'First edit'},manifest,1),library.save({...pack,title:'Second edit'},manifest,1)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);await assert.rejects(library.publish(pack.id,1),/changed/);await library.publish(pack.id,2);assert.equal(published.length,1);assert.equal(published[0].p.title,'First edit');library=new FlowLibrary(directory,{});assert.equal((await library.list()).drafts[0].revision,2);await assert.rejects(library.save({...pack,id:'../bad'},manifest,0),/lowercase flow ID/);await assert.rejects(library.save({...pack,steps:{}},manifest,2),/Invalid flow pack/);}finally{await rm(directory,{recursive:true,force:true});}});

test('editing and republishing a visually authored flow admits both immutable versions in the real coordinator',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'vesper-flow-republication-')),db=await LocalDatabase.open(join(directory,'db')),coordinator=new DurableCoordinator({db});
 const pack=JSON.parse(await readFile('flows/owned-site.flow.json','utf8')),manifest=JSON.parse(await readFile('flows/owned-site.manifest.json','utf8')),config={tenantId:randomUUID(),siteId:randomUUID(),quotaDomainId:randomUUID(),vendorTeamKey:randomUUID(),nodeId:randomUUID(),nodeIncarnationId:randomUUID(),engineProcessKey:randomUUID(),origin:Object.values(manifest.origins)[0] as string,totalBrowserBudget:2,nodeMaxBrowsers:2};
 let installed:any;
 const library=new FlowLibrary(join(directory,'library'),{flowDefinitions:()=>installed?[installed]:[],installFlow:async(p,m)=>{installed=compileFlow(p,m);}});
 const admit=()=>coordinator.submitFlow({tenantId:config.tenantId,siteId:config.siteId,quotaDomainId:config.quotaDomainId,nodeId:config.nodeId,pack:{key:installed.pack.id,version:installed.pack.version,hash:installed.hash,artifactKey:installed.hash+'.json'},requestId:randomUUID(),deadlineAt:new Date(Date.now()+60000).toISOString()});
 try{await coordinator.migrate();await coordinator.ensureWorkspace(config);const first=await library.save(pack,manifest,0);await library.publish(pack.id,first.revision);const oldRun=await admit();const edited=await library.save({...first.pack,title:'Changed after an admitted run'},manifest,first.revision);assert.notEqual(edited.pack.version,first.pack.version);assert.equal(pack.version,first.pack.version,'Saving must not rewrite the caller input');assert.equal(compileFlow(edited.pack,manifest).hash,edited.hash);await library.publish(pack.id,edited.revision);const newRun=await admit();assert.notEqual(oldRun.id,newRun.id);const oldData=await coordinator.getFlow(config.tenantId,oldRun.id);assert.equal(oldData.pack.hash,oldRun.pack.hash);assert.notEqual(oldRun.pack.hash,newRun.pack.hash);}
 finally{await coordinator.close();await rm(directory,{recursive:true,force:true});}
});

test('unchanged and layout-only saves retain the version, while restart and undo cannot reuse a changed version',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'vesper-flow-version-floor-')),pack=JSON.parse(await readFile('flows/owned-site.flow.json','utf8')),manifest=JSON.parse(await readFile('flows/owned-site.manifest.json','utf8'));
 try{let library=new FlowLibrary(directory,{});const first=await library.save(pack,manifest,0),same=await library.save(first.pack,manifest,first.revision,{[Object.keys(pack.steps)[0]!]:{x:30,y:40}});assert.equal(same.pack.version,first.pack.version);assert.equal(same.hash,first.hash);const edited=await library.save({...same.pack,title:'Changed'},manifest,same.revision);assert.notEqual(edited.pack.version,first.pack.version);library=new FlowLibrary(directory,{});const undone=await library.save(first.pack,manifest,edited.revision);assert.notEqual(undone.pack.version,edited.pack.version);assert.notEqual(undone.pack.version,first.pack.version);const explicit=await library.save({...undone.pack,version:'99999999999999999999.0.0'},manifest,undone.revision);assert.equal(explicit.pack.version,'99999999999999999999.0.0');const patched=await library.save({...explicit.pack,title:'Changed again'},manifest,explicit.revision);assert.equal(patched.pack.version,'99999999999999999999.0.1');}
 finally{await rm(directory,{recursive:true,force:true});}
});
