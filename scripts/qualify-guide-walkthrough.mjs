import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,realpath} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {VesperBrowserClient} from '../packages/vesper-browser/dist/index.js';
import {seedFiles} from '../desktop/seed-files.mjs';

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
assert.ok(option('--browser-executable')&&option('--addon-directory')&&option('--output'),'Provide installed Browser, installed add-on directory and private output');
const executable=await realpath(resolve(option('--browser-executable'))),addon=await realpath(resolve(option('--addon-directory'))),output=resolve(option('--output'));
const resources=join(dirname(executable),'resources'),payload=join(resources,'payload'),workbenchPayload=join(addon,'payload');
const fixtureRoot=resolve(option('--fixture-root')??'.workbench/guide-fixtures');await mkdir(fixtureRoot,{recursive:true});
const data=await mkdtemp(join(fixtureRoot,'vesper-guide-walkthrough-'));await mkdir(dirname(output),{recursive:true});
const report={at:new Date().toISOString(),state:'running',platform:process.platform,scope:'Installed service payloads in a newly owned isolated store; API guide and same-machine profile transport, not desktop UI or newly packaged handbook acceptance',dataRoot:data,checks:[],errors:[],versions:{}};
const children=[];let browserApi,workbenchApi,client,runId,restoredId,finished=false;
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function service(kind,servicePayload,entry,env={}){
 const directory=join(data,kind);await mkdir(directory,{recursive:true});
 const variables={...process.env,ELECTRON_RUN_AS_NODE:'1',VESPER_DESKTOP:'true',...env};
 for(const name of ['NODE_OPTIONS','VESPER_BUNDLED_KERNEL_MANIFEST','WORKBENCH_TOKEN','DATABASE_URL'])delete variables[name];
 const child=fork(entry,[kind,servicePayload,directory],{execPath:executable,execArgv:[],windowsHide:true,env:variables,stdio:['ignore','pipe','pipe','ipc']});
 const owned={kind,child,log:'',closed:new Promise(done=>child.once('exit',done))};children.push(owned);child.stdout.on('data',bytes=>owned.log+=bytes);child.stderr.on('data',bytes=>owned.log+=bytes);
 await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error(kind+' startup timed out')),120000);const exited=code=>{clearTimeout(timer);reject(Error(kind+' exited before readiness: '+code));};child.once('exit',exited);child.once('error',error=>{clearTimeout(timer);reject(error);});child.on('message',message=>{if(message?.type==='ready'){clearTimeout(timer);child.removeListener('exit',exited);done();}});});
 const record=JSON.parse(await readFile(join(directory,'service.json'),'utf8')),token=(await readFile(join(directory,'admin-token'),'utf8')).trim(),origin='http://127.0.0.1:'+record.port;
 const request=async(path,method='GET',body)=>{const response=await fetch(origin+'/api/v1/'+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});assert.ok(response.ok,kind+' '+path+' HTTP '+response.status);return response.headers.get('content-type')?.includes('json')?response.json():Buffer.from(await response.arrayBuffer());};
 report.versions[kind]=(await request('capabilities')).version;return {request,origin,tokenFile:join(directory,'admin-token')};
}
async function start(){
 const engine=option('--browser-runtime')?await realpath(resolve(option('--browser-runtime'))):join(resources,'chromium',process.platform==='win32'?'chrome.exe':'chrome');
 report.browserRuntime=engine;
 browserApi=await service('browser',payload,join(resources,'runtime/service.mjs'),{VESPER_BROWSER_EXECUTABLE:engine,VESPER_BROWSER_HEADLESS:'true'});
 const state=join(data,'workbench');await mkdir(state,{recursive:true});await seedFiles(workbenchPayload,state);
 workbenchApi=await service('workbench',workbenchPayload,join(addon,'runtime/service.mjs'),{BROWSER_BACKEND:'local',HOST:'127.0.0.1',PORT:'0',MAX_CONCURRENCY:'1',VESPER_BROWSER_URL:browserApi.origin,VESPER_BROWSER_TOKEN_FILE:browserApi.tokenFile,WORKBENCH_DATA_DIR:state,EXPORT_DIR:join(state,'exports'),AUTOMATIONS_DIR:join(state,'automations'),FLOWS_DIR:join(state,'flows'),PROXY_INVENTORY_FILE:join(state,'proxy-inventory.json'),PUBLIC_ORIGIN:'',COOKIE_SECURE:'',KAMELEO_VNC_URL:'',VESPER_LOCAL_COORDINATOR:'true',VESPER_SDK_MODULE:pathToFileURL(join(workbenchPayload,'dist/index.js')).href});
 client=new VesperBrowserClient({url:browserApi.origin,tokenFile:browserApi.tokenFile});
}
async function stop(){for(const owned of [...children].reverse()){if(owned.child.exitCode!==null)continue;assert.ok(owned.child.connected);owned.child.send('shutdown');await Promise.race([owned.closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error(owned.kind+' normal shutdown timed out')),60000);timer.unref();})]);}}
async function waitRun(id,state){const deadline=Date.now()+120000;while(Date.now()<deadline){const run=await workbenchApi.request('runs/'+id);if(run.state===state)return run;assert.ok(!['failed','export_failed','cancelled','interrupted'].includes(run.state),'Run failed: '+run.state);await pause(150);}throw Error('Run did not reach '+state);}
const marker='owned-'+randomUUID();let fixtureRequests=0;
const fixture=createServer((_request,response)=>{fixtureRequests++;if(fixtureRequests===1)response.setHeader('Set-Cookie','vesper_guide_marker='+marker+'; Path=/; Max-Age=3600; SameSite=Lax');response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Vesper guide-owned fixture</title><h1>Owned archive walkthrough</h1>');});
try{
 await new Promise(done=>fixture.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+fixture.address().port;
 await start();assert.deepEqual(await browserApi.request('profiles'),[]);assert.deepEqual(await workbenchApi.request('runs'),[]);report.checks.push('Installed services start with an empty owned store; no operator profile or credential store is opened');
 const automations=await workbenchApi.request('automations');assert.ok(automations.some(item=>item.id==='inspect'));report.checks.push('Discover the real bundled Open and inspect a browser automation by its inspect ID');
 const run=await workbenchApi.request('runs','POST',{automationId:'inspect',inputs:{url,engine:'chromium'},preset:'fast'});runId=run.id;
 const running=await waitRun(runId,'running');await client.claimProfile(running.profileId,runId);
 let cookies;for(let i=0;i<100;i++){cookies=await client.cookies(running.profileId);if(cookies.some(cookie=>cookie.name==='vesper_guide_marker'&&cookie.value===marker))break;await pause(100);}
 assert.ok(cookies.some(cookie=>cookie.name==='vesper_guide_marker'&&cookie.value===marker));report.checks.push('The admitted Browser-owned run visits the owned fixture and stores its one-time synthetic cookie');
 let readyToFinish=false;for(let i=0;i<200;i++){if((await workbenchApi.request('runs/'+runId)).waitingForFinish===true){readyToFinish=true;break;}await pause(100);}
 assert.equal(readyToFinish,true,'Wait for the real Ready to finish state before sending Finish + save');
 await workbenchApi.request('runs/'+runId+'/finish','POST',{});const saved=await waitRun(runId,'saved');finished=true;
 const archive=await workbenchApi.request('runs/'+runId+'/artifact');assert.equal(hash(archive),saved.artifact.sha256);assert.ok(archive.length>0);const archiveFile=join(data,'owned-saved-profile.tgz');await writeFile(archiveFile,archive,{mode:0o600});report.archive={sha256:hash(archive),bytes:archive.length};report.checks.push('Finish + save stops the Browser and produces a non-empty artifact whose bytes match the recorded SHA-256');
 let restored;
 if(option('--guide-example')){
   const source=await readFile(resolve(option('--guide-example')),'utf8');
   const guides=JSON.parse(await readFile(new URL('../packages/vesper-browser/public/docs/guides.json',import.meta.url),'utf8'));
   const expected=guides.find(g=>g.id==='archives').sections.find(s=>s.title==='Restore with the TypeScript client').code;
   assert.equal(source.trim(),expected.trim(),'Execute the exact reviewed guide snippet');
   const script=join(data,'restore.mjs');await writeFile(script,source);
   const result=await promisify(execFile)(process.execPath,[script],{cwd:data,windowsHide:true,timeout:60000,env:{...process.env,VESPER_BROWSER_ORIGIN:browserApi.origin,VESPER_BROWSER_TOKEN_FILE:browserApi.tokenFile}});
   restored={id:result.stdout.trim()};assert.match(restored.id,/^[a-f0-9-]{36}$/);report.checks.push('The exact SDK recipe copied from the reviewed handbook imports the verified archive successfully');
 }else restored=await client.importProfile(archiveFile);
 restoredId=restored.id;assert.notEqual(restored.id,saved.profileId);await client.start(restoredId);
 const restoredCookies=await client.cookies(restoredId);assert.ok(restoredCookies.some(cookie=>cookie.name==='vesper_guide_marker'&&cookie.value===marker));await client.stop(restoredId);report.checks.push('Import the saved archive as an independent profile and recover the original synthetic cookie without the fixture setting it again');
 assert.ok((await client.listProfiles()).every(profile=>profile.state!=='running'&&!profile.lease));
 await stop();await start();assert.equal((await workbenchApi.request('runs/'+runId)).state,'saved');assert.ok((await client.listProfiles()).some(profile=>profile.id===restoredId));report.checks.push('Normal service shutdown and restart preserve the saved run and imported profile');
 await client.start(restoredId);assert.ok((await client.cookies(restoredId)).some(cookie=>cookie.name==='vesper_guide_marker'&&cookie.value===marker));await client.stop(restoredId);report.checks.push('The restored same-machine cookie persists after a second normal service restart');
 report.state='passed';
}catch(error){report.state='failed';report.errors.push(error.stack??String(error));process.exitCode=1;}
finally{
 try{if(restoredId)await client?.stop(restoredId);if(runId&&!finished)await workbenchApi?.request('runs/'+runId+'/cancel','POST',{});await stop();}catch(error){report.state='failed';report.errors.push('Owned cleanup: '+error.message);process.exitCode=1;}
 for(let i=0;i<children.length;i++)await writeFile(join(data,children[i].kind+'-'+i+'.log'),children[i].log,{mode:0o600});
 await new Promise(done=>fixture.close(done));await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({state:report.state,versions:report.versions,checks:report.checks.length,archive:report.archive,errors:report.errors}));
}
