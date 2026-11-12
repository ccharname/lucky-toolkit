'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const target = process.env.TOOLKIT_MAIN || path.join(__dirname, 'main.js');
function loadPlugin() {
  class Empty {}
  class TFile { constructor(filePath) { this.path = filePath; this.extension = 'md'; } }
  class TFolder { constructor(filePath) { this.path = filePath; this.children = []; } }
  const obs = { Plugin: Empty, PluginSettingTab: Empty, ItemView: class { registerEvent() {} }, Modal: Empty, SuggestModal: Empty, FuzzySuggestModal: Empty, Notice: Empty, TFile, TFolder, debounce: fn => fn, getAllTags: cache => cache.allTags || [] };
  const context = { module: { exports: {} }, require: () => obs, console, Intl, URL, window: { moment: () => ({}) } };
  vm.runInNewContext(fs.readFileSync(target, 'utf8') + '\nmodule.exports.__Calendar = LuckyCalendarView;', context);
  return { Plugin: context.module.exports, TFile, TFolder };
}
async function rename(content, cache, oldTag = 'work', newTag = 'career') {
  const { Plugin, TFile } = loadPlugin();
  const plugin = new Plugin();
  const file = new TFile('test.md');
  plugin.app = { vault: { getMarkdownFiles: () => [file], process: async (_, callback) => { content = callback(content); } }, metadataCache: { getFileCache: () => ({ allTags: ['#' + oldTag], ...cache }) } };
  const changed = await plugin.replaceTagInVault(oldTag, newTag);
  return { content, changed };
}
test('rename touches the tags list without changing aliases or other YAML lists', async () => {
  const input = '---\ntags:\n  - work\n  - work/sub\naliases:\n  - work\nprojects:\n  - work\n---\nBody';
  const result = await rename(input, { tags: [] });
  assert.equal(result.content, input.replace('  - work\n  - work/sub', '  - career\n  - career/sub'));
  assert.equal(result.changed, 1);
});
test('unindented YAML tag lists stay within the tag field', async () => {
  const input = '---\ntags:\n- work\naliases:\n- work\n---\nBody';
  assert.equal((await rename(input, { tags: [] })).content, input.replace('tags:\n- work', 'tags:\n- career'));
});
test('stale metadata cannot rename a longer current tag sharing the old prefix', async () => {
  const result = await rename('#workshop', { tags: [{ tag: '#work', position: { start: { offset: 0 } } }] });
  assert.equal(result.content, '#workshop');
  assert.equal(result.changed, 0);
});
test('stale metadata cannot rename a longer nested tag sharing the cached prefix', async () => {
  const result = await rename('#work/submarine', { tags: [{ tag: '#work/sub', position: { start: { offset: 0 } } }] });
  assert.equal(result.content, '#work/submarine');
});
test('fresh inline root and nested tags change while punctuation stays unchanged', async () => {
  const input = '#work, #work/sub。';
  const result = await rename(input, { tags: [{ tag: '#work', position: { start: { offset: 0 } } }, { tag: '#work/sub', position: { start: { offset: 7 } } }] });
  assert.equal(result.content, '#career, #career/sub。');
});
test('quoted array, scalar, CRLF and dollar replacements preserve other fields', async () => {
  for (const field of ['tags: ["work", work/sub, other]', 'tags: "work"']) {
    const input = '---\r\n' + field + '\r\naliases:\r\n  - work\r\n---\r\nBody';
    const expected = input.replace(field, field.replace(/work/g, 'cost$1'));
    assert.equal((await rename(input, { tags: [] }, 'work', 'cost$1')).content, expected);
  }
});
function calendar() {
  const { Plugin, TFile, TFolder } = loadPlugin();
  const view = new Plugin.__Calendar({}, {});
  const listeners = {};
  let scans = 0, renders = 0;
  view.app = { vault: { on: (event, callback) => { listeners[event] = callback; return {}; } } };
  view.scanDailyNotes = () => { scans++; };
  view.render = () => { renders++; };
  return { view, listeners, counts: () => [scans, renders], TFile, TFolder };
}
test('unrelated vault changes do not rescan or redraw the calendar', async () => {
  const c = calendar(); await c.view.onOpen();
  for (const event of ['modify', 'create', 'delete']) c.listeners[event](new c.TFile('01-Work/unrelated.md'));
  c.listeners.rename(new c.TFolder('01-Work/new'), '01-Work/old');
  assert.deepEqual(c.counts(), [1, 1]);
});
test('daily changes and folder moves into, out of, or above Daily still refresh', async () => {
  const c = calendar(); await c.view.onOpen();
  c.listeners.modify(new c.TFile('10-Journal/Daily/2026-11/2026-11-12.md'));
  c.listeners.create(new c.TFile('10-Journal/Daily/2026-11-13.md'));
  c.listeners.delete(new c.TFolder('10-Journal/Daily/2026-10'));
  c.listeners.rename(new c.TFolder('Elsewhere/old-month'), '10-Journal/Daily/2026-10');
  c.listeners.rename(new c.TFolder('10-Journal/Daily/2026-09'), 'Elsewhere/new-month');
  c.listeners.rename(new c.TFolder('Moved-Journal'), '10-Journal');
  assert.deepEqual(c.counts(), [7, 7]);
});
