const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');

function load() {
  const file = path.join(__dirname, '../web/state.ts');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const historyContext = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../trajectory_workbench/viewer/history.js'), 'utf8'), historyContext);
  const History = historyContext.module.exports.History;
  const context = { exports: {}, require: name => require('./load-ts.cjs')(path.resolve(path.dirname(file), name)), window: { Legacy: { History } }, structuredClone, URLSearchParams, location: { search: '' }, fetch: null };
  vm.runInNewContext(code, context, { filename: file });
  const workspace = new context.exports.Workspace();
  return { workspace, context, link: new context.exports.LightingLink(workspace) };
}

test('save response cannot swallow an edit made during the request', async () => {
  const { workspace: w, context } = load();
  let done;
  context.fetch = () => new Promise(resolve => { done = body => resolve({ ok: true, json: async () => body }); });
  const s = w.install('scene', 'room', { id: 'room', x: 1, unknown: [4, 2] }, 'a');
  w.edit('scene:room', 'move', d => { d.x = 2; });
  const saving = w.save('scene:room');
  w.edit('scene:room', 'move again', d => { d.x = 3; });
  done({ ok: true, revision: 'b', doc: { id: 'room', x: 2, unknown: [4, 2] } });
  await saving;
  assert.equal(s.doc.x, 3);
  assert.equal(w.dirty(s), true);
  assert.equal(JSON.parse(s.baseline).x, 2);
});

test('saving two acoustic documents advances the common library version without changing either draft', async () => {
  const { workspace: w, context } = load();
  const sent = [];
  context.fetch = async (_, opts) => { const body = JSON.parse(opts.body); sent.push(body); return { ok: true, json: async () => ({ ok: true, revision: String(sent.length), doc: body.doc }) }; };
  const a = w.install('acoustic', 'a', { label: 'one' }, '0');
  const b = w.install('acoustic', 'b', { label: 'two' }, '0');
  w.edit('acoustic:a', 'a', d => { d.label = 'changed a'; });
  w.edit('acoustic:b', 'b', d => { d.label = 'changed b'; });
  await w.save('acoustic:a');
  assert.equal(b.revision, '1'); assert.equal(b.doc.label, 'changed b'); assert.equal(w.dirty(b), true);
  await w.save('acoustic:b');
  assert.equal(sent[1].revision, '1'); assert.equal(a.revision, '2'); assert.equal(b.revision, '2');
});

test('failed saves leave history, draft, and disk baseline intact', async () => {
  const { workspace: w, context } = load();
  context.fetch = async () => ({ ok: false, json: async () => ({ ok: false, err: 'external conflict' }) });
  const s = w.install('scene', 'room', { x: 1, opaque: { n: 7 } }, 'baseline');
  w.edit('scene:room', 'move', d => { d.x = 5; });
  await assert.rejects(w.save('scene:room'), /external conflict/);
  assert.equal(s.revision, 'baseline'); assert.equal(s.doc.x, 5); assert.equal(s.history.canUndo, true);
  s.history.undo(); assert.equal(w.dirty(s), false);
  s.history.redo(); w.discard('scene:room'); assert.equal(s.doc.x, 1); assert.equal(s.history.canUndo, false);
});

test('runtime pull refuses to overwrite unsent workbench lighting', async () => {
  const { workspace: w, link, context } = load();
  let requests = 0;
  context.fetch = async () => { requests++; throw new Error('must not call'); };
  const s = w.install('scene', 'room', { lighting: { intensity: 1 } }, 'disk');
  link.attach('room');
  w.edit('scene:room', 'local light', d => { d.lighting.intensity = 2; });
  await assert.rejects(link.pull(), /尚未发送/);
  assert.equal(requests, 0); assert.equal(s.doc.lighting.intensity, 2);
});

test('runtime response cannot swallow a lighting edit made while waiting', async () => {
  const { workspace: w, link, context } = load();
  let done;
  context.fetch = () => new Promise(resolve => { done = () => resolve({ ok: true, json: async () => ({ ok: true, lighting: { intensity: 8 } }) }); });
  const s = w.install('scene', 'room', { lighting: { intensity: 1 } }, 'disk');
  link.attach('room'); const pulling = link.pull();
  w.edit('scene:room', 'local light', d => { d.lighting.intensity = 3; }); done();
  await assert.rejects(pulling, /读取期间/);
  assert.equal(s.doc.lighting.intensity, 3);
});

test('runtime phase pull preserves unrelated edits and is undoable', async () => {
  const { workspace: w, link, context } = load();
  context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, lighting: { intensity: 5 }, phase: 'night', variant: { sky: { gain: 2 } } }) });
  const s = w.install('scene', 'room', { lighting: { intensity: 1 }, npc: { x: 1 }, timeVariants: { night: { backgrounds: ['old'] } } }, 'disk');
  link.attach('room'); w.edit('scene:room', 'npc', d => { d.npc.x = 12; });
  await link.pull();
  assert.equal(s.doc.npc.x, 12); assert.equal(s.doc.lighting.intensity, 5);
  assert.equal(s.doc.timeVariants.night.backgrounds[0], 'old');
  assert.equal(s.doc.timeVariants.night.lighting.sky.gain, 2);
  s.history.undo(); assert.equal(s.doc.lighting.intensity, 1); assert.equal(s.doc.npc.x, 12);
});

test('runtime base-equivalent phase does not invent a new empty variant', async () => {
  const { workspace: w, link, context } = load();
  context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, lighting: { intensity: 1 }, phase: 'noon', variant: {} }) });
  const s = w.install('scene', 'room', { lighting: { intensity: 1 } }, 'disk');
  link.attach('room'); await link.pull();
  assert.equal(s.doc.timeVariants, undefined); assert.equal(w.dirty(s), false);
});
