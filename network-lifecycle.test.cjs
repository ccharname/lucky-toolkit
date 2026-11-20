'use strict';
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync(process.env.TOOLKIT_MAIN || path.join(__dirname, 'main.js'), 'utf8');
const html = title => ({ status: 200, headers: { 'content-type': 'text/html', 'content-length': '100' }, text: '<title>' + title + '</title>' });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
class Element { addClass() {} removeClass() {} toggleClass() {} createSpan() { return new Element(); } }
function fixture(responder = () => html('Example'), options = {}) {
  const requests = [], timers = new Map(), ready = [], events = new Map(); let nextId = 0;
  const required = [];
  const app = { workspace: { on: (name, fn) => { events.set(name, fn); return {}; }, onLayoutReady: fn => ready.push(fn), detachLeavesOfType() {} } };
  class Empty {}
  class Plugin {
    constructor() { this.app = app; this._loaded = true; this._children = []; this._events = []; }
    loadData() { return Promise.resolve({}); }
    registerEvent() {} registerView() {} registerDomEvent() {} addSettingTab() {} addCommand() {}
    registerEditorExtension(extension) { this.extension = extension; this._events.push(() => { this.extension = null; }); }
    // Exact cleanup order confirmed from both live Obsidian Component implementations.
    unload() { if (!this._loaded) return; this._loaded = false; let { _children: children, _events: events } = this;
      while (children.length > 0) children.pop().unload();
      while (events.length > 0) events.pop()();
      this.onunload(); }
    addStatusBarItem() { return new Element(); }
  }
  const obs = { Plugin, PluginSettingTab: Empty, ItemView: Empty, Modal: Empty, SuggestModal: Empty, FuzzySuggestModal: Empty, Notice: Empty,
    debounce: fn => fn, setIcon() {}, requestUrl: options => { requests.push(options); return Promise.resolve(responder(options, requests.length)); } };
  const context = vm.createContext({ console: { log() {} }, Intl, URL, ...(options.mobile ? {} : { Buffer }), document: { body: new Element(), querySelectorAll: () => [] },
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id) });
  function load() {
    const m = { exports: {} };
    const loader = vm.runInContext('(function(require,module,exports){' + source + '\n})', context);
    loader(name => {
      required.push(name);
      if (name === 'obsidian') return obs;
      if (name === '@codemirror/view') {
        if (options.noCodeMirror) throw Error('CodeMirror unavailable');
        return { EditorView: { updateListener: { of: fn => fn } } };
      }
      if (options.mobile) throw Error('Mobile must not require Node: ' + name);
      return require(name);
    }, m, m.exports);
    return new m.exports();
  }
  const plugin = load();
  function editor(initial = '', cursor = { line: 0, ch: initial.length }) {
    let content = initial;
    const offset = pos => content.split('\n').slice(0, pos.line).reduce((n, s) => n + s.length + 1, 0) + pos.ch;
    return { getCursor: () => cursor, getLine: line => content.split('\n')[line], getValue: () => content,
      getRange: (a, b) => content.slice(offset(a), offset(b)),
      replaceSelection: value => { const at = offset(cursor); content = content.slice(0, at) + value + content.slice(at); },
      replaceRange: (value, from, to) => { const a = offset(from), b = offset(to); content = content.slice(0, a) + value + content.slice(b); },
      offsetToPos: at => { const lines = content.slice(0, at).split('\n'); return { line: lines.length - 1, ch: lines.at(-1).length }; },
      posToOffset: offset, setContent: value => { content = value; } };
  }
  function paste(ed, instance = plugin, url = 'https://example.com/page') {
    const evt = { defaultPrevented: false, clipboardData: { getData: () => url }, preventDefault() { this.defaultPrevented = true; } };
    return { evt, promise: instance.handlePaste(evt, ed) };
  }
  function mappedEditor(initial = '', position = 0) {
    plugin.initLinkTitleTracking();
    let cursor = position;
    const view = { state: { doc: { toString: () => initial } }, dispatch() {} };
    function change(from, to, insert) {
      const startState = view.state, before = startState.doc.toString();
      const content = before.slice(0, from) + insert + before.slice(to);
      view.state = { doc: { toString: () => content } };
      const delta = insert.length - (to - from);
      const changes = { iterChangedRanges: fn => fn(from, to), mapPos: (pos, assoc) => {
        if (pos < from || (pos === from && assoc < 0)) return pos;
        if (pos > to || (pos === to && assoc > 0)) return pos + delta;
        return from + (assoc < 0 ? 0 : insert.length);
      } };
      plugin.extension?.({ view, docChanged: true, changes, startState, state: view.state });
    }
    const ed = { cm: view, getValue: () => view.state.doc.toString(), getLine: line => ed.getValue().split('\n')[line],
      getCursor: () => ed.offsetToPos(cursor), posToOffset: pos => ed.getValue().split('\n').slice(0, pos.line).reduce((n, s) => n + s.length + 1, 0) + pos.ch,
      offsetToPos: at => { const lines = ed.getValue().slice(0, at).split('\n'); return { line: lines.length - 1, ch: lines.at(-1).length }; },
      getRange: (from, to) => ed.getValue().slice(ed.posToOffset(from), ed.posToOffset(to)),
      replaceSelection: insert => change(cursor, cursor, insert),
      replaceRange: (insert, from, to) => change(ed.posToOffset(from), ed.posToOffset(to), insert),
      change, setCursor: at => { cursor = at; } };
    return ed;
  }
  return { plugin, app, load, requests, timers, ready, events, required, editor, mappedEditor, paste, expire() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } } };
}

test('unload invalidates a pending HEAD, stops GET, and prevents late edits', async () => {
  const head = deferred(), f = fixture(o => o.method === 'HEAD' ? head.promise : html('Late'));
  const ed = f.editor(), p = f.paste(ed); await flush();
  f.plugin.onunload(); const afterUnload = ed.getValue(); head.resolve(html('Head')); await p.promise;
  assert.deepEqual(f.requests.map(r => r.method), ['HEAD']);
  assert.equal(ed.getValue(), afterUnload); assert.equal(f.timers.size, 0); assert.equal(f.plugin._linkTitleRequests, 0);
});

test('unload settles pending paste without waiting for native GET, while holding its real slot', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head'));
  const ed = f.editor(), p = f.paste(ed); await flush(); let settled = false;
  p.promise.then(() => { settled = true; }); f.plugin.onunload(); const afterUnload = ed.getValue(); await flush();
  assert.equal(settled, true); assert.equal(f.timers.size, 0); assert.equal(f.plugin._linkTitleRequests, 1);
  get.resolve(html('Late')); await p.promise; await flush(); assert.equal(ed.getValue(), afterUnload); assert.equal(f.plugin._linkTitleRequests, 0);
});

test('layout-ready work cannot reactivate an unloaded plugin', async () => {
  const f = fixture(), calls = [];
  f.plugin.applyHiderClasses = () => {}; f.plugin.initTagWrangler = () => {}; f.plugin.removeAllNoteCounts = () => {};
  for (const name of ['initNoteCount', 'activateCalendarView', 'updateReadingTime', 'activateFileExplorer']) f.plugin[name] = () => calls.push(name);
  await f.plugin.onload(); f.plugin.onunload(); f.ready.forEach(fn => fn()); assert.deepEqual(calls, []);
});

test('unload while settings are loading cannot resume plugin initialization', async () => {
  const f = fixture(), data = deferred(); f.plugin.loadData = () => data.promise;
  const loading = f.plugin.onload(); f.plugin.onunload(); data.resolve({}); await loading;
  assert.equal(f.ready.length, 0);
});

for (const [label, content, cursor] of [
  ['indented code', '    curl ', { line: 0, ch: 9 }],
  ['tab-indented code', '\tcurl ', { line: 0, ch: 6 }],
  ['space-plus-tab code', ' \tcurl ', { line: 0, ch: 7 }],
  ['quoted indented code', '>     curl ', { line: 0, ch: 11 }],
  ['quoted space-plus-tab code', '>  \tcurl ', { line: 0, ch: 9 }],
  ['multi-line inline code', 'A `code\nURL: \nend`', { line: 1, ch: 5 }],
  ['multi-line inline code with an indented middle line', 'A `code\n    middle\nURL: \nend`', { line: 2, ch: 5 }],
  ['frontmatter', '---\nurl: \n---\n', { line: 1, ch: 5 }],
]) test(label + ' retains literal URL paste without networking', async () => {
  const f = fixture(), ed = f.editor(content, cursor), p = f.paste(ed); await p.promise;
  assert.equal(p.evt.defaultPrevented, false); assert.equal(f.requests.length, 0); assert.equal(ed.getValue(), content);
});

test('deleting the owned pending range never rewrites a different same-URL placeholder', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head'));
  const ed = f.editor(), p = f.paste(ed); await flush();
  const other = 'PRE-EXISTING [获取标题中…](https://example.com/page)'; ed.setContent(other);
  get.resolve(html('Network')); await p.promise; assert.equal(ed.getValue(), other);
});

test('native admission remains capped at two across unload and module reload, including mobile-like globals', async () => {
  const held = [], f = fixture(() => { const job = deferred(); held.push(job); return job.promise; });
  const a = f.paste(f.editor()), b = f.paste(f.editor()); f.plugin.onunload();
  const reloaded = f.load(), ed = f.editor(), blocked = f.paste(ed, reloaded); await flush();
  assert.equal(f.requests.length, 2); assert.equal(blocked.evt.defaultPrevented, false); await blocked.promise;
  held.forEach(job => job.resolve(html('Late'))); await Promise.all([a.promise, b.promise]); await flush();
  const current = f.paste(f.editor(), reloaded); await flush(); assert.equal(f.requests.length, 3);
  f.expire(); await current.promise; held.at(-1).resolve(html('Late')); await flush();
});

test('CodeMirror range identity follows a prefix edit and preserves user text', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head')), ed = f.mappedEditor();
  const p = f.paste(ed); await flush(); ed.change(0, 0, 'User prefix: ');
  get.resolve(html('Title')); await p.promise; assert.equal(ed.getValue(), 'User prefix: [Title](https://example.com/page)');
});

test('CodeMirror deleting the owned range cannot claim an identical later range', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head'));
  const placeholder = '[获取标题中…](https://example.com/page)', ed = f.mappedEditor(placeholder);
  const p = f.paste(ed); await flush(); ed.change(0, placeholder.length, '');
  get.resolve(html('Title')); await p.promise; assert.equal(ed.getValue(), placeholder);
});

test('two same-URL CodeMirror operations keep separate ranges when results arrive out of order', async () => {
  const gets = [], f = fixture(o => o.method === 'HEAD' ? html('Head') : (() => { const d = deferred(); gets.push(d); return d.promise; })());
  const ed = f.mappedEditor(), first = f.paste(ed); await flush();
  ed.change(ed.getValue().length, ed.getValue().length, '\n'); ed.setCursor(ed.getValue().length);
  const second = f.paste(ed); await flush();
  gets[1].resolve(html('Second')); await second.promise; gets[0].resolve(html('First')); await first.promise;
  assert.equal(ed.getValue(), '[First](https://example.com/page)\n[Second](https://example.com/page)');
});

test('unload restores a provably owned CodeMirror loading range to the original URL', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head')), ed = f.mappedEditor();
  const p = f.paste(ed); await flush(); assert(ed.getValue().includes('获取标题中'));
  f.plugin.onunload(); await p.promise; assert.equal(ed.getValue(), 'https://example.com/page'); assert.equal(f.plugin._linkTitleRequests, 1);
  get.resolve(html('Late')); await flush(); assert.equal(ed.getValue(), 'https://example.com/page'); assert.equal(f.plugin._linkTitleRequests, 0);
  assert.equal(f.plugin._linkTitleOperations.size, 0);
});

test('a CodeMirror title timeout restores its URL while retaining native admission until settle', async () => {
  const head = deferred(), f = fixture(() => head.promise), ed = f.mappedEditor(), p = f.paste(ed);
  f.expire(); await p.promise; assert.equal(ed.getValue(), 'https://example.com/page'); assert.equal(f.plugin._linkTitleRequests, 1);
  head.resolve(html('Late')); await flush(); assert.equal(f.requests.length, 1); assert.equal(f.plugin._linkTitleRequests, 0);
  assert.equal(f.plugin._linkTitleOperations.size, 0);
});

test('disabling auto title during HEAD stops GET and cleans its owned loading range', async () => {
  const head = deferred(), f = fixture(() => head.promise), ed = f.mappedEditor(), p = f.paste(ed);
  f.plugin.settings = { autoLinkTitle: false }; head.resolve(html('Late')); await p.promise;
  assert.equal(f.requests.length, 1); assert.equal(ed.getValue(), 'https://example.com/page'); assert.equal(f.plugin._linkTitleRequests, 0);
});

test('fallback rejects changed-and-undone documents and a different file identity', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head'));
  f.plugin.initLinkTitleTracking(); const ed = f.editor(), p = f.paste(ed); await flush();
  const original = ed.getValue(); ed.setContent('Changed'); f.events.get('editor-change')(ed); ed.setContent(original);
  get.resolve(html('Title')); await p.promise; assert.equal(ed.getValue(), original);
  const next = deferred(), g = fixture(o => o.method === 'GET' ? next.promise : html('Head'));
  let file = { path: 'first.md' }; g.app.workspace.getActiveFile = () => file;
  const other = g.editor(), pending = g.paste(other); await flush(); file = { path: 'second.md' };
  next.resolve(html('Title')); await pending.promise; assert.equal(other.getValue(), 'https://example.com/page');
});

test('mobile-like module registration loads only Obsidian provided CM and needs no Node globals', async () => {
  const f = fixture(() => html('Mobile'), { mobile: true }); f.plugin.initLinkTitleTracking();
  const ed = f.editor(), p = f.paste(ed); await p.promise;
  assert.equal(ed.getValue(), '[Mobile](https://example.com/page)'); assert.deepEqual(f.required, ['obsidian', '@codemirror/view']);
});

test('missing CodeMirror support preserves original URLs after edits', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head'), { noCodeMirror: true });
  f.plugin.initLinkTitleTracking(); const ed = f.editor(), p = f.paste(ed); await flush();
  ed.setContent('Prefix ' + ed.getValue()); get.resolve(html('Title')); await p.promise;
  assert.equal(ed.getValue(), 'Prefix https://example.com/page');
});

function sidebarFixture() {
  const f = fixture();
  const detached = [], leftCalls = [], rightCalls = [], revealed = [];
  const leftSplit = { children: [{ id: 'group-1' }] };
  const leavesByType = { 'lucky-calendar': [], 'lucky-files': [] };
  const makeLeaf = () => ({
    viewState: null,
    getRoot: () => leftSplit,
    async setViewState(vs) { this.viewState = vs; },
  });
  Object.assign(f.app.workspace, {
    leftSplit,
    detachLeavesOfType: type => detached.push(type),
    getLeavesOfType: type => leavesByType[type] || [],
    getLeftLeaf: split => { leftCalls.push(split); return makeLeaf(); },
    getRightLeaf: split => { rightCalls.push(split); return makeLeaf(); },
    revealLeaf: leaf => revealed.push(leaf),
  });
  return { ...f, detached, leftCalls, rightCalls, revealed, leftSplit, leavesByType, makeLeaf };
}

test('onunload keeps sidebar views intact instead of detaching them', () => {
  const f = sidebarFixture();
  f.plugin.onunload();
  assert.deepEqual(f.detached, []);
});

test('activateCalendarView defaults to left sidebar and respects reveal option', async () => {
  const f = sidebarFixture();
  await f.plugin.activateCalendarView({ reveal: false });
  assert.deepEqual(f.leftCalls, [false]);
  assert.deepEqual(f.rightCalls, []);
  assert.deepEqual(f.revealed, []);

  const created = f.makeLeaf();
  f.leavesByType['lucky-calendar'].push(created);
  await f.plugin.activateCalendarView({ reveal: false });
  assert.equal(f.leftCalls.length, 1);
  assert.deepEqual(f.revealed, []);

  await f.plugin.activateCalendarView();
  assert.equal(f.leftCalls.length, 1);
  assert.deepEqual(f.revealed, [created]);

  const missing = sidebarFixture();
  await missing.plugin.activateCalendarView();
  assert.deepEqual(missing.leftCalls, [false]);
  assert.deepEqual(missing.rightCalls, []);
  assert.equal(missing.revealed.length, 1);
  assert.deepEqual({ ...missing.revealed[0].viewState }, { type: 'lucky-calendar', active: true });
});

test('activateFileExplorer splits below left calendar only when appropriate and respects reveal', async () => {
  const calLeaf = { getRoot: null };

  // Desktop: calendar in leftSplit and single tab group -> getLeftLeaf(true)
  const splitCase = sidebarFixture();
  calLeaf.getRoot = () => splitCase.leftSplit;
  splitCase.leavesByType['lucky-calendar'].push(calLeaf);
  await splitCase.plugin.activateFileExplorer({ reveal: false });
  assert.deepEqual(splitCase.leftCalls, [true]);
  assert.deepEqual(splitCase.revealed, []);

  // Mobile: always getLeftLeaf(false), never revealLeaf
  const mobileCase = sidebarFixture();
  mobileCase.app.isMobile = true;
  calLeaf.getRoot = () => mobileCase.leftSplit;
  mobileCase.leavesByType['lucky-calendar'].push(calLeaf);
  await mobileCase.plugin.activateFileExplorer();
  assert.deepEqual(mobileCase.leftCalls, [false]);
  assert.deepEqual(mobileCase.revealed, []);

  // Desktop with 2+ groups in leftSplit -> getLeftLeaf(false)
  const multiGroup = sidebarFixture();
  calLeaf.getRoot = () => multiGroup.leftSplit;
  multiGroup.leavesByType['lucky-calendar'].push(calLeaf);
  multiGroup.leftSplit.children.push({ id: 'group-2' });
  await multiGroup.plugin.activateFileExplorer();
  assert.deepEqual(multiGroup.leftCalls, [false]);
  assert.equal(multiGroup.revealed.length, 1);
  assert.deepEqual({ ...multiGroup.revealed[0].viewState }, { type: 'lucky-files', active: true });

  // Desktop with calendar elsewhere -> getLeftLeaf(false)
  const otherRoot = sidebarFixture();
  otherRoot.leavesByType['lucky-calendar'].push({ getRoot: () => ({ other: true }) });
  await otherRoot.plugin.activateFileExplorer();
  assert.deepEqual(otherRoot.leftCalls, [false]);

  // Existing file explorer respects reveal flag
  const existingCase = sidebarFixture();
  const feLeaf = existingCase.makeLeaf();
  existingCase.leavesByType['lucky-files'].push(feLeaf);
  await existingCase.plugin.activateFileExplorer({ reveal: false });
  assert.deepEqual(existingCase.leftCalls, []);
  assert.deepEqual(existingCase.revealed, []);
  await existingCase.plugin.activateFileExplorer();
  assert.deepEqual(existingCase.revealed, [feLeaf]);
});

test('hot-reload defers startup view activation so async restore avoids duplicates and unload cancels it', async () => {
  const f = sidebarFixture();
  f.app.workspace.layoutReady = true;
  f.app.workspace.onLayoutReady = fn => fn();
  f.plugin.initNoteCount = () => {};
  f.plugin.updateReadingTime = () => {};
  f.plugin.initTagWrangler = () => {};
  f.plugin.applyHiderClasses = () => {};

  await f.plugin.onload();
  assert.equal(f.timers.size, 2);
  assert.deepEqual(f.leftCalls, []);

  // Async view-registered restores both leaves before timer fires
  f.leavesByType['lucky-calendar'].push(f.makeLeaf());
  f.leavesByType['lucky-files'].push(f.makeLeaf());
  f.expire();
  await flush();
  assert.deepEqual(f.leftCalls, []);
  assert.deepEqual(f.rightCalls, []);
  assert.deepEqual(f.revealed, []);

  // Unload before timers fire cancels pending startup view checks
  const g = sidebarFixture();
  const calls = [];
  g.app.workspace.layoutReady = true;
  g.app.workspace.onLayoutReady = fn => fn();
  g.plugin.initNoteCount = () => {};
  g.plugin.updateReadingTime = () => {};
  g.plugin.initTagWrangler = () => {};
  g.plugin.applyHiderClasses = () => {};
  g.plugin.activateCalendarView = () => calls.push('cal');
  g.plugin.activateFileExplorer = () => calls.push('fe');

  await g.plugin.onload();
  assert.equal(g.timers.size, 2);
  g.plugin.onunload();
  assert.equal(g.timers.size, 0);
  g.expire();
  assert.deepEqual(calls, []);
});

module.exports = { fixture, html, deferred, flush };
