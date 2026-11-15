'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function fixture(content, cursor, defaultPrevented = false) {
  class Empty {}
  let requests = 0;
  let prevented = false;
  const obs = {
    Plugin: Empty, PluginSettingTab: Empty, ItemView: Empty, Modal: Empty,
    SuggestModal: Empty, FuzzySuggestModal: Empty, Notice: Empty,
    requestUrl: async () => { requests++; return { status: 200, headers: { 'content-type': 'text/html', 'content-length': '100' }, text: '<title>Example</title>' }; },
  };
  const context = {
    module: { exports: {} }, require: () => obs, console, Intl, URL,
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); id.unref(); return id; },
  };
  vm.runInNewContext(fs.readFileSync(process.env.TOOLKIT_MAIN || path.join(__dirname, 'main.js'), 'utf8'), context);
  const offset = pos => content.split('\n').slice(0, pos.line).reduce((n, s) => n + s.length + 1, 0) + pos.ch;
  const editor = {
    getCursor: () => cursor,
    getLine: i => content.split('\n')[i],
    getValue: () => content,
    getRange: (from, to) => content.slice(offset(from), offset(to)),
    replaceSelection: text => { const n = offset(cursor); content = content.slice(0, n) + text + content.slice(n); },
    replaceRange: (text, from, to) => { const a = offset(from), b = offset(to); content = content.slice(0, a) + text + content.slice(b); },
    offsetToPos: n => { const lines = content.slice(0, n).split('\n'); return { line: lines.length - 1, ch: lines.at(-1).length }; },
  };
  const evt = {
    defaultPrevented, clipboardData: { getData: () => 'https://example.com' },
    preventDefault: () => { prevented = true; },
  };
  return { run: () => new context.module.exports().handlePaste(evt, editor),
    result: () => ({ content, requests, prevented }) };
}

test('an earlier paste handler retains ownership of the event', async () => {
  const f = fixture('Already pasted', { line: 0, ch: 14 }, true);
  await f.run();
  assert.deepEqual(f.result(), { content: 'Already pasted', requests: 0, prevented: false });
});

test('URLs inside fenced code remain literal without network requests', async () => {
  for (const [content, cursor] of [
    ['```js\nconst url = \n```', { line: 1, ch: 12 }],
    ['~~~~text\nurl: \n~~~\nstill code\n~~~~', { line: 3, ch: 10 }],
    ['> ```\n> url: \n> ```', { line: 1, ch: 7 }],
  ]) {
    const f = fixture(content, cursor);
    await f.run();
    assert.deepEqual(f.result(), { content, requests: 0, prevented: false });
  }
});

test('URLs inside single and multiple backtick spans remain literal', async () => {
  for (const [content, cursor] of [
    ['Use `curl `', { line: 0, ch: 10 }],
    ['Use ``code ` here``', { line: 0, ch: 16 }],
  ]) {
    const f = fixture(content, cursor);
    await f.run();
    assert.deepEqual(f.result(), { content, requests: 0, prevented: false });
  }
});

test('ordinary URL pastes after closed code retain automatic titles', async () => {
  for (const content of ['Note: ', '```text\ncode\n```\nNote: ', 'Use `code`: ', 'Literal \\` mark: ']) {
    const lines = content.split('\n');
    const f = fixture(content, { line: lines.length - 1, ch: lines.at(-1).length });
    await f.run();
    assert.deepEqual(f.result(), { content: content + '[Example](https://example.com)', requests: 2, prevented: true });
  }
});
