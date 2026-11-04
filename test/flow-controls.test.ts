import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileFlow,predicateKey,runFlow,FlowExecutionError,FlowActionError,type FlowPack,type FlowManifest,type FlowContext,type FlowSnapshot,type FlowDriver,type CompiledFlow} from '../src/flows/index.js';

function definition() {
  const recoverable={requires:['page'],onError:'review',onTimeout:'review',onUncertain:'review',recoveryByState:{page:'review'}};
  const pack:FlowPack={schemaVersion:1,id:'owned-control-proof',title:'Owned control proof',version:'1.0.0',registry:{schemaVersion:1,id:'owned-control-states',version:'1.0.0',originRefs:['owned'],targets:{button:{selector:'#owned-button',frame:'main',cardinality:'one'}},states:{page:{title:'Owned page',actionable:true,require:[{op:'urlEquals',originRef:'owned',pathname:'/owned'}],forbid:[],support:[],minEvidenceScore:0}},policy:{sampleIntervalMs:50,observationTimeoutMs:1000,maxObservationAgeMs:1000,stableSamples:1,stableForMs:0,blankGraceMs:0,unknownTimeoutMs:1000,overlap:'abstain-unless-refinement'}},inputSchema:{type:'object',properties:{},additionalProperties:false},start:{originRef:'owned',pathname:'/owned'},limits:{maxSteps:100,maxTotalMs:10000,maxStateVisits:20,maxInputRequests:5,maxReconciliations:0},entryByState:{page:'repeat'},choices:{},steps:{repeat:{...recoverable,kind:'repeat',count:3,body:'effect',next:{page:'finish'}},effect:{...recoverable,kind:'action',do:{op:'click',target:'button',effect:'mutation'},retry:{mode:'never',maxAttempts:1},postcondition:{states:['page'],require:[],timeoutMs:1000},next:{page:'repeat'}},finish:{kind:'complete',requires:['page'],mode:'save'},review:{kind:'review',requires:['page'],title:'Review',reasonCode:'owned-review',timeoutMs:1000,recoveryByState:{page:'finish'}}},onUnexpected:'pause-for-review',onUnexpectedStep:'review',execution:{profilePolicyId:'owned-profile',proxyPolicyId:'local-direct'},identityPolicy:'anonymous',evidence:{mode:'structured-redacted',screenshots:'off',retentionDays:7}};
  const manifest:FlowManifest={origins:{owned:'http://127.0.0.1:3210'},profilePolicyIds:['owned-profile'],proxyPolicyIds:['local-direct'],identityPolicy:'anonymous'};
  return {pack,manifest};
}
function harness(compiled:CompiledFlow) {
  let saved:FlowSnapshot|null=null,time=1000,state='page',effects=0;
  const snapshots:FlowSnapshot[]=[];
  const driver:FlowDriver={async observe(){return{id:String(time),sequence:time,documentEpoch:'owned-page',observedAt:time,completedAt:time,originRef:'owned',pathname:'/owned',complete:true,blank:false,supported:true,evidence:Object.fromEntries(compiled.predicates.map(p=>[predicateKey(p),compiled.pack.registry.states[state]!.require.some(r=>predicateKey(r)===predicateKey(p))])),digest:state};},async navigate(){},async fill(){throw Error('Unexpected fill');},async click(_target,guard){await guard();assert.equal(saved?.pending?.phase,'dispatched');effects++;},async scrape(){throw Error('Unexpected scrape');},async choices(){return [];},async choose(){throw Error('Unexpected choose');}};
  const context:FlowContext={runId:'owned-control-run',inputs:{},driver,journal:{async load(){return saved;},async save(snapshot){saved=structuredClone(snapshot);snapshots.push(structuredClone(snapshot));}},async requestInput(){throw Error('Unexpected review');},now:()=>time,sleep:async ms=>{time+=Math.max(1,ms);}};
  return {context,snapshots,effects:()=>effects,state:(value:string)=>state=value,saved:()=>saved,setSaved:(snapshot:FlowSnapshot)=>saved=structuredClone(snapshot)};
}

test('counted loop executes exactly three owned effects and persists admission before dispatch',async()=>{
  const {pack,manifest}=definition(),compiled=compileFlow(pack,manifest),h=harness(compiled);
  const result=await runFlow(compiled,h.context);assert.equal(result.status,'completed');assert.equal(h.effects(),3);
  const admissions=h.snapshots.filter(s=>s.lastEvent?.type==='repeat-entered');assert.deepEqual(admissions.map(s=>s.repeatCounts?.repeat),[1,2,3]);assert.ok(admissions.every(s=>s.stepId==='effect'&&s.lastEvent?.stepId==='repeat'&&!s.pending));assert.deepEqual(result.snapshot.repeatCounts,{});
});
test('nested counted loops reset the inner counter on each completed outer iteration',async()=>{
  const {pack,manifest}=definition(),outer=pack.steps.repeat!;assert.equal(outer.kind,'repeat');if(outer.kind!=='repeat')return;outer.count=2;outer.body='inner';
  pack.steps.inner={...structuredClone(outer),count:3,body:'effect',next:{page:'repeat'}};
  const effect=pack.steps.effect!;assert.equal(effect.kind,'action');if(effect.kind!=='action')return;effect.next.page='inner';
  const compiled=compileFlow(pack,manifest),h=harness(compiled);await runFlow(compiled,h.context);assert.equal(h.effects(),6);assert.deepEqual(h.snapshots.filter(s=>s.lastEvent?.type==='repeat-entered'&&s.lastEvent.stepId==='inner').map(s=>s.repeatCounts?.inner),[1,2,3,1,2,3]);
});
test('a durable body admission survives loss of the writer without starting the loop again',async()=>{
  const {pack,manifest}=definition(),compiled=compileFlow(pack,manifest),h=harness(compiled),save=h.context.journal.save;let dead=false;
  h.context.journal.save=async snapshot=>{if(dead)throw Error('Writer unavailable');await save(snapshot);if(snapshot.lastEvent?.type==='repeat-entered'){dead=true;throw Error('Writer lost after commit');}};
  await assert.rejects(runFlow(compiled,h.context),FlowExecutionError);assert.equal(h.effects(),0);assert.equal(h.saved()?.repeatCounts?.repeat,1);assert.equal(h.saved()?.stepId,'effect');
  h.context.journal.save=save;h.context.resume=true;await runFlow(compiled,h.context);assert.equal(h.effects(),3);
});
test('handoff after an observed action resumes the remaining iterations without repeating it',async()=>{
  const {pack,manifest}=definition(),compiled=compileFlow(pack,manifest),h=harness(compiled);h.context.afterAction=async()=> 'handoff';const first=await runFlow(compiled,h.context);assert.equal(first.status,'handoff');assert.equal(h.effects(),1);assert.equal(first.snapshot.repeatCounts?.repeat,1);
  delete h.context.afterAction;h.context.resume=true;await runFlow(compiled,h.context);assert.equal(h.effects(),3);
});
test('branch selects the matching recognized page rather than dispatching an action',async()=>{
  for(const state of ['page','alternate']){const {pack,manifest}=definition();pack.registry.states.alternate={...structuredClone(pack.registry.states.page!),title:'Alternate',require:[{op:'urlEquals',originRef:'owned',pathname:'/alternate'}]};pack.steps.repeat={kind:'branch',requires:['page','alternate'],next:{page:'effect',alternate:'finish'},onError:'review',onTimeout:'review',onUncertain:'review',recoveryByState:{page:'review',alternate:'review'}};pack.entryByState={page:'repeat',alternate:'repeat'};pack.steps.finish!.requires.push('alternate');pack.steps.review!.requires.push('alternate');const effect=pack.steps.effect!;if(effect.kind==='action')effect.next.page='finish';
   const compiled=compileFlow(pack,manifest),h=harness(compiled);h.state(state);await runFlow(compiled,h.context);assert.equal(h.effects(),state==='page'?1:0);assert.ok(h.snapshots.some(s=>s.lastEvent?.type==='branch-selected'&&s.lastEvent.stateId===state));}
});
test('compiler rejects incomplete branches, invalid repeat budgets and bodies bypassing their controller',()=>{
  for(const change of [(p:FlowPack)=>{const r=p.steps.repeat!;if(r.kind==='repeat')r.count=20;},(p:FlowPack)=>{const e=p.steps.effect!;if(e.kind==='action')e.next.page='finish';},(p:FlowPack)=>{const r=p.steps.repeat!;if(r.kind==='repeat')r.body='repeat';}]){const {pack,manifest}=definition();change(pack);assert.throws(()=>compileFlow(pack,manifest));}
  const {pack,manifest}=definition();pack.steps.repeat={kind:'branch',requires:['page'],next:{},onError:'review',onTimeout:'review',onUncertain:'review',recoveryByState:{}};assert.throws(()=>compileFlow(pack,manifest),/Invalid flow pack/);
});
test('invalid persisted repeat counters fail before browser effects',async()=>{
  const {pack,manifest}=definition(),compiled=compileFlow(pack,manifest),h=harness(compiled);h.context.afterAction=async()=> 'handoff';await runFlow(compiled,h.context);const original=h.saved()!;
  for(const invalid of [{repeat:4},{repeat:-1},{repeat:0.5},{missing:1},null]){h.setSaved({...original,repeatCounts:invalid as never});h.context.resume=true;await assert.rejects(runFlow(compiled,h.context),/invalid-repeat-progress/);assert.equal(h.effects(),1);}
});
test('a valid loop named constructor uses own durable counters and remains bounded',async()=>{
  const {pack,manifest}=definition();pack.steps.constructor=pack.steps.repeat!;delete pack.steps.repeat;pack.entryByState.page='constructor';const effect=pack.steps.effect!;if(effect.kind==='action')effect.next.page='constructor';const compiled=compileFlow(pack,manifest),h=harness(compiled);await runFlow(compiled,h.context);assert.equal(h.effects(),3);
});
test('resume after the durable loop exit does not restart a completed body',async()=>{
  const {pack,manifest}=definition(),compiled=compileFlow(pack,manifest),h=harness(compiled),save=h.context.journal.save;let dead=false;
  h.context.journal.save=async snapshot=>{if(dead)throw Error('Writer lost');await save(snapshot);if(snapshot.lastEvent?.type==='repeat-completed'){dead=true;throw Error('Writer lost after loop exit');}};
  await assert.rejects(runFlow(compiled,h.context),FlowExecutionError);assert.equal(h.effects(),3);assert.equal(h.saved()?.stepId,'finish');
  h.context.journal.save=save;h.context.resume=true;await runFlow(compiled,h.context);assert.equal(h.effects(),3);
});
test('an uncertain effect inside a repeat remains fenced and cannot become another iteration',async()=>{
  const {pack,manifest}=definition(),compiled=compileFlow(pack,manifest),h=harness(compiled),click=h.context.driver.click;
  h.context.driver.click=async(...args)=>{await click(...args);throw new FlowActionError('Owned uncertain effect',true);};
  await assert.rejects(runFlow(compiled,h.context),FlowExecutionError);assert.equal(h.effects(),1);assert.equal(h.saved()?.pending?.phase,'uncertain');
  h.context.resume=true;await assert.rejects(runFlow(compiled,h.context),FlowExecutionError);assert.equal(h.effects(),1);
});
test('a counted repeat cannot immediately reset its own body through an exit route',()=>{
  for(const exit of ['repeat','effect']){const {pack,manifest}=definition();const step=pack.steps.repeat!;if(step.kind==='repeat')step.next.page=exit;assert.throws(()=>compileFlow(pack,manifest),/repeat exit must leave/);}
});
test('a loop body action named constructor has an independent finite attempt budget',async()=>{
  const {pack,manifest}=definition();pack.steps.constructor=pack.steps.effect!;delete pack.steps.effect;const repeat=pack.steps.repeat!;if(repeat.kind==='repeat')repeat.body='constructor';const compiled=compileFlow(pack,manifest),h=harness(compiled);await runFlow(compiled,h.context);assert.equal(h.effects(),3);assert.ok(h.snapshots.filter(s=>s.lastEvent?.type==='action-intent').every(s=>s.pending?.attempt===1));
});
