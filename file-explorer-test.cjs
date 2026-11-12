'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
function fixture({ attachments = 0 } = {}) {
  const metrics = { extensionReads: 0, comparisons: 0, renders: 0, highlightCalls: 0 };
  class Element {
    constructor(options = {}) { this.children = []; this.attrs = { ...options.attr }; this.classes = new Set((options.cls || '').split(' ').filter(Boolean)); this.events = {}; this.style = {}; this.scrollTop = 0; this.text = options.text || ''; }
    createEl(_, options) { const node = new Element(options); this.children.push(node); return node; }
    createSpan(options) { return this.createEl('span', options); }
    createDiv(options) { return this.createEl('div', options); }
    addClass(...names) { names.forEach(name => this.classes.add(name)); }
    removeClass(...names) { names.forEach(name => this.classes.delete(name)); }
    toggleClass(name, enabled) { if (enabled) this.classes.add(name); else this.classes.delete(name); }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    empty() { this.children = []; this.scrollTop = 0; }
    querySelectorAll(selector) {
      const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      const data = selector.match(/\[data-path="([^"]+)"\]/);
      const result = [];
      const visit = node => { for (const child of node.children) { if (classes.every(name => child.classes.has(name)) && (!data || child.attrs['data-path'] === data[1])) result.push(child); visit(child); } };
      visit(this); return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    scrollIntoView() { this.scrolledIntoView = true; }
  }
  class TFolder { constructor(filePath, parent) { this.path = filePath; this.name = filePath.split('/').pop(); this.parent = parent; this.children = []; } }
  class TFile {
    constructor(filePath, parent) { this.path = filePath; this.parent = parent; this.name = filePath.split('/').pop(); this.basename = this.name.replace(/\.[^.]*$/, ''); this.stat = { size: 100, mtime: 1, ctime: 1 }; }
    get extension() { metrics.extensionReads++; return this.name.split('.').pop(); }
  }
  const timers = new Map(), frames = new Map(); let nextFrame = 1;
  const vaultEvents = {}, workspaceEvents = {};
  const root = new TFolder('/');
  for (let i = 0; i < 95; i++) { const folder = new TFolder('Folder' + String(i).padStart(2, '0'), root); root.children.push(folder); for (let j = 0; j < 100; j++) folder.children.push(new TFile(folder.path + '/note' + j + '.md', folder)); }
  for (let i = 0; i < attachments; i++) root.children.push(new TFile('image' + i + '.png', root));
  const collator = new Intl.Collator('zh-CN');
  class Empty {}
  class ItemView { constructor() { this.containerEl = new Element(); this.containerEl.children = [new Element(), new Element()]; } registerEvent() {} }
  const obs = { Plugin: Empty, PluginSettingTab: Empty, ItemView, Modal: Empty, SuggestModal: Empty, FuzzySuggestModal: Empty, Notice: Empty, TFile, TFolder, setIcon() {}, debounce: callback => { const fn = () => timers.set(fn, callback); fn.cancel = () => timers.delete(fn); return fn; } };
  const context = { require: () => obs, module: { exports: {} }, console, Date, URL, CSS: { escape: value => value }, Intl: { Collator: class { compare(a, b) { metrics.comparisons++; return collator.compare(a, b); } } }, window: { requestAnimationFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id) } };
  const main = process.env.TOOLKIT_MAIN || path.join(__dirname, 'main.js');
  vm.runInNewContext(fs.readFileSync(main, 'utf8') + '\nmodule.exports.__Explorer = LuckyFileExplorer;', context);
  const view = new context.module.exports.__Explorer({}, { _noteCountCache: new Map() });
  let active = null;
  view.app = { vault: { getRoot: () => root, on: (event, callback) => { vaultEvents[event] = callback; return {}; } }, workspace: { getActiveFile: () => active, on: (event, callback) => { workspaceEvents[event] = callback; return {}; } } };
  const render = view.renderTree.bind(view); view.renderTree = () => { metrics.renders++; return render(); };
  const highlight = view.highlightActiveFile.bind(view); view.highlightActiveFile = () => { metrics.highlightCalls++; return highlight(); };
  const reset = () => Object.keys(metrics).forEach(key => { metrics[key] = 0; });
  return { view, root, TFile, TFolder, metrics, reset, vaultEvents, workspaceEvents, frames, flush: () => { const values = [...timers.values()]; timers.clear(); values.forEach(fn => fn()); }, flushFrames: () => { const values = [...frames.values()]; frames.clear(); values.forEach(fn => fn()); }, setActive: value => { active = value; } };
}
test('9500-note counts only rescan the changed branch after a Markdown create', async () => {
  const f = fixture(); await f.view.onOpen(); f.reset();
  const folder = f.root.children[0]; const file = new f.TFile(folder.path + '/new.md', folder); folder.children.push(file);
  f.vaultEvents.create(file); f.flush();
  assert.equal(f.view.getMdCount(folder), 101);
  console.log('Markdown create extension checks:', f.metrics.extensionReads);
  assert.ok(f.metrics.extensionReads < 500, 'unrelated folders were rescanned');
  assert.equal(f.view.getMdCount(f.root.children[94]), 100);
});
test('invisible attachment create/delete/rename skip tree rebuild and count invalidation', async () => {
  const f = fixture(); await f.view.onOpen(); f.reset(); const file = new f.TFile('image.png', f.root);
  f.vaultEvents.create(file); f.vaultEvents.delete(file); f.vaultEvents.rename(file, 'old-image.png'); f.flush();
  assert.equal(f.metrics.renders, 0); assert.equal(f.metrics.extensionReads, 3);
});
test('100 Markdown creates share one refresh and keep the final count', async () => {
  const f = fixture(); await f.view.onOpen(); f.reset(); const folder = f.root.children[0];
  for (let i = 0; i < 100; i++) {
    const file = new f.TFile(folder.path + '/new' + i + '.md', folder); folder.children.push(file); f.vaultEvents.create(file);
  }
  f.flush(); assert.equal(f.metrics.renders, 1); assert.equal(f.view.getMdCount(folder), 200);
  assert.ok(f.metrics.extensionReads < 600);
});
test('Markdown delete invalidates ancestors using its path without a parent', async () => {
  const f = fixture(); await f.view.onOpen(); const folder = f.root.children[0], file = folder.children.pop();
  file.parent = null; f.vaultEvents.delete(file); f.flush(); assert.equal(f.view.getMdCount(folder), 99);
});
test('root Markdown create and delete invalidate the root cache', async () => {
  const f = fixture(); await f.view.onOpen(); assert.equal(f.view.getMdCount(f.root), 9500);
  const file = new f.TFile('root.md', f.root); f.root.children.push(file); f.vaultEvents.create(file); f.flush();
  assert.equal(f.view.getMdCount(f.root), 9501);
  f.root.children.pop(); file.parent = null; f.vaultEvents.delete(file); f.flush(); assert.equal(f.view.getMdCount(f.root), 9500);
});
test('rename between folders invalidates both Markdown ancestor counts', async () => {
  const f = fixture(); await f.view.onOpen(); f.reset();
  const source = f.root.children[0], target = f.root.children[1]; const file = source.children.pop(); const old = file.path;
  file.parent = target; file.path = target.path + '/' + file.name; target.children.push(file);
  f.vaultEvents.rename(file, old); f.flush();
  assert.equal(f.view.getMdCount(source), 99); assert.equal(f.view.getMdCount(target), 101);
  assert.ok(f.metrics.extensionReads < 600);
});
test('renaming Markdown to an attachment still refreshes the old Markdown count', async () => {
  const f = fixture(); await f.view.onOpen(); const folder = f.root.children[0], file = folder.children[0], old = file.path;
  file.name = 'note.png'; file.path = folder.path + '/note.png';
  f.vaultEvents.rename(file, old); f.flush(); assert.equal(f.view.getMdCount(folder), 99);
});
test('folder rename preserves expanded descendants and refreshes folder counts', async () => {
  const f = fixture(); await f.view.onOpen(); const folder = f.root.children[0], old = folder.path;
  f.view.expandedFolders.add(old); f.view.expandedFolders.add(old + '/nested'); folder.path = 'Renamed'; folder.name = 'Renamed';
  for (const file of folder.children) file.path = 'Renamed/' + file.name;
  f.vaultEvents.rename(folder, old); f.flush();
  assert.ok(f.view.expandedFolders.has('Renamed/nested')); assert.ok(!f.view.expandedFolders.has(old)); assert.equal(f.view.getMdCount(folder), 100);
});
test('100 file-open events share one animation-frame highlight and retain auto-reveal', async () => {
  const f = fixture(); await f.view.onOpen(); f.reset(); f.setActive(f.root.children[0].children[0]); f.view._autoReveal = true;
  for (let i = 0; i < 100; i++) f.workspaceEvents['file-open']();
  assert.equal(f.frames.size, 1); f.flushFrames();
  assert.ok(f.view.expandedFolders.has('Folder00')); assert.ok(f.view.containerEl.querySelector('.lucky-fe-file.is-active'));
  assert.ok(f.metrics.highlightCalls <= 2);
});
test('closing explorer cancels queued highlight and tree refresh', async () => {
  const f = fixture(); await f.view.onOpen(); f.reset();
  f.workspaceEvents['file-open'](); f.vaultEvents.create(new f.TFile('new.md', f.root));
  if (f.view.onClose) await f.view.onClose(); f.flushFrames(); f.flush();
  assert.equal(f.metrics.highlightCalls, 0); assert.equal(f.metrics.renders, 0);
});
test('tree rebuild keeps scroll position and alphabetical/reverse sorting', async () => {
  const f = fixture(); await f.view.onOpen(); f.view._treeEl.scrollTop = 240; f.view._sortMode = 'alphabeticalReverse'; f.view.renderTree();
  assert.equal(f.view._treeEl.scrollTop, 240); assert.equal(f.view._treeEl.children[0].querySelector('.lucky-fe-folder-name').text, 'Folder94');
});
test('attachments and hidden children are filtered before sorting', async () => {
  const f = fixture({ attachments: 2000 });
  f.root.children.push(new f.TFolder('.hidden', f.root), new f.TFile('.hidden.md', f.root));
  await f.view.onOpen();
  console.log('Root sort comparisons with 95 folders and 2000 attachments:', f.metrics.comparisons);
  assert.ok(f.metrics.comparisons < 200); assert.equal(f.view._treeEl.children.length, 95);
});
