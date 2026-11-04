/** Extraction authoring uses the existing bounded flow dialect; no page values enter the editor. */
const validKey = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

export function extractionOperation(pack, current, patch = {}) {
  const operation = {...current, ...patch, read: structuredClone(patch.read ?? current.read)};
  if (operation.op !== 'scrape') throw Error('Choose a Read value action first.');
  if (!Object.hasOwn(pack.registry.targets, operation.target) || pack.registry.targets[operation.target].cardinality !== 'one') throw Error('Choose a target that identifies exactly one element.');
  if (!validKey(operation.outputKey)) throw Error('Use a value name starting with a lowercase letter, then up to 63 letters, numbers, underscores or hyphens.');
  if (!['public', 'sensitive'].includes(operation.sensitivity)) throw Error('Choose whether the value is public or sensitive.');
  if (!Number.isInteger(operation.maxLength) || operation.maxLength < 1 || operation.maxLength > 4096) throw Error('Choose a character limit from 1 to 4096.');
  if (!operation.read || !['text', 'attribute'].includes(operation.read.kind)) throw Error('Choose text or an attribute to read.');
  if (operation.read.kind === 'attribute' && !/^(data-[a-z0-9-]+|aria-[a-z0-9-]+)$/.test(operation.read.name ?? '')) throw Error('Use a data-* or aria-* attribute, such as data-reference.');
  return operation;
}

export function newExtractionOperation(pack) {
  const target = Object.keys(pack.registry.targets).find(id => pack.registry.targets[id].cardinality === 'one');
  if (!target) throw Error('Add a page target that identifies exactly one element first.');
  const used = new Set(Object.values(pack.steps).filter(step => step.kind === 'action' && step.do.op === 'scrape').map(step => step.do.outputKey));
  let index = 1, outputKey = 'result';
  while (used.has(outputKey)) outputKey = 'result-' + ++index;
  return extractionOperation(pack, {op:'scrape', target, read:{kind:'text'}, outputKey, sensitivity:'sensitive', maxLength:1000});
}

export function valueChoices(pack, source, excludedStep) {
  if (source === 'input') return Object.entries(pack.inputSchema.properties ?? {}).filter(([, schema]) => schema.type === 'string').map(([key, schema]) => ({key, title:schema.title || key}));
  const values = new Map();
  for (const [id, step] of Object.entries(pack.steps)) {
    if (id === excludedStep) continue;
    if (source === 'capture' && step.kind === 'action' && step.do.op === 'scrape') values.set(step.do.outputKey, {key:step.do.outputKey, title:step.do.outputKey + ' · Read value ' + id});
    if (source === 'answer' && step.kind === 'input' && step.input.kind === 'text') values.set(step.answerKey, {key:step.answerKey, title:step.title || step.answerKey});
  }
  return [...values.values()];
}

export function authoredValue(pack, stepId, source, value) {
  if (source === 'literal') {
    if (typeof value !== 'string' || value.length > 500) throw Error('Enter text of at most 500 characters.');
    return {source, value};
  }
  if (!['input', 'capture', 'answer'].includes(source) || !valueChoices(pack, source, stepId).some(item => item.key === value)) throw Error('Choose an existing ' + ({input:'text input',capture:'read value',answer:'text answer'}[source] || 'value') + '.');
  return {source, key:value};
}
