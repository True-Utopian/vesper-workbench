import {newExtractionOperation} from './extraction-controls.js';
/** Pure authoring helpers shared by the graph and its form controls. */
export function stepCaption(step) {
  if (step.kind === 'branch') return 'Branch by page';
  if (step.kind === 'repeat') return `Repeat ${step.count} ${step.count === 1 ? 'time' : 'times'}`;
  if (step.kind === 'complete') return 'Finish and save';
  if (step.kind === 'review') return 'Operator review';
  if (step.kind === 'input') return 'Ask for input';
  return {fill:'Enter text',click:'Click element',navigate:'Open page',wait:'Wait for page',scrape:'Read value',chooseOption:'Choose option',bindIdentity:'Verify identity'}[step.do?.op] || 'Action';
}
export function actionableStates(pack) {
  return Object.keys(pack.registry.states).filter(id => pack.registry.states[id].actionable);
}
export function compatibleSteps(pack, state, exclude = []) {
  return Object.keys(pack.steps).filter(id => !exclude.includes(id) && pack.steps[id].requires.includes(state));
}
export function stateDestination(pack, state, exclude = []) {
  const candidates = compatibleSteps(pack,state,exclude);
  const entry = pack.entryByState[state];
  return candidates.includes(entry) ? entry : candidates.includes(pack.onUnexpectedStep) ? pack.onUnexpectedStep : candidates[0];
}
export function setControlStates(pack, id, values) {
  const step = pack.steps[id], states = [...new Set(values)];
  if (!states.length || states.length > 30 || states.some(state => !pack.registry.states[state]?.actionable)) throw Error('Choose one to thirty recognized, actionable pages.');
  if (!['branch','repeat'].includes(step.kind)) throw Error('Choose a control step.');
  const next = {}, recovery = {};
  for (const state of states) {
    const destination = stateDestination(pack,state,[id, ...(step.kind === 'repeat' ? [step.body] : [])]);
    if (!destination) throw Error('Add a destination that accepts ' + state + ' first.');
    next[state] = pack.steps[step.next[state]]?.requires.includes(state) ? step.next[state] : destination;
    recovery[state] = pack.steps[step.recoveryByState[state]]?.requires.includes(state) ? step.recoveryByState[state] : destination;
  }
  step.requires = states; step.next = next; step.recoveryByState = recovery;
}
export function insertFlowStep(pack, kind, makeId = prefix => prefix + '-' + crypto.randomUUID().slice(0,8)) {
  if (!['action','branch','repeat','extraction'].includes(kind)) throw Error('Choose an action, read value, branch or repeat step.');
  const extraction = kind === 'extraction' ? newExtractionOperation(pack) : undefined;
  const state = Object.keys(pack.entryByState).find(id => pack.registry.states[id]?.actionable) || actionableStates(pack)[0];
  if (!state) throw Error('Add a recognized page before adding steps.');
  const id = makeId(kind), body = kind === 'repeat' ? makeId('body') : undefined;
  if (Object.hasOwn(pack.steps,id) || body && (body === id || Object.hasOwn(pack.steps,body))) throw Error('Step IDs must be unique.');
  const previous = stateDestination(pack,state), review = pack.onUnexpectedStep;
  if (!previous) throw Error('Add a destination for this page first.');
  const common = {requires:[state],onError:review,onTimeout:review,onUncertain:review,recoveryByState:{[state]:previous}};
  const action = next => ({...structuredClone(common),kind:'action',do:{op:'wait'},postcondition:{states:[state],require:[],timeoutMs:10000},next:{[state]:next},retry:{mode:'never',maxAttempts:1}});
  if (kind === 'repeat') {
    const count = Math.min(3,pack.limits.maxStateVisits - 1);
    if (count < 1) throw Error('Set the step visit limit to at least two before adding a repeat.');
    pack.steps[id] = {...common,kind,count,body,next:{[state]:previous}};
    pack.steps[body] = action(id);
  } else if (kind === 'extraction') {
    // A failed read must not recover directly into a consumer with no value.
    pack.steps[id] = {...action(previous),do:extraction,recoveryByState:{[state]:review}};
  } else pack.steps[id] = kind === 'action' ? action(previous) : {...common,kind,next:{[state]:previous}};
  pack.entryByState[state] = id;
  return {id,body};
}
export function graphRoutes(pack,id) {
  const step = pack.steps[id], routes = [];
  if (step.kind === 'repeat') routes.push({to:step.body,label:`Body · ${step.count} times`,kind:'body'});
  for (const [state,to] of Object.entries(step.next || {})) routes.push({to,label:(step.kind === 'repeat' ? 'Then: ' : 'When: ') + (pack.registry.states[state]?.title || state),kind:'success'});
  const recovery = new Set([...Object.values(step.recoveryByState || {}),step.onError,step.onTimeout,step.onUncertain].filter(Boolean));
  for (const to of recovery) if (!routes.some(route => route.to === to)) routes.push({to,label:'Review / recovery',kind:'recovery'});
  return routes;
}
export function arrangeFlow(pack) {
  const levels = new Map(), pending = [...new Set(Object.values(pack.entryByState))].map(id => ({id,depth:0}));
  while (pending.length) {
    const {id,depth} = pending.shift();
    if (!Object.hasOwn(pack.steps,id) || levels.has(id)) continue;
    levels.set(id,depth);
    for (const route of graphRoutes(pack,id)) if (route.kind !== 'recovery') pending.push({id:route.to,depth:depth+1});
  }
  const tail = Math.max(0,...levels.values()) + 1;
  for (const id of Object.keys(pack.steps)) if (!levels.has(id)) levels.set(id,tail);
  const rows = new Map(), positions = {};
  for (const [id,depth] of levels) {const column=rows.get(depth)||0;rows.set(depth,column+1);positions[id]={x:30+column*250,y:45+depth*160};}
  if (Object.values(positions).some(p=>p.x>9600||p.y>9600)) {
    for (const [index,id] of [...levels.keys()].entries()) positions[id]={x:30+(index%10)*250,y:45+Math.floor(index/10)*160};
  }
  return positions;
}
