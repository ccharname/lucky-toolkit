'use strict';
// Optional integration fixture: use the host's @codemirror/state via NODE_PATH.
// No editor DOM, actual vault, or network is created.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EditorState } = require('@codemirror/state');
const { fixture, deferred, html, flush } = require('./network-lifecycle.test.cjs');
function nativeEditor(f, initial = '', position = 0) {
  f.plugin.initLinkTitleTracking();
  let cursor = position;
  const view = { state: EditorState.create({ doc: initial }), dispatch(spec) {
    const startState = view.state, transaction = startState.update(spec); view.state = transaction.state;
    f.plugin.extension?.({ view, state: view.state, startState, changes: transaction.changes, docChanged: transaction.docChanged });
  } };
  const ed = { cm: view, getValue: () => view.state.doc.toString(), getLine: line => view.state.doc.line(line + 1).text,
    getCursor: () => ed.offsetToPos(cursor), posToOffset: pos => view.state.doc.line(pos.line + 1).from + pos.ch,
    offsetToPos: pos => { const line = view.state.doc.lineAt(pos); return { line: line.number - 1, ch: pos - line.from }; },
    getRange: (from, to) => view.state.doc.sliceString(ed.posToOffset(from), ed.posToOffset(to)),
    replaceSelection: insert => view.dispatch({ changes: { from: cursor, insert } }),
    replaceRange: (insert, from, to) => view.dispatch({ changes: { from: ed.posToOffset(from), to: ed.posToOffset(to), insert } }),
    change: (from, to, insert) => view.dispatch({ changes: { from, to, insert } }), setCursor: pos => { cursor = pos; } };
  return ed;
}
test('actual CM ChangeSet maps a pending range across UTF-16 and newline prefix edits', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head')), ed = nativeEditor(f);
  const p = f.paste(ed); await flush(); ed.change(0, 0, '😀 User\n');
  get.resolve(html('Title')); await p.promise; assert.equal(ed.getValue(), '😀 User\n[Title](https://example.com/page)');
});
test('actual CM ChangeSet deletion never reassigns ownership to identical text shifted into the old range', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head'));
  const placeholder = '[获取标题中…](https://example.com/page)', ed = nativeEditor(f, placeholder);
  const p = f.paste(ed); await flush(); ed.change(0, placeholder.length, '');
  get.resolve(html('Late')); await p.promise; assert.equal(ed.getValue(), placeholder);
});
test('actual CM ChangeSets keep two identical URLs independent through reversed completion', async () => {
  const gets = [], f = fixture(o => o.method === 'HEAD' ? html('Head') : (() => { const d = deferred(); gets.push(d); return d.promise; })());
  const ed = nativeEditor(f), first = f.paste(ed); await flush(); ed.change(ed.getValue().length, ed.getValue().length, '\n'); ed.setCursor(ed.getValue().length);
  const second = f.paste(ed); await flush(); gets[1].resolve(html('Second')); await second.promise; gets[0].resolve(html('First')); await first.promise;
  assert.equal(ed.getValue(), '[First](https://example.com/page)\n[Second](https://example.com/page)');
});
test('actual CM document identity mismatch cancels rather than guessing a range', async () => {
  const get = deferred(), f = fixture(o => o.method === 'GET' ? get.promise : html('Head')), ed = nativeEditor(f);
  const p = f.paste(ed); await flush(); const listener = f.plugin.extension; f.plugin.extension = null; ed.change(0, 0, 'Not observed '); f.plugin.extension = listener;
  ed.change(0, 0, 'Next edit '); const expected = ed.getValue(); get.resolve(html('Late')); await p.promise; assert.equal(ed.getValue(), expected);
});
test('unload restores both pending placeholders in one actual CM document', async () => {
  const gets = [], f = fixture(o => o.method === 'HEAD' ? html('Head') : (() => { const d = deferred(); gets.push(d); return d.promise; })());
  const ed = nativeEditor(f), first = f.paste(ed); await flush();
  ed.change(ed.getValue().length, ed.getValue().length, '\n'); ed.setCursor(ed.getValue().length);
  const second = f.paste(ed); await flush();
  assert.equal(f.plugin._linkTitleRequests, 2);
  f.plugin.onunload(); await Promise.all([first.promise, second.promise]);
  const afterUnload = ed.getValue();
  gets.forEach(get => get.resolve(html('Late'))); await flush();
  assert.equal(afterUnload, 'https://example.com/page\nhttps://example.com/page');
  assert.equal(ed.getValue(), afterUnload, 'late native responses must not edit after cleanup');
  assert.equal(f.plugin._linkTitleRequests, 0); assert.equal(f.plugin._linkTitleOperations.size, 0);
});
test('actual Component order removes the CM extension before restoring both pending ranges', async () => {
  const gets = [], f = fixture(o => o.method === 'HEAD' ? html('Head') : (() => { const d = deferred(); gets.push(d); return d.promise; })());
  const ed = nativeEditor(f), first = f.paste(ed); await flush();
  ed.change(ed.getValue().length, ed.getValue().length, '\n'); ed.setCursor(ed.getValue().length);
  const second = f.paste(ed); await flush();
  assert.equal(f.plugin._linkTitleRequests, 2);
  f.plugin.unload(); assert.equal(f.plugin.extension, null);
  await Promise.all([first.promise, second.promise]);
  const afterUnload = ed.getValue();
  assert.equal(f.plugin._linkTitleRequests, 2, 'component cleanup must not release unresolved native slots');
  gets.forEach(get => get.resolve(html('Late'))); await flush();
  assert.equal(afterUnload, 'https://example.com/page\nhttps://example.com/page');
  assert.equal(ed.getValue(), afterUnload, 'late native results must not edit after Component cleanup');
  assert.equal(f.plugin._linkTitleRequests, 0); assert.equal(f.plugin._linkTitleOperations.size, 0);
});
