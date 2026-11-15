'use strict';

const { Plugin, PluginSettingTab, Setting, debounce, Menu, Notice, TFolder, TFile, ItemView, Modal, SuggestModal, FuzzySuggestModal, setIcon, requestUrl, getAllTags } = require('obsidian');
const CJK_RE = /[\u4e00-\u9fff]/g;
const EN_RE = /\S+/g;
const ZH_COLLATOR = new Intl.Collator('zh-CN');
const LINK_TITLE_GATES = Symbol.for('lucky-toolkit.link-title-gates.v1');

function tokenHasNonCjkChar(token) {
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (code < 0x4e00 || code > 0x9fff) {
      return true;
    }
  }
  return false;
}

function countMdInFolder(folder, cache) {
  if (!folder || !folder.children) return 0;
  const cacheKey = folder.path;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

  let count = 0;
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === 'md') {
      count++;
    } else if (child instanceof TFolder) {
      count += countMdInFolder(child, cache);
    }
  }

  if (cache) {
    cache.set(cacheKey, count);
  }
  return count;
}

// Share branch invalidation between native and custom explorers.
function invalidateMdCounts(file, oldPath, cache) {
  const isFolder = file instanceof TFolder;
  if (!isFolder && !(file instanceof TFile && file.extension === 'md') && !oldPath?.endsWith('.md')) return null;
  const affected = new Set();
  for (const path of [file.path, oldPath]) {
    if (!path) continue;
    if (isFolder) {
      affected.add(path);
      for (const key of cache.keys()) {
        if (key === path || key.startsWith(path + '/')) {
          cache.delete(key);
          affected.add(key);
          if (oldPath && path === oldPath) affected.add(file.path + key.slice(oldPath.length));
        }
      }
    }
    let folderPath = path;
    do {
      const slash = folderPath.lastIndexOf('/');
      folderPath = slash === -1 ? '/' : folderPath.slice(0, slash) || '/';
      cache.delete(folderPath);
      affected.add(folderPath);
    } while (folderPath !== '/');
  }
  return affected;
}

// ============================================================
// Default Settings
// ============================================================

const DEFAULT_SETTINGS = {
  // Beautify: Typography & Visual Enhancement
  enableBeautify: true,
  // Feature 1: Hider
  hideScroll: true,
  hidePropertiesReading: true,
  hideVault: true,
  // Feature 2: Tab Manager
  preventDuplicateTabs: true,
  maxTabs: 0,  // 0 = unlimited
  // Feature 3: Note Count
  showNoteCount: true,
  // Feature 4: Tag Wrangler
  enableTagWrangler: true,
  // Feature 5: Calendar View
  showCalendar: true,
  // Feature 6: Auto Link Title
  autoLinkTitle: true,
  // Feature 7: Reading Time
  showReadingTime: true,
  // Feature 8: Focus Mode
  focusMode: false,
  // Feature 12: File Explorer
  showFileExplorer: true,
  rootFolderIcons: {},
};

// ============================================================
// Main Plugin Class
// ============================================================

class LuckyToolkit extends Plugin {
  async onload() {
    console.log('Loading Lucky Toolkit');
    this._linkTitleUnloaded = false;
    await this.loadSettings();
    if (this._linkTitleUnloaded) return;
    this._noteCountCache = new Map();

    // --- Feature 1: Hider — apply CSS classes based on settings ---
    this.applyHiderClasses();

    // --- Feature 2: Tab Manager ---
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!file) return;
        if (this.settings.preventDuplicateTabs) {
          this.deduplicateTabs(file);
        }
        if (this.settings.maxTabs > 0) {
          this.enforceTabLimit();
        }
      })
    );
    this.addCommand({
      id: 'close-other-tabs',
      name: '关闭其他标签页',
      callback: () => this.closeOtherTabs(),
    });

    // --- Feature 3: Note Count — badges on folders ---
    this.app.workspace.onLayoutReady(() => {
      if (!this._linkTitleUnloaded) this.initNoteCount();
    });

    // --- Feature 4: Tag Wrangler — context menu on tag pane ---
    if (this.settings.enableTagWrangler) {
      this.initTagWrangler();
    }

    // --- Feature 5: Calendar View ---
    this.registerView(CALENDAR_VIEW_TYPE, (leaf) => new LuckyCalendarView(leaf, this));
    this.addCommand({
      id: 'open-lucky-calendar',
      name: '打开日历',
      callback: () => this.activateCalendarView(),
    });
    this.app.workspace.onLayoutReady(() => {
      if (!this._linkTitleUnloaded && this.settings.showCalendar) {
        this.activateCalendarView();
      }
    });

    // --- Feature 6: Auto Link Title ---
    this.initLinkTitleTracking();
    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt, editor) => {
        if (!this.settings.autoLinkTitle) return;
        this.handlePaste(evt, editor);
      })
    );

    // --- Settings Tab ---
    this.addSettingTab(new LuckyToolkitSettingTab(this.app, this));

    // --- Feature 7: Reading Time ---
    this.readingTimeEl = this.addStatusBarItem();
    this.readingTimeEl.addClass('lucky-reading-time');
    const iconSpan = this.readingTimeEl.createSpan({ cls: 'lucky-reading-time-icon' });
    setIcon(iconSpan, 'clock');
    this.readingTimeTextEl = this.readingTimeEl.createSpan({ cls: 'lucky-reading-time-text' });
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.updateReadingTime())
    );
    this.registerEvent(
      this.app.workspace.on('editor-change', debounce(() => { this._readingTimeDirty = true; this.updateReadingTime(); }, 800, true))
    );
    this.app.workspace.onLayoutReady(() => { if (!this._linkTitleUnloaded) this.updateReadingTime(); });

    // --- Feature 8: Focus Mode ---
    if (this.settings.focusMode) {
      document.body.addClass('lucky-focus-mode');
    }
    this.addCommand({
      id: 'toggle-focus-mode',
      name: '切换焦点模式',
      callback: () => {
        this.settings.focusMode = !this.settings.focusMode;
        document.body.toggleClass('lucky-focus-mode', this.settings.focusMode);
        this.saveSettings();
        new Notice(this.settings.focusMode ? '焦点模式已开启' : '焦点模式已关闭', 1500);
      },
    });

    // --- Feature 12: File Explorer ---
    this.registerView(FILE_EXPLORER_VIEW_TYPE, (leaf) => new LuckyFileExplorer(leaf, this));
    this.addCommand({
      id: 'open-lucky-files',
      name: '打开文件列表',
      callback: () => this.activateFileExplorer(),
    });
    this.app.workspace.onLayoutReady(() => {
      if (!this._linkTitleUnloaded && this.settings.showFileExplorer) {
        this.activateFileExplorer();
      }
    });

    // --- Feature 9: Recent Files ---
    this.addCommand({
      id: 'recent-files',
      name: '最近编辑的文件',
      callback: () => new RecentFilesModal(this.app).open(),
    });

    // --- Feature 10: Orphan Notes ---
    this.addCommand({
      id: 'find-orphan-notes',
      name: '查找孤儿笔记',
      callback: () => this.findOrphanNotes(),
    });
  }

  onunload() {
    console.log('Unloading Lucky Toolkit');
    this._linkTitleUnloaded = true;
    for (const operation of this._linkTitleOperations || []) {
      this.replaceLinkTitleOperation(operation, operation.url, true);
      operation.cancelled = true;
      globalThis.clearTimeout?.(operation.timeoutId);
      operation.cancelWait?.();
      operation.editor = null;
      operation.view = null;
      operation.doc = null;
      operation.snapshot = null;
      operation.ownerView = null;
      operation.file = null;
    }
    this._linkTitleOperations?.clear();
    // Remove hider classes
    document.body.removeClass('lucky-hide-scroll', 'lucky-hide-meta', 'lucky-hide-vault', 'lucky-beautify');
    // Remove note count badges
    this._refreshNoteCounts?.cancel();
    this._pendingNoteCountPaths?.clear();
    this.removeAllNoteCounts();
    // Detach calendar view
    this.app.workspace.detachLeavesOfType(CALENDAR_VIEW_TYPE);
    // Detach file explorer view
    this.app.workspace.detachLeavesOfType(FILE_EXPLORER_VIEW_TYPE);
    // Remove focus mode class
    document.body.removeClass('lucky-focus-mode');
  }

  // ============================================================
  // Settings persistence
  // ============================================================

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ============================================================
  // Feature 1: Hider
  // ============================================================

  applyHiderClasses() {
    document.body.toggleClass('lucky-hide-scroll', !!this.settings.hideScroll);
    document.body.toggleClass('lucky-hide-meta', !!this.settings.hidePropertiesReading);
    document.body.toggleClass('lucky-hide-vault', !!this.settings.hideVault);
    document.body.toggleClass('lucky-beautify', !!this.settings.enableBeautify);
  }

  // ============================================================
  // Feature 2: Tab Manager — Deduplicate Tabs
  // ============================================================

  deduplicateTabs(file) {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (!activeLeaf) return;

    const filePath = file.path;
    let existingLeaf = null;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (existingLeaf) return; // early exit
      if (leaf === activeLeaf) return;
      if (leaf.getRoot() !== this.app.workspace.rootSplit) return; // only main area
      const leafFile = leaf.view && leaf.view.file;
      if (leafFile && leafFile.path === filePath) {
        existingLeaf = leaf;
      }
    });

    if (existingLeaf) {
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      activeLeaf.detach();
      new Notice('已聚焦已有标签页', 1500);
    }
  }

  enforceTabLimit() {
    const maxTabs = this.settings.maxTabs;
    if (maxTabs <= 0) return;

    const leaves = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.getRoot() === this.app.workspace.rootSplit && leaf.view && leaf.view.file) {
        leaves.push(leaf);
      }
    });

    // Close oldest leaves (first in list) until within limit
    while (leaves.length > maxTabs) {
      const oldest = leaves.shift();
      if (oldest !== this.app.workspace.activeLeaf) {
        oldest.detach();
      }
    }
  }

  closeOtherTabs() {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (!activeLeaf) return;
    const toClose = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === activeLeaf) return;
      if (leaf.getRoot() !== this.app.workspace.rootSplit) return;
      toClose.push(leaf);
    });
    toClose.forEach((leaf) => leaf.detach());
    if (toClose.length > 0) {
      new Notice(`已关闭 ${toClose.length} 个标签页`, 1500);
    }
  }

  // ============================================================
  // Feature 3: Note Count
  // ============================================================

  initNoteCount() {
    this.updateAllNoteCounts();

    // Register vault listeners once — settings toggle may call this again
    if (this._noteCountInited) return;
    this._noteCountInited = true;

    this._pendingNoteCountPaths = new Set();
    this._refreshNoteCounts = debounce(() => {
      const paths = [...this._pendingNoteCountPaths];
      this._pendingNoteCountPaths.clear();
      this.updateAllNoteCounts(paths);
    }, 1000, true);
    const onChange = (file, oldPath) => {
      const paths = invalidateMdCounts(file, oldPath, this._noteCountCache);
      if (!paths) return;
      for (const path of paths) this._pendingNoteCountPaths.add(path);
      this._refreshNoteCounts();
    };
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));
    this.registerEvent(this.app.vault.on('rename', onChange));
  }

  /**
   * Count .md files recursively in a TFolder
   */
  countMdFiles(folder) {
    return countMdInFolder(folder, this._noteCountCache);
  }

  /**
   * Get the file explorer view (first one found)
   */
  getFileExplorerView() {
    const leaves = this.app.workspace.getLeavesOfType('file-explorer');
    if (leaves.length === 0) return null;
    return leaves[0].view;
  }

  /**
   * Update note count badges on all folders in the file explorer
   */
  updateAllNoteCounts(paths) {
    if (!this.settings.showNoteCount) return;

    const view = this.getFileExplorerView();
    if (!view || !view.fileItems) return;

    this._countedNativeViews ||= new WeakSet();
    const knownView = this._countedNativeViews.has(view);
    this._countedNativeViews.add(view);
    const items = paths && knownView ? paths.map(path => view.fileItems[path]).filter(Boolean) : Object.values(view.fileItems);
    for (const item of items) {
      // item.file is a TAbstractFile; only process folders
      if (!(item.file instanceof TFolder)) continue;

      const count = countMdInFolder(item.file, this._noteCountCache);
      const titleEl = item.selfEl;
      if (!titleEl) continue;

      // Find or create the badge element
      let badge = titleEl.querySelector('.lucky-note-count');
      if (!badge) {
        // Append badge inside the folder title content element
        const titleContent = titleEl.querySelector('.nav-folder-title-content');
        if (!titleContent) continue;
        badge = titleContent.createEl('span', { cls: 'lucky-note-count' });
      }
      badge.textContent = count > 0 ? String(count) : '';
    }
  }

  /**
   * Remove all note count badges (for cleanup on unload or toggle off)
   */
  removeAllNoteCounts() {
    const badges = document.querySelectorAll('.lucky-note-count');
    badges.forEach((el) => el.remove());
  }

  // ============================================================
  // Feature 4: Tag Wrangler
  // ============================================================

  initTagWrangler() {
    // Register context menu on the tag pane via DOM event delegation
    // Approach inspired by tag-wrangler: listen for contextmenu on .tag-pane-tag elements
    this.registerDomEvent(document, 'contextmenu', (evt) => {
      if (!(evt.target instanceof HTMLElement)) return;
      if (!evt.target.closest('.tag-pane-tag')) return;
      if (!this.settings.enableTagWrangler) return;

      const tagEl = evt.target.closest('.tag-pane-tag');
      if (!tagEl) return;

      // Find the tag text element
      const tagTextEl = tagEl.querySelector(
        '.tag-pane-tag-text, .tree-item-inner-text'
      );
      if (!tagTextEl) return;

      const tagName = tagTextEl.textContent;
      if (!tagName) return;

      // Build context menu
      const menu = new Menu();

      menu.addItem((item) => {
        item
          .setTitle('重命名标签: #' + tagName)
          .setIcon('pencil')
          .onClick(() => this.renameTag(tagName));
      });

      menu.addItem((item) => {
        item
          .setTitle('合并标签到…')
          .setIcon('merge')
          .onClick(() => this.mergeTag(tagName));
      });

      menu.showAtPosition({ x: evt.pageX, y: evt.pageY });
      evt.preventDefault();
    }, { capture: true });
  }

  /**
   * Rename a tag across the vault.
   * Prompts for a new name, then replaces all occurrences in file content.
   */
  async renameTag(oldTag) {
    oldTag = oldTag.replace(/^#/, '');

    // Preview: count affected files first
    const affectedCount = await this.countTagOccurrences(oldTag);

    const newTag = await this.promptForTag(
      `重命名 #${oldTag}`,
      `将影响 ${affectedCount} 个文件。输入新标签名（不含 #）：`,
      oldTag
    );
    if (!newTag || newTag === oldTag) {
      if (!newTag) return;
      new Notice('标签名未变更。');
      return;
    }

    const count = await this.replaceTagInVault(oldTag, newTag);
    new Notice(`已将 #${oldTag} 重命名为 #${newTag}，共 ${count} 个文件。`);
  }

  async mergeTag(sourceTag) {
    sourceTag = sourceTag.replace(/^#/, '');

    const affectedCount = await this.countTagOccurrences(sourceTag);

    const targetTag = await this.promptForTag(
      `合并 #${sourceTag}`,
      `将影响 ${affectedCount} 个文件。输入目标标签名（不含 #）：`,
      ''
    );
    if (!targetTag) return;
    if (targetTag === sourceTag) {
      new Notice('源标签和目标标签相同，未做更改。');
      return;
    }

    const count = await this.replaceTagInVault(sourceTag, targetTag);
    new Notice(`已将 #${sourceTag} 合并到 #${targetTag}，共 ${count} 个文件。`);
  }

  /**
   * Candidate files containing #tag (or a nested #tag/child), resolved from
   * metadataCache — no file reads. Covers inline tags and all frontmatter forms.
   */
  getTagCandidateFiles(tag) {
    const prefix = '#' + tag;
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) return false;
      const tags = getAllTags(cache);
      return !!tags && tags.some((t) => t === prefix || t.startsWith(prefix + '/'));
    });
  }

  countTagOccurrences(tag) {
    return this.getTagCandidateFiles(tag).length;
  }

  /**
   * Prompt modal using Obsidian's native Modal class.
   */
  promptForTag(title, message, defaultValue) {
    return new Promise((resolve) => {
      const modal = new TagPromptModal(this.app, title, message, defaultValue, resolve);
      modal.open();
    });
  }

  /**
   * Replace all occurrences of oldTag with newTag across the vault.
   * Handles both inline #tags and frontmatter tags arrays.
   * Returns the number of files modified.
   */
  async replaceTagInVault(oldTag, newTag) {
    if (this._tagOpBusy) { new Notice('标签操作进行中，请稍候…'); return 0; }
    this._tagOpBusy = true;
    let filesModified = 0;
    // Only touch files whose metadata cache actually contains the tag
    const files = this.getTagCandidateFiles(oldTag);

    try {
      const oldTagEscaped = oldTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // '$' is special in String.replace replacement strings ($1/$&/$$) — escape it
      const newTagSafe = newTag.replace(/\$/g, '$$$$');
      // Frontmatter forms — applied ONLY inside the leading --- block. The
      // (?:/…)? tails carry nested children: renaming `work` updates `work/sub`.
      const fmListRegex = new RegExp('(^\\s*-\\s+["\']?)' + oldTagEscaped + '((?:/[^"\'\\r\\n]*)?["\']?\\s*$)', 'gm');
      const fmScalarRegex = new RegExp('(^[Tt]ags?:\\s*["\']?)' + oldTagEscaped + '((?:/[^"\'\\r\\n]*)?["\']?\\s*$)', 'm');
      const fmArrayLineRegex = /^([Tt]ags?:\s*\[)([^\]]*)(\].*)$/m;
      const fmTokenRegex = new RegExp('^(["\']?)' + oldTagEscaped + '((?:/.*)?)(["\']?)$');
      const hashOld = '#' + oldTag;

      for (const file of files) {
        // Inline tags come from the metadata cache's position table — the parser
        // records only REAL tags, so code blocks and URL anchors are never touched
        const cache = this.app.metadataCache.getFileCache(file);
        const inlineTags = (cache && cache.tags) ? cache.tags : [];
        let changed = false;
        await this.app.vault.process(file, (content) => {
          let newContent = content;
          // Inline first (offsets refer to pristine content), back-to-front so
          // earlier offsets stay valid; slice-check guards against a stale cache
          for (let i = inlineTags.length - 1; i >= 0; i--) {
            const t = inlineTags[i];
            if (t.tag !== hashOld && !t.tag.startsWith(hashOld + '/')) continue;
            const start = t.position.start.offset;
            const end = start + hashOld.length; // only the '#old' prefix — keeps '/child'
            const tagEnd = start + t.tag.length;
            if (newContent.slice(start, tagEnd) !== t.tag) continue;
            if (/^[\p{L}\p{M}\p{N}_/-]/u.test(newContent.slice(tagEnd))) continue;
            newContent = newContent.slice(0, start) + '#' + newTag + newContent.slice(end);
          }
          const fmMatch = newContent.match(/^---\r?\n[\s\S]*?\r?\n---/);
          if (fmMatch) {
            // List values in aliases or other YAML properties are not tags.
            const fm = fmMatch[0]
              .replace(/^[Tt]ags?:[^\r\n]*(?:\r?\n(?:[ \t]+[^\r\n]*|-[ \t]+[^\r\n]*|[ \t]*(?:#[^\r\n]*)?))*/gm,
                (field) => field.replace(fmListRegex, '$1' + newTagSafe + '$2'))
              .replace(fmScalarRegex, '$1' + newTagSafe + '$2')
              .replace(fmArrayLineRegex, (line, pre, body, post) =>
                pre + body.split(',').map((tok) => {
                  const m = tok.trim().match(fmTokenRegex);
                  return m ? tok.replace(tok.trim(), () => m[1] + newTag + m[2] + m[3]) : tok;
                }).join(',') + post
              );
            newContent = fm + newContent.slice(fmMatch[0].length);
          }
          changed = newContent !== content;
          return newContent;
        });
        if (changed) filesModified++;
      }
    } catch (e) {
      console.error('Lucky Toolkit: 标签替换失败', e);
      new Notice('标签替换出错: ' + e.message);
    } finally {
      this._tagOpBusy = false;
    }

    return filesModified;
  }

  // ============================================================
  // Feature 5: Calendar View — activate helper
  // ============================================================

  async activateCalendarView() {
    const existing = this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE);
    if (existing.length > 0) {
      if (!this.app.isMobile) this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: CALENDAR_VIEW_TYPE, active: true });
    if (!this.app.isMobile) this.app.workspace.revealLeaf(leaf);
  }

  // ============================================================
  // Feature 12: File Explorer — activate helper
  // ============================================================

  async activateFileExplorer() {
    const existing = this.app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE);
    if (existing.length > 0) {
      if (!this.app.isMobile) this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: FILE_EXPLORER_VIEW_TYPE, active: true });
    if (!this.app.isMobile) this.app.workspace.revealLeaf(leaf);
  }

  // ============================================================
  // Feature 6: Auto Link Title — paste handler
  // ============================================================

  getLinkTitleGate() {
    let gates = globalThis[LINK_TITLE_GATES];
    if (!gates) {
      gates = new WeakMap();
      Object.defineProperty(globalThis, LINK_TITLE_GATES, { value: gates });
    }
    const owner = this.app && typeof this.app === 'object' ? this.app : this;
    let gate = gates.get(owner);
    if (!gate) { gate = { active: 0 }; gates.set(owner, gate); }
    return gate;
  }

  isLinkTitleOperationActive(operation) {
    return !this._linkTitleUnloaded && !operation.cancelled && !operation.timedOut && this.settings?.autoLinkTitle !== false;
  }

  initLinkTitleTracking() {
    this._linkTitleRangeMapping = false;
    try {
      if (typeof this.registerEditorExtension === 'function') {
        const { EditorView } = require('@codemirror/view');
        this.registerEditorExtension(EditorView.updateListener.of(update => this.updateLinkTitleRanges(update)));
        this._linkTitleRangeMapping = true;
      }
    } catch (_) { /* Editors without CodeMirror use a conservative original-URL fallback. */ }
    this.registerEvent(this.app.workspace.on('editor-change', (editor) => {
      for (const operation of this._linkTitleOperations || []) {
        if (!operation.view && operation.editor === editor && !operation.replacing) {
          operation.cancelled = true;
          operation.cancelWait?.();
        }
      }
    }));
  }

  updateLinkTitleRanges(update) {
    if (!update.docChanged) return;
    // A synchronous owned unload cleanup must also map the other pending ranges.
    if (this._linkTitleUnloaded && ![...(this._linkTitleOperations || [])].some(operation =>
      operation.view === update.view && operation.replacing)) return;
    for (const operation of this._linkTitleOperations || []) {
      if (operation.view !== update.view || operation.replacing || operation.cancelled) continue;
      if (update.startState && operation.doc !== update.startState.doc) {
        operation.cancelled = true;
        operation.cancelWait?.();
        continue;
      }
      let touched = false;
      update.changes.iterChangedRanges((from, to) => {
        if ((from < operation.toOffset && to > operation.fromOffset) ||
            (from === to && from > operation.fromOffset && from < operation.toOffset)) touched = true;
      });
      if (touched) {
        operation.cancelled = true;
        operation.cancelWait?.();
        continue;
      }
      operation.fromOffset = update.changes.mapPos(operation.fromOffset, 1);
      operation.toOffset = update.changes.mapPos(operation.toOffset, -1);
      operation.doc = update.state.doc;
    }
  }

  replaceLinkTitleOperation(operation, replacement, allowUnloading = false) {
    if (operation.cancelled || !operation.editor || (this._linkTitleUnloaded && !allowUnloading)) return false;
    const editor = operation.editor;
    try {
      if (operation.file && (operation.ownerView ? operation.ownerView.file !== operation.file :
          this.app.workspace.getActiveFile?.() !== operation.file)) return false;
      if (operation.view) {
        if (operation.view.state.doc !== operation.doc) return false;
      } else {
        if (editor.getValue() !== operation.snapshot) return false;
      }
      const from = editor.offsetToPos(operation.fromOffset);
      const to = editor.offsetToPos(operation.toOffset);
      if (editor.getRange(from, to) !== operation.placeholder) return false;
      const cleanupDoc = allowUnloading && operation.view ? operation.view.state.doc : null;
      const cleanupText = cleanupDoc ? cleanupDoc.toString() : null;
      operation.replacing = true;
      if (replacement !== operation.placeholder) editor.replaceRange(replacement, from, to);
      if (cleanupDoc && replacement !== operation.placeholder) {
        // Component removes editor extensions before onunload. Map only this verified
        // synchronous edit, and skip ranges an installed tracker has already mapped.
        const nextDoc = operation.view.state.doc;
        const expected = cleanupText.slice(0, operation.fromOffset) + replacement + cleanupText.slice(operation.toOffset);
        if (nextDoc.toString() === expected) {
          const delta = replacement.length - (operation.toOffset - operation.fromOffset);
          for (const pending of this._linkTitleOperations || []) {
            if (pending === operation || pending.view !== operation.view || pending.cancelled || pending.doc !== cleanupDoc) continue;
            if (cleanupText.slice(pending.fromOffset, pending.toOffset) !== pending.placeholder) continue;
            if (pending.fromOffset >= operation.toOffset) {
              pending.fromOffset += delta;
              pending.toOffset += delta;
            } else if (pending.toOffset > operation.fromOffset) {
              pending.cancelled = true;
              pending.cancelWait?.();
              continue;
            }
            pending.doc = nextDoc;
          }
        }
      }
      return true;
    } catch (_) { return false; }
    finally { operation.replacing = false; }
  }

  isSmallHtmlResponse(response, requireLength = true) {
    if (!response || !(response.status >= 200 && response.status < 300)) return false;
    const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'text/html' && type !== 'application/xhtml+xml') return false;
    const length = String(headers['content-length'] || '').trim();
    if (requireLength && !/^\d+$/.test(length)) return false;
    if (length && (!/^\d+$/.test(length) || Number(length) > 512 * 1024)) return false;
    return !response.arrayBuffer || response.arrayBuffer.byteLength <= 512 * 1024;
  }

  async fetchLinkTitleResponse(url, operation) {
    const gate = this.getLinkTitleGate();
    if (gate.active >= 2 || !this.isLinkTitleOperationActive(operation)) return null;
    gate.active++;
    this._linkTitleRequests = (this._linkTitleRequests || 0) + 1;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Encoding': 'identity',
    };
    try {
      const head = await requestUrl({ url, method: 'HEAD', headers, throw: false });
      if (!this.isLinkTitleOperationActive(operation) || !this.isSmallHtmlResponse(head)) return null;
      const response = await requestUrl({ url, method: 'GET', headers: { ...headers, 'Range': 'bytes=0-524287' }, throw: false });
      if (!this.isLinkTitleOperationActive(operation) || !this.isSmallHtmlResponse(response)) return null;
      return response;
    } finally {
      this._linkTitleRequests--;
      gate.active--;
    }
  }

  isCodePosition(editor, cursor) {
    let fence = null;
    let delimiter = null;
    let frontmatter = /^\uFEFF?---\s*$/.test(editor.getLine(0));
    for (let line = 0; line <= cursor.line; line++) {
      const text = editor.getLine(line);
      if (frontmatter) {
        if (line === cursor.line) return true;
        if (line > 0 && /^(?:---|\.\.\.)\s*$/.test(text)) frontmatter = false;
        continue;
      }
      const unquoted = text.replace(/^(?: {0,3}>[ \t]?)+/, '');
      const match = unquoted.match(/^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/);
      if (match) {
        delimiter = null;
        const marker = match[1];
        if (fence) {
          if (marker[0] === fence[0] && marker.length >= fence.length && /^\s*$/.test(match[2])) fence = null;
        } else if (marker[0] !== '`' || !match[2].includes('`')) {
          fence = marker;
        }
        if (line === cursor.line) return true;
        continue;
      }
      if (fence) { if (line === cursor.line) return true; continue; }
      if (!delimiter && /^(?: {4}| {0,3}\t)/.test(unquoted)) {
        if (line === cursor.line) return true;
        continue;
      }
      if (!text.trim()) delimiter = null;
      const prefix = line === cursor.line ? text.slice(0, cursor.ch) : text;
      for (const token of prefix.matchAll(/(\\*)(`+)/g)) {
        if (token[1].length % 2 && !delimiter) continue;
        if (!delimiter) delimiter = token[2];
        else if (token[2] === delimiter) delimiter = null;
      }
      if (line === cursor.line) return delimiter !== null;
    }
    return false;
  }

  async handlePaste(evt, editor) {
    if (this._linkTitleUnloaded || evt.defaultPrevented) return;
    const clipboardData = evt.clipboardData;
    if (!clipboardData) return;
    const text = clipboardData.getData('text/plain').trim();
    if (!text) return;

    // Check if it's a URL
    if (!/^https?:\/\/\S+$/.test(text)) return;

    const cursor = editor.getCursor('from');
    if (this.isCodePosition(editor, cursor)) return;
    if (this.getLinkTitleGate().active >= 2) return;
    try {
      if (/\.(?:7z|avi|bin|bmp|bz2|docx?|dmg|exe|flac|gif|gz|heic|ico|jpe?g|m4a|mkv|mov|mp3|mp4|ogg|pdf|png|pptx?|rar|tar|tgz|tiff?|wav|webm|webp|woff2?|xlsx?|xz|zip)$/i.test(new URL(text).pathname)) return;
    } catch (_) { return; }

    // Prevent default paste
    evt.preventDefault();

    // Insert loading placeholder. getCursor('from') = selection START — with an
    // active selection, plain getCursor() returns the head (possibly the end),
    // which is not where replaceSelection() inserts.
    const candidateView = this._linkTitleRangeMapping && editor.cm;
    const view = candidateView?.state?.doc && typeof candidateView.dispatch === 'function' ? candidateView : null;
    const placeholder = view ? '[获取标题中…](' + text + ')' : text;
    const fromOffset = typeof editor.posToOffset === 'function' ? editor.posToOffset(cursor) :
      editor.getValue().split('\n').slice(0, cursor.line).reduce((length, line) => length + line.length + 1, 0) + cursor.ch;
    editor.replaceSelection(placeholder);
    const ownerView = (this.app?.workspace?.getLeavesOfType?.('markdown') || []).find(leaf => leaf.view?.editor === editor)?.view;
    const operation = { id: Symbol('link-title'), url: text, editor, view, doc: view?.state.doc,
      placeholder, fromOffset, toOffset: fromOffset + placeholder.length,
      snapshot: view ? null : editor.getValue(), ownerView,
      file: ownerView?.file || this.app?.workspace?.getActiveFile?.(), timedOut: false, cancelled: false };
    (this._linkTitleOperations || (this._linkTitleOperations = new Set())).add(operation);
    const replacePlaceholder = replacement => this.replaceLinkTitleOperation(operation, replacement);
    const fetchTitle = this.fetchLinkTitleResponse(text, operation);
    const timeout = new Promise((resolve, reject) => {
      operation.cancelWait = () => resolve(null);
      operation.timeoutId = setTimeout(() => { operation.timedOut = true; reject(new Error('timeout')); }, 5000);
    });
    try {
      const response = await Promise.race([fetchTitle, timeout]);
      if (!this.isLinkTitleOperationActive(operation)) { replacePlaceholder(text); return; }
      const html = this.decodeResponseBody(response);
      if (html.length > 512 * 1024) { replacePlaceholder(text); return; }
      let title = '';
      const ogMatch = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["']/i);
      if (ogMatch && ogMatch[1]) {
        title = ogMatch[1];
      } else {
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch && titleMatch[1]) title = titleMatch[1];
      }
      if (title.trim()) {
        title = this.decodeHtmlEntities(title).replace(/\s+/g, ' ').trim().replace(/[\[\]]/g, '');
        title = this.stripSiteSuffix(title, text);
        replacePlaceholder('[' + title + '](' + text + ')');
      } else {
        replacePlaceholder(text);
      }
    } catch (e) {
      replacePlaceholder(text);
      console.log('Lucky Toolkit: 获取标题失败', text, e);
    } finally {
      globalThis.clearTimeout?.(operation.timeoutId);
      this._linkTitleOperations.delete(operation);
      operation.editor = null;
      operation.view = null;
      operation.doc = null;
      operation.snapshot = null;
      operation.ownerView = null;
      operation.file = null;
      operation.cancelWait = null;
    }
  }

  stripSiteSuffix(title, url) {
    // Strip trailing "_站名" / " - 站名" / " | 站名" patterns. Site list keyed
    // by hostname so we only trim suffixes the site actually uses.
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return title; }
    const rules = [
      { match: /(^|\.)bilibili\.com$/, suffixes: ['_哔哩哔哩_bilibili', '_哔哩哔哩bilibili', '_哔哩哔哩'] },
      { match: /(^|\.)youtube\.com$/, suffixes: ['- YouTube'] },
      { match: /(^|\.)zhihu\.com$/, suffixes: ['- 知乎'] },
      { match: /(^|\.)douban\.com$/, suffixes: ['(豆瓣)'] },
      { match: /(^|\.)weixin\.qq\.com$/, suffixes: [] },
      { match: /(^|\.)github\.com$/, suffixes: [] },
    ];
    const seps = /[\s\-—–|｜·_]+$/;
    for (const r of rules) {
      if (!r.match.test(host)) continue;
      for (const suf of r.suffixes) {
        if (title.endsWith(suf)) {
          title = title.slice(0, -suf.length).replace(seps, '').trim();
          break;
        }
      }
    }
    return title;
  }

  decodeResponseBody(response) {
    if (!response) return '';
    const headers = response.headers || {};
    const enc = String(headers['content-encoding'] || headers['Content-Encoding'] || '').toLowerCase();
    const ab = response.arrayBuffer;
    if (ab && ab.byteLength > 512 * 1024) return '';
    if (ab) {
      try {
        const zlib = require('zlib');
        const buf = Buffer.from(ab);
        const isGzipMagic = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
        if (enc.includes('br')) return zlib.brotliDecompressSync(buf, { maxOutputLength: 512 * 1024 }).toString('utf-8');
        if (enc.includes('gzip') || isGzipMagic) return zlib.gunzipSync(buf, { maxOutputLength: 512 * 1024 }).toString('utf-8');
        if (enc.includes('deflate')) {
          try { return zlib.inflateSync(buf, { maxOutputLength: 512 * 1024 }).toString('utf-8'); }
          catch (_) { return zlib.inflateRawSync(buf, { maxOutputLength: 512 * 1024 }).toString('utf-8'); }
        }
        return buf.toString('utf-8');
      } catch (_) {
        // fall through to .text
      }
    }
    return typeof response.text === 'string' && response.text.length <= 512 * 1024 ? response.text : '';
  }

  decodeHtmlEntities(s) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] || m);
  }

  // ============================================================
  // Feature 7: Reading Time
  // ============================================================

  updateReadingTime() {
    if (!this.settings.showReadingTime) {
      this.readingTimeTextEl.setText('');
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      this.readingTimeTextEl.setText('');
      this._readingTimeCache = null;
      return;
    }
    // Cache: skip re-read if same file and editor hasn't changed
    if (this._readingTimeCache && this._readingTimeCache.path === file.path && !this._readingTimeDirty) {
      return;
    }
    this._readingTimeDirty = false;
    this.app.vault.cachedRead(file).then((text) => {
      // Drop stale results: user may have switched files before this resolved
      if (this.app.workspace.getActiveFile()?.path !== file.path) return;
      // Chinese: ~400 chars/min, English: ~200 words/min
      let chineseChars = 0;
      let englishWords = 0;

      CJK_RE.lastIndex = 0;
      while (CJK_RE.exec(text) !== null) {
        chineseChars++;
      }

      EN_RE.lastIndex = 0;
      let wordMatch;
      while ((wordMatch = EN_RE.exec(text)) !== null) {
        if (tokenHasNonCjkChar(wordMatch[0])) {
          englishWords++;
        }
      }

      const minutes = Math.ceil(chineseChars / 400 + englishWords / 200);
      const display = minutes < 1 ? '< 1 min' : minutes + ' min';
      this.readingTimeTextEl.setText(display);
      this._readingTimeCache = { path: file.path };
    }).catch(() => {
      if (this.app.workspace.getActiveFile()?.path !== file.path) return;
      this.readingTimeTextEl.setText('');
      this._readingTimeCache = null;
    });
  }

  // ============================================================
  // Feature 10: Orphan Notes
  // ============================================================

  findOrphanNotes() {
    // Build set of all referenced file paths
    const referenced = new Set();
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    for (const sourcePath in resolvedLinks) {
      for (const targetPath in resolvedLinks[sourcePath]) {
        referenced.add(targetPath);
      }
    }

    // Find files not referenced by anyone
    const excludeDirs = ['10-Journal/', '99-System/', '50-Archives/', '.obsidian/'];
    const orphans = this.app.vault.getMarkdownFiles().filter((file) => {
      // Skip excluded directories
      if (excludeDirs.some((dir) => file.path.startsWith(dir))) return false;
      return !referenced.has(file.path);
    });

    if (orphans.length === 0) {
      new Notice('没有找到孤儿笔记！');
      return;
    }

    new OrphanNotesModal(this.app, orphans).open();
  }
}

// ============================================================
// Feature 5: Calendar View
// ============================================================

const CALENDAR_VIEW_TYPE = 'lucky-calendar';

class LuckyCalendarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentMonth = window.moment();
    this.dailyNotes = {};
    this.selectedDate = null;
  }

  getViewType() { return CALENDAR_VIEW_TYPE; }
  getDisplayText() { return '日历'; }
  getIcon() { return 'calendar'; }

  async onOpen() {
    this.scanDailyNotes();
    this.render();
    const refresh = debounce(() => { this.scanDailyNotes(); this.render(); }, 1000, true);
    const dailyRoot = '10-Journal/Daily';
    const affectsDailyNotes = (path) => typeof path === 'string' &&
      (path === '/' || path === dailyRoot || path.startsWith(dailyRoot + '/') || dailyRoot.startsWith(path + '/'));
    const onDailyChange = (file, oldPath) => {
      if (affectsDailyNotes(file?.path) || affectsDailyNotes(oldPath)) refresh();
    };
    this.registerEvent(this.app.vault.on('create', onDailyChange));
    this.registerEvent(this.app.vault.on('delete', onDailyChange));
    this.registerEvent(this.app.vault.on('rename', onDailyChange));
    this.registerEvent(this.app.vault.on('modify', onDailyChange)); // heat dots track file size
  }

  scanDailyNotes() {
    this.dailyNotes = {};
    const folder = this.app.vault.getAbstractFileByPath('10-Journal/Daily');
    if (!folder) return;
    const recurse = (f) => {
      if (!f.children) return;
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === 'md') {
          const date = window.moment(child.basename, 'YYYY-MM-DD', true);
          if (date.isValid()) {
            // Use file stat size as proxy for content volume (actual word count would require async reads)
            this.dailyNotes[date.format('YYYY-MM-DD')] = {
              file: child,
              size: child.stat ? child.stat.size : 0,
            };
          }
        } else if (child instanceof TFolder) {
          recurse(child);
        }
      }
    };
    recurse(folder);
  }

  getHeatLevel(dateStr) {
    const entry = this.dailyNotes[dateStr];
    if (!entry) return 0;
    const size = entry.size;
    // 4 levels based on file size (bytes → rough content volume)
    if (size < 500) return 1;    // light
    if (size < 2000) return 2;   // medium
    if (size < 5000) return 3;   // heavy
    return 4;                     // very heavy
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('lucky-cal-container');

    const today = window.moment();
    const todayStr = today.format('YYYY-MM-DD');
    const month = this.currentMonth;

    // === Header (iOS Calendar style: [‹] title(center, click→today) [›]) ===
    const header = container.createEl('div', { cls: 'lucky-cal-header' });
    const prevBtn = header.createEl('span', { cls: 'lucky-cal-nav', text: '‹' });
    const titleEl = header.createEl('span', { cls: 'lucky-cal-title', text: month.format('YYYY年 M月') });
    const isCurrentMonth = month.isSame(today, 'month');
    if (!isCurrentMonth) titleEl.addClass('lucky-cal-title-clickable');
    titleEl.addEventListener('click', () => {
      if (!isCurrentMonth) { this.currentMonth = window.moment(); this.render(); }
    });
    const nextBtn = header.createEl('span', { cls: 'lucky-cal-nav', text: '›' });

    prevBtn.addEventListener('click', () => { this.currentMonth = this.currentMonth.clone().subtract(1, 'month'); this.render(); });
    nextBtn.addEventListener('click', () => { this.currentMonth = this.currentMonth.clone().add(1, 'month'); this.render(); });

    // === Grid: 8 columns (week# gutter + Mon-Sun) ===
    const grid = container.createEl('div', { cls: 'lucky-cal-grid' });

    // Week-number gutter header (empty spacer) + weekday headers
    grid.createEl('div', { cls: 'lucky-cal-wk-header' });
    const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
    for (let i = 0; i < weekdayNames.length; i++) {
      const cls = 'lucky-cal-weekday' + (i >= 5 ? ' lucky-cal-weekday-weekend' : '');
      grid.createEl('div', { cls, text: weekdayNames[i] });
    }

    // Build calendar rows — fill leading/trailing days from adjacent months
    const startOfMonth = month.clone().startOf('month');
    const endOfMonth = month.clone().endOf('month');
    const startDay = startOfMonth.isoWeekday(); // 1=Mon ... 7=Sun
    const daysInMonth = endOfMonth.date();
    const prevMonth = month.clone().subtract(1, 'month');
    const prevMonthDays = prevMonth.daysInMonth();

    let currentDay = 1;

    const totalCells = (startDay - 1) + daysInMonth;
    const totalWeeks = Math.ceil(totalCells / 7);

    for (let week = 0; week < totalWeeks; week++) {
      // Week-number gutter cell — use Monday of this visible row for ISO week calc
      const mondayOfRow = startOfMonth.clone().subtract(startDay - 1, 'days').add(week * 7, 'days');
      grid.createEl('div', { cls: 'lucky-cal-wk', text: String(mondayOfRow.isoWeek()) });

      for (let dow = 1; dow <= 7; dow++) {
        if (week === 0 && dow < startDay) {
          // Previous month's trailing days
          const prevDay = prevMonthDays - (startDay - 1 - dow);
          const prevDateStr = prevMonth.format('YYYY-MM') + '-' + String(prevDay).padStart(2, '0');
          const dayEl = grid.createEl('div', { cls: 'lucky-cal-day lucky-cal-adjacent' });
          dayEl.createSpan({ cls: 'lucky-cal-day-num', text: String(prevDay) });
          dayEl.setAttribute('data-date', prevDateStr);
          if (dow >= 6) dayEl.addClass('lucky-cal-weekend');
          const prevHeat = this.getHeatLevel(prevDateStr);
          if (prevHeat > 0) {
            const dots = dayEl.createDiv({ cls: 'lucky-cal-heat-dots', attr: { 'data-heat': String(prevHeat) } });
            for (let i = 0; i < prevHeat; i++) dots.createDiv({ cls: 'lucky-cal-heat-dot' });
          }
          if (prevDateStr === this.selectedDate) dayEl.addClass('lucky-cal-selected');
        } else if (currentDay > daysInMonth) {
          // Next month's leading days
          const nextDay = currentDay - daysInMonth;
          const nextMonth = month.clone().add(1, 'month');
          const nextDateStr = nextMonth.format('YYYY-MM') + '-' + String(nextDay).padStart(2, '0');
          const dayEl = grid.createEl('div', { cls: 'lucky-cal-day lucky-cal-adjacent' });
          dayEl.createSpan({ cls: 'lucky-cal-day-num', text: String(nextDay) });
          dayEl.setAttribute('data-date', nextDateStr);
          if (dow >= 6) dayEl.addClass('lucky-cal-weekend');
          const nextHeat = this.getHeatLevel(nextDateStr);
          if (nextHeat > 0) {
            const dots = dayEl.createDiv({ cls: 'lucky-cal-heat-dots', attr: { 'data-heat': String(nextHeat) } });
            for (let i = 0; i < nextHeat; i++) dots.createDiv({ cls: 'lucky-cal-heat-dot' });
          }
          if (nextDateStr === this.selectedDate) dayEl.addClass('lucky-cal-selected');
          currentDay++;
        } else {
          const dateStr = month.format('YYYY-MM') + '-' + String(currentDay).padStart(2, '0');
          const dayEl = grid.createEl('div', { cls: 'lucky-cal-day' });
          dayEl.createSpan({ cls: 'lucky-cal-day-num', text: String(currentDay) });
          dayEl.setAttribute('data-date', dateStr);

          if (dow >= 6) dayEl.addClass('lucky-cal-weekend');

          if (dateStr === todayStr) {
            dayEl.addClass('lucky-cal-today');
          }
          if (dateStr === this.selectedDate) dayEl.addClass('lucky-cal-selected');

          const heat = this.getHeatLevel(dateStr);
          if (heat > 0) {
            const dots = dayEl.createDiv({ cls: 'lucky-cal-heat-dots', attr: { 'data-heat': String(heat) } });
            for (let i = 0; i < heat; i++) dots.createDiv({ cls: 'lucky-cal-heat-dot' });
          }

          if (dateStr > todayStr) {
            dayEl.addClass('lucky-cal-future');
          }

          currentDay++;
        }
      }
    }

    // === Grid click delegation ===
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.lucky-cal-day');
      if (!cell) return;
      const dateStr = cell.getAttribute('data-date');
      if (!dateStr) return;
      this.selectedDate = dateStr;
      grid.querySelectorAll('.lucky-cal-selected').forEach(el => el.removeClass('lucky-cal-selected'));
      cell.addClass('lucky-cal-selected');
      this.openOrCreateNote(dateStr);
    });

    // === Month stats footer ===
    const monthPrefix = month.format('YYYY-MM');
    let noteCount = 0;
    let totalSize = 0;
    for (const [dateStr, entry] of Object.entries(this.dailyNotes)) {
      if (dateStr.startsWith(monthPrefix)) {
        noteCount++;
        totalSize += entry.size;
      }
    }
    const totalKB = (totalSize / 1024).toFixed(1);
    const footer = container.createEl('div', { cls: 'lucky-cal-footer' });
    footer.createEl('span', { text: `${noteCount} 篇日记` });
    footer.createEl('span', { text: `${totalKB} KB` });
  }

  async openOrCreateNote(dateStr) {
    // Guard against double-click racing two vault.create calls for the same date
    if (this._creating && this._creating.has(dateStr)) return;
    (this._creating || (this._creating = new Set())).add(dateStr);
    try {
      const m = window.moment(dateStr, 'YYYY-MM-DD');
      const filePath = '10-Journal/Daily/' + m.format('YYYY-MM') + '/' + dateStr + '.md';

      const entry = this.dailyNotes[dateStr];
      let file = entry ? entry.file : this.app.vault.getAbstractFileByPath(filePath);
      if (!file) {
        const folderPath = '10-Journal/Daily/' + m.format('YYYY-MM');
        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
          await this.app.vault.createFolder(folderPath);
        }
        let content = '';
        const templateFile = this.app.vault.getAbstractFileByPath('99-System/obsidianDWMY/Daily.md');
        if (templateFile) {
          content = await this.app.vault.read(templateFile);
          content = content.replace(/\{\{date\}\}/g, dateStr);
          content = content.replace(/\{\{title\}\}/g, dateStr);
        }
        file = await this.app.vault.create(filePath, content);
        this.dailyNotes[dateStr] = { file, size: content.length };
      }
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      console.error('Lucky Toolkit: 打开/创建日记失败', e);
      new Notice('日记操作失败: ' + e.message);
    } finally {
      this._creating.delete(dateStr);
    }
  }
}

// ============================================================
// Feature 12: File Explorer
// ============================================================

const FILE_EXPLORER_VIEW_TYPE = 'lucky-files';

class LuckyFileExplorer extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.expandedFolders = new Set(['/']); // root always expanded
    // Folder icon mapping (Lucide icon names from obsidian-icon-folder)
    this.folderIcons = Object.assign(Object.create(null), {
      '00-Inbox': 'inbox',
      '01-Work': 'rocket',
      '02-Finance': 'trending-up',
      '03-Fitness': 'heart',
      '04-Learning': 'book-marked',
      '10-Journal': 'pen-line',
      '40-Resources': 'bookmark',
      '50-Archives': 'package',
      '99-System': 'cpu',
    }, Object.fromEntries(Object.entries(plugin.settings?.rootFolderIcons || {}).filter(([, value]) => typeof value === 'string')));
  }

  getViewType() { return FILE_EXPLORER_VIEW_TYPE; }
  getDisplayText() { return '文件列表'; }
  getIcon() { return 'folder-tree'; }

  async onOpen() {
    this._sortMode = this._sortMode || 'alphabetical';
    this._autoReveal = this._autoReveal || false;
    this._allExpanded = false;
    this._mdCountCache = this.plugin._noteCountCache;
    this._fileRows = new Map();
    this._pendingModifiedFiles = new Set();

    const container = this.containerEl.children[1];
    container.addClass('lucky-fe-container');

    // === Nav toolbar (built once, never re-rendered) ===
    const navHeader = container.createEl('div', { cls: 'nav-header' });
    const navButtons = navHeader.createEl('div', { cls: 'nav-buttons-container' });

    // 1. New note
    const newNoteBtn = navButtons.createEl('div', { cls: 'clickable-icon nav-action-button', attr: { 'aria-label': '新建笔记' } });
    setIcon(newNoteBtn, 'lucide-edit');
    newNoteBtn.addEventListener('click', async (evt) => {
      const activeFile = this.app.workspace.getActiveFile();
      const parentFolder = activeFile ? this.app.fileManager.getNewFileParent(activeFile.path) : this.app.vault.getRoot();
      const newFile = await this.app.vault.create(parentFolder.path + '/未命名.md', '');
      const leaf = evt.metaKey || evt.ctrlKey ? this.app.workspace.getLeaf('tab') : this.app.workspace.getLeaf(false);
      await leaf.openFile(newFile);
      this.app.fileManager.promptForFileRename(newFile);
    });

    // 2. New folder
    const newFolderBtn = navButtons.createEl('div', { cls: 'clickable-icon nav-action-button', attr: { 'aria-label': '新建文件夹' } });
    setIcon(newFolderBtn, 'lucide-folder-plus');
    newFolderBtn.addEventListener('click', async () => {
      const name = await this.promptInput('新建文件夹', '文件夹名：');
      if (!name) return;
      await this.app.vault.createFolder(name);
    });

    // 3. Sort
    const sortBtn = navButtons.createEl('div', { cls: 'clickable-icon nav-action-button', attr: { 'aria-label': '更改排序方式' } });
    setIcon(sortBtn, 'lucide-sort-asc');
    sortBtn.addEventListener('click', (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      const groups = [
        [['alphabetical', '文件名 (A → Z)'], ['alphabeticalReverse', '文件名 (Z → A)']],
        [['byModifiedTime', '修改时间 (新 → 旧)'], ['byModifiedTimeReverse', '修改时间 (旧 → 新)']],
        [['byCreatedTime', '创建时间 (新 → 旧)'], ['byCreatedTimeReverse', '创建时间 (旧 → 新)']],
      ];
      for (const group of groups) {
        for (const [key, label] of group) {
          menu.addItem((item) => {
            item.setTitle(label);
            if (this._sortMode === key) item.setChecked(true);
            item.onClick(() => { this._sortMode = key; this.renderTree(); });
          });
        }
        menu.addSeparator();
      }
      menu.showAtMouseEvent(evt);
    });

    // 4. Auto-reveal
    const revealBtn = navButtons.createEl('div', { cls: 'clickable-icon nav-action-button' + (this._autoReveal ? ' is-active' : ''), attr: { 'aria-label': '自动定位当前文件' } });
    setIcon(revealBtn, 'lucide-locate');
    revealBtn.addEventListener('click', () => {
      this._autoReveal = !this._autoReveal;
      revealBtn.toggleClass('is-active', this._autoReveal);
      if (this._autoReveal) {
        this.highlightActiveFile();
        const activeEl = this.containerEl.querySelector('.lucky-fe-file.is-active');
        if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    // 5. Expand/collapse all
    this._toggleBtn = navButtons.createEl('div', { cls: 'clickable-icon nav-action-button', attr: { 'aria-label': '展开全部文件夹' } });
    setIcon(this._toggleBtn, 'lucide-chevrons-up-down');
    this._toggleBtn.addEventListener('click', () => {
      if (this._allExpanded) {
        this.expandedFolders.clear();
        this.expandedFolders.add('/');
        this._allExpanded = false;
      } else {
        const expandAll = (folder) => {
          if (!folder.children) return;
          for (const child of folder.children) {
            if (child instanceof TFolder) {
              this.expandedFolders.add(child.path);
              expandAll(child);
            }
          }
        };
        expandAll(this.app.vault.getRoot());
        this._allExpanded = true;
      }
      setIcon(this._toggleBtn, this._allExpanded ? 'lucide-chevrons-down-up' : 'lucide-chevrons-up-down');
      this._toggleBtn.setAttribute('aria-label', this._allExpanded ? '收起全部文件夹' : '展开全部文件夹');
      this.renderTree();
    });

    // === Tree container (only this part re-renders) ===
    this._treeEl = container.createEl('div', { cls: 'lucky-fe-tree' });
    this.renderTree();

    // Only displayed files affect the tree; keep unrelated folder counts cached.
    const refresh = debounce(() => {
      this.renderTree();
    }, 500, true);
    this._refreshTree = refresh;
    const onTreeChange = (file, oldPath) => {
      if (!invalidateMdCounts(file, oldPath, this._mdCountCache)) return;
      refresh();
    };
    this.registerEvent(this.app.vault.on('create', onTreeChange));
    this.registerEvent(this.app.vault.on('delete', onTreeChange));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      // Migrate expanded state (folder itself + expanded descendants) to new path
      if (this.expandedFolders.delete(oldPath)) this.expandedFolders.add(file.path);
      const prefix = oldPath + '/';
      for (const p of [...this.expandedFolders]) {
        if (p.startsWith(prefix)) {
          this.expandedFolders.delete(p);
          this.expandedFolders.add(file.path + '/' + p.slice(prefix.length));
        }
      }
      onTreeChange(file, oldPath);
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile) || !this._fileRows.has(file.path)) return;
      this._pendingModifiedFiles.add(file);
      if (this._modifyFrame != null) return;
      this._modifyFrame = window.requestAnimationFrame(() => {
        this._modifyFrame = null;
        const parents = new Set();
        for (const changed of this._pendingModifiedFiles) {
          const row = this._fileRows.get(changed.path)?.el;
          if (!row || !changed.stat) continue;
          const size = (changed.stat.size / 1024).toFixed(1);
          let sizeEl = row.querySelector('.lucky-fe-file-size');
          if (!sizeEl) sizeEl = row.createEl('span', { cls: 'lucky-fe-file-size' });
          sizeEl.textContent = size + 'K';
          row.setAttribute('title', changed.path + '\n' + size + ' KB · ' + new Date(changed.stat.mtime).toLocaleDateString('zh-CN'));
          if (this._sortMode === 'byModifiedTime' || this._sortMode === 'byModifiedTimeReverse') parents.add(row.parentElement);
        }
        this._pendingModifiedFiles.clear();
        const scrollTop = this._treeEl.scrollTop;
        for (const parent of parents) {
          const rows = Array.from(parent.children).map(el => this._fileRows.get(el.getAttribute('data-path'))).filter(Boolean);
          const direction = this._sortMode === 'byModifiedTime' ? -1 : 1;
          rows.sort((a, b) => direction * ((a.file.stat?.mtime || 0) - (b.file.stat?.mtime || 0)));
          for (const row of rows) parent.appendChild(row.el);
        }
        this._treeEl.scrollTop = scrollTop;
      });
    }));
    this.registerEvent(this.app.workspace.on('file-open', () => {
      if (this._fileOpenFrame != null) return;
      this._fileOpenFrame = window.requestAnimationFrame(() => {
        this._fileOpenFrame = null;
        this.highlightActiveFile();
        if (this._autoReveal) {
          const activeEl = this.containerEl.querySelector('.lucky-fe-file.is-active');
          if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }));
  }

  async onClose() {
    this._refreshTree?.cancel();
    if (this._fileOpenFrame != null) window.cancelAnimationFrame(this._fileOpenFrame);
    this._fileOpenFrame = null;
    if (this._modifyFrame != null) window.cancelAnimationFrame(this._modifyFrame);
    this._modifyFrame = null;
    this._pendingModifiedFiles.clear();
    this._fileRows.clear();
  }

  // Cached md file count — built once per vault change, reused across render
  getMdCount(folder) {
    return countMdInFolder(folder, this._mdCountCache);
  }

  renderTree() {
    const treeEl = this._treeEl;
    const scrollTop = treeEl.scrollTop;
    treeEl.empty();
    this._fileRows.clear();
    const root = this.app.vault.getRoot();
    this.renderFolder(treeEl, root, 0, true);
    treeEl.scrollTop = scrollTop;
    this.highlightActiveFile();
  }

  renderFolder(parentEl, folder, depth, isRoot) {
    if (!folder.children) return;
    const activePath = this.app.workspace.getActiveFile()?.path;

    // Sort: folders first, then files; 6 native sort modes
    const sm = this._sortMode;
    const children = folder.children.filter((child) => !child.name.startsWith('.') &&
      (child instanceof TFolder || child instanceof TFile && child.extension === 'md')).sort((a, b) => {
      const aIsFolder = a instanceof TFolder;
      const bIsFolder = b instanceof TFolder;
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      if (sm === 'alphabeticalReverse') return ZH_COLLATOR.compare(b.name, a.name);
      if (sm === 'byModifiedTime' && a.stat && b.stat) return b.stat.mtime - a.stat.mtime;
      if (sm === 'byModifiedTimeReverse' && a.stat && b.stat) return a.stat.mtime - b.stat.mtime;
      if (sm === 'byCreatedTime' && a.stat && b.stat) return b.stat.ctime - a.stat.ctime;
      if (sm === 'byCreatedTimeReverse' && a.stat && b.stat) return a.stat.ctime - b.stat.ctime;
      return ZH_COLLATOR.compare(a.name, b.name);
    });

    for (const child of children) {
      if (child instanceof TFolder) {
        const folderPath = child.path;
        const isExpanded = this.expandedFolders.has(folderPath);

        // Folder row
        const folderEl = parentEl.createEl('div', { cls: 'lucky-fe-folder' });
        const titleCls = 'lucky-fe-folder-title' + (depth === 0 ? ' lucky-fe-root-folder' : '');
        const titleEl = folderEl.createEl('div', { cls: titleCls });
        titleEl.setAttribute('data-depth', String(depth));
        if (depth === 0) titleEl.setAttribute('data-path', folderPath);
        // Cached count
        const mdCount = this.getMdCount(child);

        // Tooltip: path + count
        titleEl.setAttribute('title', child.path + ' · ' + mdCount + ' 篇笔记');

        // Arrow — lucide chevron, rotates 90° when expanded (CSS)
        const arrow = titleEl.createEl('span', {
          cls: 'lucky-fe-arrow' + (isExpanded ? ' is-expanded' : ''),
        });
        setIcon(arrow, 'chevron-right');

        // Icon — mapped icon for known root folders, generic folder otherwise
        const iconName = this.folderIcons[child.name];
        const isGenericIcon = !iconName;
        const iconEl = titleEl.createEl('span', { cls: 'lucky-fe-icon' });
        setIcon(iconEl, iconName || (isExpanded ? 'folder-open' : 'folder'));

        // Folder name
        titleEl.createEl('span', { cls: 'lucky-fe-folder-name', text: child.name });

        // Note count
        if (mdCount > 0) {
          titleEl.createEl('span', { cls: 'lucky-fe-count', text: String(mdCount) });
        }

        // Children container — lazy: only render when expanded
        const childrenEl = folderEl.createEl('div', { cls: 'lucky-fe-children' });
        if (isExpanded) {
          this.renderFolder(childrenEl, child, depth + 1, false);
        } else {
          childrenEl.style.display = 'none';
        }

        // Click to toggle expand (in-place, lazy render on first expand)
        let childrenRendered = isExpanded;
        titleEl.addEventListener('click', () => {
          const nowExpanded = this.expandedFolders.has(folderPath);
          if (nowExpanded) {
            this.expandedFolders.delete(folderPath);
            for (const row of childrenEl.querySelectorAll('.lucky-fe-file')) this._fileRows.delete(row.getAttribute('data-path'));
            childrenEl.empty();
            childrenRendered = false;
            childrenEl.style.display = 'none';
            arrow.removeClass('is-expanded');
            if (isGenericIcon) setIcon(iconEl, 'folder');
          } else {
            this.expandedFolders.add(folderPath);
            if (!childrenRendered) {
              this.renderFolder(childrenEl, child, depth + 1, false);
              childrenRendered = true;
            }
            childrenEl.style.display = '';
            arrow.addClass('is-expanded');
            if (isGenericIcon) setIcon(iconEl, 'folder-open');
          }
        });

        // Right-click context menu
        titleEl.addEventListener('contextmenu', (evt) => {
          evt.preventDefault();
          const menu = new Menu();
          menu.addItem((item) => item.setTitle('新建笔记').setIcon('lucide-edit').onClick(async () => {
            const name = await this.promptInput('新建笔记', '文件名（不含 .md）：');
            if (!name) return;
            const path = child.path + '/' + name + '.md';
            const file = await this.app.vault.create(path, '');
            await this.app.workspace.getLeaf(false).openFile(file);
          }));
          menu.addItem((item) => item.setTitle('新建文件夹').setIcon('lucide-folder-plus').onClick(async () => {
            const name = await this.promptInput('新建文件夹', '文件夹名：');
            if (!name) return;
            await this.app.vault.createFolder(child.path + '/' + name);
          }));
          menu.addSeparator();
          menu.addItem((item) => item.setTitle('重命名').setIcon('lucide-pencil').onClick(async () => {
            const newName = await this.promptInput('重命名文件夹', '新名称：', child.name);
            if (!newName || newName === child.name) return;
            const newPath = (child.parent ? child.parent.path : '') + '/' + newName;
            await this.app.fileManager.renameFile(child, newPath);
          }));
          menu.addItem((item) => item.setTitle('删除').setIcon('lucide-trash-2').onClick(async () => {
            await this.app.vault.trash(child, true);
          }));
          menu.showAtPosition({ x: evt.pageX, y: evt.pageY });
        });
      } else if (child instanceof TFile && child.extension === 'md') {
        const isActive = child.path === activePath;
        const fileEl = parentEl.createEl('div', {
          cls: 'lucky-fe-file' + (isActive ? ' is-active' : ''),
          attr: { 'data-depth': String(depth), 'data-path': child.path },
        });
        this._fileRows.set(child.path, { el: fileEl, file: child });
        // Tooltip: full path + size + modified time
        const fileSizeKB = child.stat ? (child.stat.size / 1024).toFixed(1) + ' KB' : '';
        const fileMtime = child.stat ? new Date(child.stat.mtime).toLocaleDateString('zh-CN') : '';
        fileEl.setAttribute('title', child.path + (fileSizeKB ? '\n' + fileSizeKB + ' · ' + fileMtime : ''));

        // File icon
        const fileIconEl = fileEl.createEl('span', { cls: 'lucky-fe-icon lucky-fe-file-icon' });
        setIcon(fileIconEl, 'file-text');

        fileEl.createEl('span', { cls: 'lucky-fe-file-name', text: child.basename });

        // File size
        if (child.stat) {
          const kb = (child.stat.size / 1024).toFixed(1);
          fileEl.createEl('span', { cls: 'lucky-fe-file-size', text: kb + 'K' });
        }

        // Click to open
        fileEl.addEventListener('click', () => {
          this.app.workspace.getLeaf(false).openFile(child);
        });

        // Right-click context menu
        fileEl.addEventListener('contextmenu', (evt) => {
          evt.preventDefault();
          const menu = new Menu();
          menu.addItem((item) => item.setTitle('删除').setIcon('trash').onClick(async () => {
            await this.app.vault.trash(child, true);
          }));
          menu.addItem((item) => item.setTitle('重命名').setIcon('pencil').onClick(async () => {
            const newName = await this.promptInput('重命名', '新文件名（不含 .md）：', child.basename);
            if (!newName || newName === child.basename) return;
            const parentPath = child.parent ? child.parent.path : '';
            const newPath = parentPath + '/' + newName + '.md';
            await this.app.fileManager.renameFile(child, newPath);
          }));
          menu.showAtPosition({ x: evt.pageX, y: evt.pageY });
        });
      }
    }
  }

  highlightActiveFile() {
    if (this._highlighting) return;
    this._highlighting = true;
    try {
      const activeFile = this.app.workspace.getActiveFile();
      const container = this.containerEl.querySelector('.lucky-fe-tree');
      if (!container) return;

      // Always clear the old highlight first — even when the new active file's
      // row isn't rendered (collapsed folder), a stale highlight must not linger
      container.querySelectorAll('.lucky-fe-file.is-active').forEach((el) => el.removeClass('is-active'));
      container.querySelectorAll('.lucky-fe-root-folder.is-active-root').forEach((el) => el.removeClass('is-active-root'));
      if (!activeFile) return;

      // Reveal ancestors before looking up an existing row: it may be hidden.
      let expanded = false;
      if (this._autoReveal) {
        let parent = activeFile.parent;
        while (parent && parent.path !== '/') {
          if (!this.expandedFolders.has(parent.path)) {
            this.expandedFolders.add(parent.path);
            expanded = true;
          }
          parent = parent.parent;
        }
        if (expanded) this.renderTree();
      }

      // Only the root folder that contains the active note keeps its accent icon.
      const slash = activeFile.path.indexOf('/');
      if (slash > 0) {
        container.querySelector(`.lucky-fe-root-folder[data-path="${CSS.escape(activeFile.path.slice(0, slash))}"]`)?.addClass('is-active-root');
      }

      const escaped = CSS.escape(activeFile.path);
      const existing = container.querySelector(`.lucky-fe-file[data-path="${escaped}"]`);

      if (existing) {
        existing.addClass('is-active');
        if (expanded) existing.scrollIntoView({ block: 'nearest' });
      }
    } finally {
      this._highlighting = false;
    }
  }

  promptInput(title, message, defaultValue) {
    return new Promise((resolve) => {
      const modal = new TagPromptModal(this.app, title, message, defaultValue || '', resolve);
      modal.open();
    });
  }
}

// ============================================================
// Tag Prompt Modal (native Obsidian Modal)
// ============================================================

class TagPromptModal extends Modal {
  constructor(app, title, message, defaultValue, onSubmit) {
    super(app);
    this.modalTitle = title;
    this.message = message;
    this.defaultValue = defaultValue;
    this.onSubmit = onSubmit;
    this.result = null;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.modalTitle);

    contentEl.createEl('p', { text: this.message, cls: 'lucky-tag-modal-msg' });

    const input = contentEl.createEl('input', { type: 'text' });
    input.value = this.defaultValue || '';
    input.addClass('lucky-tag-input');
    input.style.width = '100%';

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.result = input.value.trim().replace(/^#/, '') || null;
        this.close();
      }
    });

    const btnRow = contentEl.createEl('div', { cls: 'lucky-tag-btn-row' });
    const submitBtn = btnRow.createEl('button', { cls: 'mod-cta', text: '确定' });
    const cancelBtn = btnRow.createEl('button', { text: '取消' });

    submitBtn.addEventListener('click', () => {
      this.result = input.value.trim().replace(/^#/, '') || null;
      this.close();
    });
    cancelBtn.addEventListener('click', () => this.close());

    this._focusTimer = setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  onClose() {
    if (this._focusTimer) clearTimeout(this._focusTimer);
    this.contentEl.empty();
    this.onSubmit(this.result);
  }
}

// ============================================================
// Feature 9: Recent Files Modal
// ============================================================

class RecentFilesModal extends FuzzySuggestModal {
  constructor(app) {
    super(app);
    this.setPlaceholder('搜索最近编辑的文件…');
  }

  getItems() {
    if (!this._cachedItems) {
      this._cachedItems = this.app.vault.getMarkdownFiles()
        .filter(f => f.stat)
        .sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0))
        .slice(0, 20);
    }
    return this._cachedItems;
  }

  getItemText(file) {
    return file.basename;
  }

  onChooseItem(file) {
    this.app.workspace.getLeaf(false).openFile(file);
  }
}

// ============================================================
// Feature 10: Orphan Notes Modal
// ============================================================

class OrphanNotesModal extends FuzzySuggestModal {
  constructor(app, orphans) {
    super(app);
    this.orphans = orphans;
    this.setPlaceholder('搜索孤儿笔记… (共 ' + orphans.length + ' 个)');
  }

  getItems() {
    return this.orphans;
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    this.app.workspace.getLeaf(false).openFile(file);
  }
}

// ============================================================
// Settings Tab
// ============================================================

class LuckyToolkitSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // --- Beautify Section ---
    containerEl.createEl('h2', { text: '排版美化' });

    new Setting(containerEl)
      .setName('启用排版美化')
      .setDesc('一键开关全部视觉增强：字体（JetBrainsMono + HarmonyOS Sans）· 标题层级背景（H1强调色/H2侧边条/H3-H6淡灰）· 杂志风引用块 · Callout 精简 · 表格斑马纹+全宽 · 代码块左侧强调线+语言标签 · 几何列表标记 · 行内代码加粗 · 图片圆角阴影 · 内链 hover 动效 · 段落防孤行 · 标题均匀换行 · 高亮当前行 · Clutter-free Headings · 待办状态美化（✓›—等）')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableBeautify).onChange(async (value) => {
          this.plugin.settings.enableBeautify = value;
          this.plugin.applyHiderClasses();
          await this.plugin.saveSettings();
        })
      );

    // --- Hider Section ---
    containerEl.createEl('h2', { text: '界面隐藏' });

    new Setting(containerEl)
      .setName('隐藏滚动条')
      .setDesc('隐藏所有滚动条。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideScroll).onChange(async (value) => {
          this.plugin.settings.hideScroll = value;
          this.plugin.applyHiderClasses();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('阅读视图隐藏属性')
      .setDesc('在阅读模式下隐藏元数据/属性面板。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hidePropertiesReading).onChange(async (value) => {
          this.plugin.settings.hidePropertiesReading = value;
          this.plugin.applyHiderClasses();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('隐藏仓库名称')
      .setDesc('隐藏侧边栏中的仓库名称。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideVault).onChange(async (value) => {
          this.plugin.settings.hideVault = value;
          this.plugin.applyHiderClasses();
          await this.plugin.saveSettings();
        })
      );

    // --- Tab Manager Section ---
    containerEl.createEl('h2', { text: '标签页管理' });

    new Setting(containerEl)
      .setName('防止重复标签页')
      .setDesc('打开已在其他标签页中打开的文件时，聚焦该标签页而非创建副本。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.preventDuplicateTabs).onChange(async (value) => {
          this.plugin.settings.preventDuplicateTabs = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('标签页上限')
      .setDesc('超过此数量时自动关闭最早的标签页。0 = 不限制。')
      .addSlider((slider) =>
        slider
          .setLimits(0, 30, 1)
          .setValue(this.plugin.settings.maxTabs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxTabs = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Note Count Section ---
    containerEl.createEl('h2', { text: '笔记计数' });

    new Setting(containerEl)
      .setName('文件夹显示笔记数')
      .setDesc('在文件管理器中显示每个文件夹的 .md 文件数量。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showNoteCount).onChange(async (value) => {
          this.plugin.settings.showNoteCount = value;
          if (value) {
            this.plugin.initNoteCount();
          } else {
            this.plugin.removeAllNoteCounts();
          }
          await this.plugin.saveSettings();
        })
      );

    // --- Tag Wrangler Section ---
    containerEl.createEl('h2', { text: '标签管理' });

    new Setting(containerEl)
      .setName('启用标签重命名与合并')
      .setDesc('在标签面板添加右键菜单，支持重命名和合并标签。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableTagWrangler).onChange(async (value) => {
          this.plugin.settings.enableTagWrangler = value;
          await this.plugin.saveSettings();
          if (value) {
            new Notice('标签管理已启用，重启 Obsidian 后完全生效。');
          }
        })
      );

    // --- Calendar Section ---
    containerEl.createEl('h2', { text: '日历视图' });

    new Setting(containerEl)
      .setName('启用日历')
      .setDesc('在右侧栏显示月历，点击日期打开/创建日记。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showCalendar).onChange(async (value) => {
          this.plugin.settings.showCalendar = value;
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.activateCalendarView();
          } else {
            this.app.workspace.detachLeavesOfType(CALENDAR_VIEW_TYPE);
          }
        })
      );

    // --- Auto Link Title Section ---
    containerEl.createEl('h2', { text: '自动链接标题' });

    new Setting(containerEl)
      .setName('粘贴 URL 自动获取标题')
      .setDesc('粘贴网址时自动获取网页标题，转为 [标题](URL) 格式。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoLinkTitle).onChange(async (value) => {
          this.plugin.settings.autoLinkTitle = value;
          await this.plugin.saveSettings();
        })
      );

    // --- Reading Time Section ---
    containerEl.createEl('h2', { text: '阅读时间' });

    new Setting(containerEl)
      .setName('状态栏显示阅读时间')
      .setDesc('在状态栏显示当前笔记的预估阅读时间。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showReadingTime).onChange(async (value) => {
          this.plugin.settings.showReadingTime = value;
          this.plugin.updateReadingTime();
          await this.plugin.saveSettings();
        })
      );

    // --- Focus Mode Section ---
    containerEl.createEl('h2', { text: '焦点模式' });

    new Setting(containerEl)
      .setName('启用焦点模式')
      .setDesc('写作时淡化非当前段落，聚焦光标所在行。可通过命令面板切换。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.focusMode).onChange(async (value) => {
          this.plugin.settings.focusMode = value;
          document.body.toggleClass('lucky-focus-mode', value);
          await this.plugin.saveSettings();
        })
      );

    // --- File Explorer Section ---
    containerEl.createEl('h2', { text: '文件列表' });

    new Setting(containerEl)
      .setName('启用自定义文件列表')
      .setDesc('在左侧栏显示轻量文件浏览器，支持搜索过滤和笔记计数。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showFileExplorer).onChange(async (value) => {
          this.plugin.settings.showFileExplorer = value;
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.activateFileExplorer();
          } else {
            this.app.workspace.detachLeavesOfType(FILE_EXPLORER_VIEW_TYPE);
          }
        })
      );
  }
}

// ============================================================
// Export
// ============================================================

module.exports = LuckyToolkit;
