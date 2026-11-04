// Owned notification-only service for process-crash and UI qualification.
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from '../../src/server.ts';
import {loadConfig} from '../../src/config.ts';
import {durableWrite} from '../../src/managed/storage.ts';
const directory=process.argv[2];
if(!directory)throw Error('An owned fixture directory is required');
const token='owned-event-replay-fixture-token-00001';
class OwnedRuntime extends EventEmitter{
  submissions=0;
  run={id:'owned-event-run',automationId:'owned-replay',state:'running',createdAt:'2026-11-04T00:00:00.000Z',updatedAt:'2026-11-04T00:00:00.000Z',logs:[],timings:{},step:0};
  listAutomations(){return[{id:'owned-replay',title:'Owned replay fixture'}];}
  list(){return[this.run];}get(){return this.run;}
  submit(){this.submissions++;throw Error('This fixture never admits browser actions');}
  cancel(){}pause(){}resume(){}retryExport(){}done(){}provideInput(){}
  async screenshot(){return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');}
}
const runtime=new OwnedRuntime();
process.send?.({type:'stage',name:'loading-canonical'});
try{runtime.run=JSON.parse(await readFile(join(directory,'canonical-run.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const config=await loadConfig({WORKBENCH_DATA_DIR:directory,EXPORT_DIR:directory,WORKBENCH_TOKEN:token});
process.send?.({type:'stage',name:'creating-server'});
const app=await createServer(config,runtime,{publicInventory:()=>[]},{kind:'owned-fixture',ready:async()=>{}});
const streams=new Set(),cursors=[];
app.server.on('request',(request,response)=>{
 if(['/api/events','/api/v1/events'].includes(request.url?.split('?')[0])){
  streams.add(response);response.once('close',()=>streams.delete(response));
  cursors.push(request.headers['last-event-id']??null);if(cursors.length>32)cursors.shift();
 }
});
process.send?.({type:'stage',name:'listening'});
const port=Number(process.argv[3]??0);if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('Invalid owned fixture port');
const origin=await app.listen({host:'127.0.0.1',port});
process.send?.({type:'ready',origin,pid:process.pid});
process.on('message',async message=>{
 try{
  if(message.type==='change'){
   runtime.run={...runtime.run,state:message.state,step:runtime.run.step+1,updatedAt:new Date().toISOString()};
   await durableWrite(join(directory,'canonical-run.json'),JSON.stringify(runtime.run));
   runtime.emit('run',runtime.run);process.send?.({type:'changed',submissions:runtime.submissions});
  }else if(message.type==='drop-streams'){
   for(const response of streams)response.destroy();process.send?.({type:'dropped',submissions:runtime.submissions});
  }else if(message.type==='stats'){
   process.send?.({type:'stats',submissions:runtime.submissions,cursors});
  }else if(message.type==='close'){
   await app.close();process.send?.({type:'closed',submissions:runtime.submissions});process.disconnect?.();
  }
 }catch(error){process.send?.({type:'failure',message:error.message});}
});
process.on('disconnect',()=>{void app.close();});
