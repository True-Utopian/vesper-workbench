import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {compileFlow,type FlowPack,type FlowManifest} from '../src/flows/index.js';
import {insertFlowStep} from '../public/flow-controls.js';
import {extractionOperation,newExtractionOperation,valueChoices,authoredValue} from '../public/extraction-controls.js';

function fixture(){
 const pack:FlowPack=JSON.parse(readFileSync('flows/owned-site.flow.json','utf8'));
 const manifest:FlowManifest=JSON.parse(readFileSync('flows/owned-site.manifest.json','utf8'));
 const origin=pack.start.originRef;
 pack.identityPolicy='anonymous';manifest.identityPolicy='anonymous';
 pack.inputSchema={type:'object',additionalProperties:false,properties:{text:{type:'string'},quantity:{type:'integer'}},required:['text']};
 pack.registry.targets={source:{selector:'#source',frame:'main',cardinality:'one'},field:{selector:'#field',frame:'main',cardinality:'one'},items:{selector:'.item',frame:'main',cardinality:'many'}};
 pack.registry.states={page:{title:'Page',actionable:true,require:[{op:'urlEquals',originRef:origin,pathname:pack.start.pathname}],forbid:[],support:[],minEvidenceScore:0}};
 pack.entryByState={page:'fill'};pack.choices={};pack.onUnexpectedStep='review';
 pack.steps={
  fill:{kind:'action',requires:['page'],do:{op:'fill',target:'field',value:{source:'literal',value:''}},postcondition:{states:['page'],require:[],timeoutMs:1000},next:{page:'finish'},retry:{mode:'never',maxAttempts:1},onError:'review',onTimeout:'review',onUncertain:'review',recoveryByState:{page:'finish'}},
  finish:{kind:'complete',requires:['page'],mode:'save'},
  review:{kind:'review',requires:['page'],title:'Review',reasonCode:'review',timeoutMs:300000,recoveryByState:{page:'finish'}}
 };
 return {pack,manifest};
}

test('visually inserted extraction feeds a consumer only after a successful bounded read',()=>{
 const {pack,manifest}=fixture();const added=insertFlowStep(pack,'extraction',()=> 'read-first');
 assert.equal(added.id,'read-first');assert.equal(pack.entryByState.page,'read-first');
 const read=pack.steps['read-first']!;assert.equal(read.kind,'action');if(read.kind!=='action')return;
 assert.equal(read.recoveryByState.page,'review');assert.equal(read.next.page,'fill');
 const fill=pack.steps.fill!;if(fill.kind!=='action'||fill.do.op!=='fill')throw Error('Bad fixture');
 fill.do.value=authoredValue(pack,'fill','capture','result');compileFlow(pack,manifest);
 // A recovery edge bypassing the read cannot satisfy the capture's assignment.
 read.recoveryByState.page='fill';assert.throws(()=>compileFlow(pack,manifest),/not definitely assigned/);
});

test('text and allowlisted attribute forms round-trip in the maintained flow dialect',()=>{
 const {pack,manifest}=fixture();insertFlowStep(pack,'extraction',()=> 'read-first');
 const step=pack.steps['read-first']!;if(step.kind!=='action'||step.do.op!=='scrape')throw Error('Bad fixture');
 step.do=extractionOperation(pack,step.do,{read:{kind:'attribute',name:'data-reference'},outputKey:'reference',maxLength:4096,sensitivity:'public'});
 const compiled=compileFlow(pack,manifest);assert.deepEqual((compiled.pack.steps['read-first'] as any).do,step.do);
 step.do=extractionOperation(pack,step.do,{read:{kind:'text'},maxLength:1,sensitivity:'sensitive'});
 assert.deepEqual(step.do.read,{kind:'text'});compileFlow(pack,manifest);
});

test('invalid extraction edits preserve the previous draft and reject multi-match target definitions',()=>{
 const {pack}=fixture(),operation=newExtractionOperation(pack),before=JSON.stringify(pack);
 for(const patch of [{target:'items'},{target:'missing'},{outputKey:'not valid'},{outputKey:'x'.repeat(65)},{maxLength:0},{maxLength:4097},{maxLength:1.1},{maxLength:NaN},{sensitivity:'unknown'},{read:{kind:'attribute',name:'href'}},{read:{kind:'attribute',name:'data-'}},{read:{kind:'attribute',name:'onclick'}}])assert.throws(()=>extractionOperation(pack,operation,patch));
 assert.equal(JSON.stringify(pack),before);assert.deepEqual(operation,newExtractionOperation(pack));
});

test('read creation finds a unique output name and fails atomically when no single-element target exists',()=>{
 const {pack}=fixture();insertFlowStep(pack,'extraction',()=> 'read-first');
 assert.equal(newExtractionOperation(pack).outputKey,'result-2');
 pack.registry.targets={items:pack.registry.targets.items!};const before=JSON.stringify(pack);
 assert.throws(()=>insertFlowStep(pack,'extraction',()=> 'read-second'),/exactly one element/);assert.equal(JSON.stringify(pack),before);
});

test('value-source changes discard old literal or key fields and offer only supported string sources',()=>{
 const {pack}=fixture();insertFlowStep(pack,'extraction',()=> 'read-first');
 assert.deepEqual(valueChoices(pack,'input','fill').map((value:any)=>value.key),['text']);
 assert.deepEqual(authoredValue(pack,'fill','input','text'),{source:'input',key:'text'});
 assert.deepEqual(authoredValue(pack,'fill','capture','result'),{source:'capture',key:'result'});
 assert.deepEqual(authoredValue(pack,'fill','literal','exact text'),{source:'literal',value:'exact text'});
 assert.throws(()=>authoredValue(pack,'fill','literal','x'.repeat(501)),/500/);
 assert.throws(()=>authoredValue(pack,'fill','input','quantity'),/existing text input/);
 assert.throws(()=>authoredValue(pack,'read-first','capture','result'),/existing read value/);
 assert.throws(()=>authoredValue(pack,'fill','capture','missing'),/existing read value/);
});

test('a named capture without a guaranteed preceding read remains a compile error',()=>{
 const {pack,manifest}=fixture();insertFlowStep(pack,'extraction',()=> 'read-first');
 const fill=pack.steps.fill!;if(fill.kind!=='action'||fill.do.op!=='fill')throw Error('Bad fixture');
 fill.do.value=authoredValue(pack,'fill','capture','result');pack.entryByState.page='fill';
 assert.throws(()=>compileFlow(pack,manifest),/not definitely assigned|unreachable/);
});
