'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
function fixture({ attachments = 0, rootFolderIcons = {} } = {}) {
  const metrics = { extensionReads: 0, comparisons: 0, renders: 0, highlightCalls: 0 };
  class Element {
    constructor(options = {}) { this.children = []; this.attrs = { ...options.attr }; this.classes = new Set((options.cls || '').split(' ').filter(Boolean)); this.events = {}; this.style = {}; this.scrollTop = 0; this.text = options.text || ''; }
    createEl(_, options) { const node = new Element(options); node.parentElement = this; this.children.push(node); return node; }
    createSpan(options) { return this.createEl('span', options); }
    createDiv(options) { return this.createEl('div', options); }
    addClass(...names) { names.forEach(name => this.classes.add(name)); }
    removeClass(...names) { names.forEach(name => this.classes.delete(name)); }
    toggleClass(name, enabled) { if (enabled) this.classes.add(name); else this.classes.delete(name); }
    setAttribute(name, value) { this.attrs[name] = value; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    get textContent() { return this.text; }
    set textContent(value) { this.text = String(value); }
    appendChild(node) { if (node.parentElement) { const index = node.parentElement.children.indexOf(node); if (index !== -1) node.parentElement.children.splice(index, 1); } node.parentElement = this; this.children.push(node); return node; }
    addEventListener(name, callback) { this.events[name] = callback; }
    empty() { this.children = []; this.scrollTop = 0; }
    querySelectorAll(selector) {
      const classes = [...selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)].map(match => match[1]);
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
  const listeners = {};
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
  const view = new context.module.exports.__Explorer({}, { _noteCountCache: new Map(), settings: { rootFolderIcons } });
  let active = null;
  view.app = { vault: { getRoot: () => root, on: (event, callback) => { vaultEvents[event] = callback; (listeners[event] ??= []).push(callback); return {}; } }, workspace: { getActiveFile: () => active, on: (event, callback) => { workspaceEvents[event] = callback; return {}; } } };
  const render = view.renderTree.bind(view); view.renderTree = () => { metrics.renders++; return render(); };
  const highlight = view.highlightActiveFile.bind(view); view.highlightActiveFile = () => { metrics.highlightCalls++; return highlight(); };
  const reset = () => Object.keys(metrics).forEach(key => { metrics[key] = 0; });
  return { Element, Plugin: context.module.exports, listeners, emit: (event, ...args) => (listeners[event] || []).forEach(fn => fn(...args)), view, root, TFile, TFolder, metrics, reset, vaultEvents, workspaceEvents, frames, flush: () => { const values = [...timers.values()]; timers.clear(); values.forEach(fn => fn()); }, flushFrames: () => { const values = [...frames.values()]; frames.clear(); values.forEach(fn => fn()); }, setActive: value => { active = value; } };
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

function countNodes(node) { return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0); }
function nativeCounts(f) {
  const plugin = new f.Plugin();
  plugin.app = f.view.app;
  plugin.settings = { showNoteCount: true };
  plugin._noteCountCache = new Map();
  plugin.registerEvent = () => {};
  f.view.plugin = plugin;
  const metrics = { enumerations: 0 };
  const items = {};
  for (const folder of f.root.children) {
    if (!(folder instanceof f.TFolder)) continue;
    const title = new f.Element(); title.createDiv({ cls: 'nav-folder-title-content' });
    items[folder.path] = { file: folder, selfEl: title };
    for (const file of folder.children) items[file.path] = { file, selfEl: new f.Element() };
  }
  const view = { fileItems: new Proxy(items, { ownKeys(target) { metrics.enumerations++; return Reflect.ownKeys(target); } }) };
  plugin.app.workspace.getLeavesOfType = type => type === 'file-explorer' ? [{ view }] : [];
  return { plugin, metrics, items, badge: path => items[path]?.selfEl.querySelector('.lucky-note-count')?.textContent };
}
test('selector fixture matches data-path containing a Markdown suffix', () => {
  const f = fixture(); const el = new f.Element();
  const row = el.createDiv({ cls: 'lucky-fe-file', attr: { 'data-path': 'Folder00/note0.md' } });
  assert.equal(el.querySelector('.lucky-fe-file[data-path="Folder00/note0.md"]'), row);
});
test('native and custom counts share cache and skip attachment event batches', async () => {
  const f = fixture(), n = nativeCounts(f); await f.view.onOpen();
  const afterCustom = f.metrics.extensionReads; n.plugin.initNoteCount();
  assert.equal(f.metrics.extensionReads, afterCustom, 'native counts must reuse custom counts');
  f.reset(); n.metrics.enumerations = 0;
  const image = new f.TFile('image.png', f.root);
  f.emit('create', image); f.emit('delete', image); f.emit('rename', image, 'old.png'); f.flush();
  assert.equal(f.metrics.renders, 0); assert.equal(n.metrics.enumerations, 0);
  assert.ok(f.metrics.extensionReads < 10, 'attachments must not rescan all Markdown');
  assert.equal(n.badge('Folder00'), '100');
  console.log('Attachment batch count checks / native enumerations:', f.metrics.extensionReads, n.metrics.enumerations);
});
test('native Markdown counts refresh only changed ancestor badges without whole fileItems enumeration', async () => {
  const f = fixture(), n = nativeCounts(f); await f.view.onOpen(); n.plugin.initNoteCount();
  f.reset(); n.metrics.enumerations = 0;
  const folder = f.root.children[0], file = new f.TFile(folder.path + '/new.md', folder); folder.children.push(file);
  f.emit('create', file); f.flush();
  assert.equal(n.badge('Folder00'), '101'); assert.equal(n.badge('Folder94'), '100');
  assert.equal(f.metrics.renders, 1); assert.equal(n.metrics.enumerations, 0);
  assert.ok(f.metrics.extensionReads < 500, 'unrelated cached folders must stay cached');
  console.log('Native+custom Markdown create checks / native enumerations:', f.metrics.extensionReads, n.metrics.enumerations);
  folder.children.pop(); file.parent = null; f.emit('delete', file); f.flush();
  assert.equal(n.badge('Folder00'), '100');
});
test('native counts preserve Markdown-to-attachment rename and folder move/delete semantics', async () => {
  const f = fixture(), n = nativeCounts(f); await f.view.onOpen(); n.plugin.initNoteCount();
  const folder = f.root.children[0], file = folder.children[0], oldFile = file.path;
  file.path = folder.path + '/note0.png'; file.name = 'note0.png';
  f.emit('rename', file, oldFile); f.flush(); assert.equal(n.badge('Folder00'), '99');
  const oldFolder = folder.path; folder.path = 'Moved'; folder.name = 'Moved';
  for (const child of folder.children) child.path = 'Moved/' + child.name;
  n.items.Moved = n.items[oldFolder]; delete n.items[oldFolder];
  f.emit('rename', folder, oldFolder); f.flush();
  assert.equal(n.badge('Moved'), '99'); assert.equal(f.view.getMdCount(folder), 99);
  assert.ok(!n.plugin._noteCountCache.has(oldFolder));
  f.root.children.shift(); folder.parent = null; delete n.items.Moved;
  f.emit('delete', folder); f.flush(); assert.equal(f.view.getMdCount(f.root), 9400);
  assert.equal(n.badge('Folder01'), '100'); assert.ok(!n.plugin._noteCountCache.has('Moved'));
});
test('collapsed folders release file DOM and render correctly on every reopening', async () => {
  const f = fixture(); await f.view.onOpen(); const initial = countNodes(f.view._treeEl);
  for (const title of f.view._treeEl.querySelectorAll('.lucky-fe-folder-title')) { title.events.click(); title.events.click(); }
  assert.equal(countNodes(f.view._treeEl), initial); assert.equal(f.view._treeEl.querySelectorAll('.lucky-fe-file').length, 0);
  console.log('DOM before / after visiting+collapsing all 95 folders:', initial, countNodes(f.view._treeEl));
  const first = f.view._treeEl.querySelector('.lucky-fe-folder-title'); first.events.click();
  assert.equal(f.view._treeEl.querySelectorAll('.lucky-fe-file').length, 100);
  first.events.click(); first.events.click(); assert.equal(f.view._treeEl.querySelectorAll('.lucky-fe-file').length, 100);
});
test('collapsing parent preserves nested expansion state and restores its children', async () => {
  const f = fixture(), parent = f.root.children[0], nested = new f.TFolder('Folder00/nested', parent);
  parent.children.push(nested); nested.children.push(new f.TFile(nested.path + '/nested.md', nested));
  await f.view.onOpen(); f.view.expandedFolders.add(parent.path); f.view.expandedFolders.add(nested.path); f.view.renderTree();
  const first = f.view._treeEl.querySelector('.lucky-fe-folder-title'); first.events.click();
  assert.equal(f.view._treeEl.querySelectorAll('.lucky-fe-file').length, 0); assert.ok(f.view.expandedFolders.has(nested.path));
  first.events.click(); assert.equal(f.view._treeEl.querySelectorAll('.lucky-fe-file').length, 101);
});
test('auto-reveal expands ancestors even if an existing row was rendered while ancestor is marked collapsed', async () => {
  const f = fixture(); await f.view.onOpen(); f.view.expandedFolders.add('Folder00'); f.view.renderTree();
  f.view.expandedFolders.delete('Folder00'); f.view._treeEl.querySelector('.lucky-fe-children').style.display = 'none';
  f.view._autoReveal = true; f.setActive(f.root.children[0].children[0]); f.workspaceEvents['file-open'](); f.flushFrames();
  assert.ok(f.view.expandedFolders.has('Folder00')); assert.ok(f.view._treeEl.querySelector('.lucky-fe-file.is-active'));
});
test('visible Markdown modify updates size and tooltip without rebuilding or recounting the tree', async () => {
  const f = fixture(); await f.view.onOpen(); f.view.expandedFolders.add('Folder00'); f.view.renderTree();
  const file = f.root.children[0].children[0]; file.stat.size = 8192; file.stat.mtime = 300; f.reset();
  f.emit('modify', file); f.flushFrames();
  const row = f.view._treeEl.querySelector('.lucky-fe-file[data-path="Folder00/note0.md"]');
  assert.equal(row.querySelector('.lucky-fe-file-size').textContent, '8.0K'); assert.match(row.getAttribute('title'), /8\.0 KB/);
  assert.equal(f.metrics.renders, 0); assert.ok(f.metrics.extensionReads < 10);
});
test('modified-time sorting batches changes in one frame and reorders only existing siblings', async () => {
  const f = fixture(); await f.view.onOpen(); f.view.expandedFolders.add('Folder00'); f.view._sortMode = 'byModifiedTime';
  const folder = f.root.children[0], a = folder.children[0], b = folder.children[1]; a.stat.mtime = 100; b.stat.mtime = 200;
  f.view.renderTree(); f.view._treeEl.scrollTop = 240; f.reset(); a.stat.mtime = 300; a.stat.size = 8192;
  for (let i = 0; i < 100; i++) f.emit('modify', a);
  assert.equal(f.frames.size, 1); f.flushFrames();
  assert.equal(f.view._treeEl.querySelector('.lucky-fe-file-name').text, 'note0');
  assert.equal(f.view._treeEl.scrollTop, 240); assert.equal(f.metrics.renders, 0);
  assert.ok(f.metrics.extensionReads <= 100); assert.equal(f.frames.size, 0);
});
test('modifying hidden files queues no tree work and closing cancels visible modify work', async () => {
  const f = fixture(); await f.view.onOpen(); const file = f.root.children[0].children[0];
  f.emit('modify', file); assert.equal(f.frames.size, 0);
  f.view.expandedFolders.add('Folder00'); f.view.renderTree(); f.emit('modify', file); assert.equal(f.frames.size, 1);
  await f.view.onClose(); assert.equal(f.frames.size, 0); f.flushFrames();
});

test('native-only counts handle create/delete/move while disabled and after re-enabling', () => {
  const f = fixture(), n = nativeCounts(f); n.plugin.initNoteCount(); f.reset(); n.metrics.enumerations = 0;
  const source = f.root.children[0], target = f.root.children[1], file = source.children.pop(), oldPath = file.path;
  file.path = target.path + '/' + file.name; file.parent = target; target.children.push(file);
  f.emit('rename', file, oldPath); f.flush();
  assert.equal(n.badge('Folder00'), '99'); assert.equal(n.badge('Folder01'), '101'); assert.equal(n.metrics.enumerations, 0);
  assert.ok(f.metrics.extensionReads < 250);
  n.plugin.settings.showNoteCount = false; target.children.pop(); file.parent = null; f.emit('delete', file); f.flush();
  n.plugin.settings.showNoteCount = true; n.plugin.initNoteCount(); assert.equal(n.badge('Folder01'), '100');
  assert.equal(f.listeners.create.length, 1, 're-enable must not duplicate native listeners');
});
test('a newly opened native view gets initial badges before future updates stay incremental', async () => {
  const f = fixture(), n = nativeCounts(f); await f.view.onOpen(); n.plugin.initNoteCount();
  const replacementItems = {};
  for (const [path, item] of Object.entries(n.items)) {
    if (!(item.file instanceof f.TFolder)) continue;
    const title = new f.Element(); title.createDiv({ cls: 'nav-folder-title-content' }); replacementItems[path] = { file: item.file, selfEl: title };
  }
  const replacementView = { fileItems: replacementItems };
  f.view.app.workspace.getLeavesOfType = () => [{ view: replacementView }];
  const folder = f.root.children[0], file = new f.TFile(folder.path + '/new.md', folder); folder.children.push(file);
  f.reset(); f.emit('create', file); f.flush();
  assert.equal(replacementItems.Folder00.selfEl.querySelector('.lucky-note-count').textContent, '101');
  assert.equal(replacementItems.Folder94.selfEl.querySelector('.lucky-note-count').textContent, '100');
  assert.ok(f.metrics.extensionReads < 500, 'new native view must still reuse shared cache');
});

test('disabled native badges still invalidate shared counts while the custom view is closed', async () => {
  const f = fixture(), plugin = new f.Plugin(), layoutCallbacks = [];
  plugin.app = f.view.app;
  plugin.loadSettings = async () => { plugin.settings = { showNoteCount: false, showCalendar: false, showFileExplorer: false, enableTagWrangler: false, focusMode: false }; };
  plugin.applyHiderClasses = () => {}; plugin.registerEvent = () => {}; plugin.addCommand = () => {};
  plugin.registerView = () => {}; plugin.addSettingTab = () => {}; plugin.addStatusBarItem = () => new f.Element(); plugin.updateReadingTime = () => {};
  plugin.app.workspace.onLayoutReady = callback => layoutCallbacks.push(callback);
  let nativeLookups = 0; plugin.app.workspace.getLeavesOfType = () => { nativeLookups++; return []; };
  await plugin.onload(); layoutCallbacks.forEach(callback => callback());
  const pluginCreateListeners = [...(f.listeners.create || [])];
  f.view.plugin = plugin; await f.view.onOpen(); const folder = f.root.children[0];
  assert.equal(f.view.getMdCount(folder), 100); await f.view.onClose();
  const file = new f.TFile(folder.path + '/while-closed.md', folder); folder.children.push(file);
  // Obsidian removes the closed ItemView's events; only plugin-owned listeners remain.
  pluginCreateListeners.forEach(callback => callback(file)); f.flush();
  const reopened = new f.view.constructor({}, plugin); reopened.app = plugin.app; await reopened.onOpen();
  assert.equal(reopened.getMdCount(folder), 101);
  assert.equal(reopened._treeEl.querySelector('.lucky-fe-count').textContent, '101');
  assert.equal(nativeLookups, 0, 'disabled native badges must not inspect or render native DOM');
  assert.equal(pluginCreateListeners.length, 1, 'one plugin listener owns shared cache invalidation across view lifetimes');
});

test('per-device icons stay in settings without changing shared code', () => {
  const f = fixture({ rootFolderIcons: { '04-Learning': 'graduation-cap', Invalid: false } });
  assert.equal(f.view.folderIcons['04-Learning'], 'graduation-cap');
  assert.equal(f.view.folderIcons['01-Work'], 'rocket');
  assert.equal(f.view.folderIcons.Invalid, undefined);
  assert.equal(Object.getPrototypeOf(f.view.folderIcons), null);
  assert.equal(f.view.folderIcons.constructor, undefined);
});
