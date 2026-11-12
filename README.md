# Lucky Toolkit

> Consolidated toolkit: beautify, hider, tab manager, note count, tag wrangler, calendar view, auto link title, reading time, focus mode, file explorer, recent files, orphan notes.

个人整合的 Obsidian 插件，把十多个常用小功能合并到单个插件里，便于一处管理。

- **Version**: 4.0.7
- **Min Obsidian Version**: 1.5.8
- **Author**: zheng
- **Platform**: Desktop & Mobile

## Features

| # | 功能 | 说明 |
|---|------|------|
| 0 | **Beautify** | 排版与视觉增强 |
| 1 | **Hider** | 隐藏滚动条 / Reading 视图 properties / vault 名称 |
| 2 | **Tab Manager** | 防止重复标签页 + 标签页数量上限 |
| 3 | **Note Count** | 文件管理器中按文件夹显示 .md 笔记数徽章 |
| 4 | **Tag Wrangler** | 标签批量重命名/合并 |
| 5 | **Calendar View** | 日历侧边栏 |
| 6 | **Auto Link Title** | 粘贴 URL 自动抓取标题 |
| 7 | **Reading Time** | 显示预估阅读时长 |
| 8 | **Focus Mode** | 专注写作模式 |
| 9 | **Recent Files** | 最近文件列表 |
| 10 | **Orphan Notes** | 孤立笔记检测 |
| 11 | **File Explorer** | 文件浏览器增强 |

所有功能的开关集中在插件设置面板。

## Project Layout

这是**单文件 JS 插件**，`main.js` 就是源码（非 esbuild 构建产物），直接使用 CommonJS `require('obsidian')`：

```
lucky-toolkit/
├── manifest.json   # 插件元数据
├── main.js         # 全部源码（~59KB, 人工编写）
├── styles.css      # 样式
├── data.json       # 运行时设置快照
└── README.md
```

## Install

手动安装到 vault：

```bash
mkdir -p ~/obsidian/<vault>/.obsidian/plugins/lucky-toolkit
cp manifest.json main.js styles.css ~/obsidian/<vault>/.obsidian/plugins/lucky-toolkit/
```

然后在 Obsidian 的 `Settings → Community plugins` 中启用 **Lucky Toolkit**。

## Development Workflow

由于没有构建步骤，开发回路非常短：

1. 在本项目文件夹编辑 `main.js`
2. 拷贝回 vault：
   ```bash
   cp main.js ~/obsidian/2024/.obsidian/plugins/lucky-toolkit/main.js
   ```
3. 在 Obsidian 中使用 `Cmd+P → Reload app without saving` 或通过 BRAT / Hot-Reload 插件重载

如需 TypeScript 化或 esbuild 打包，可作为后续迭代方向。

## 4.0.6（本机候选，2026-11-12）

修正标签批量重命名误改其他 YAML 列表、缓存滞后时误改较长标签；日历只响应日记目录相关事件。

文件列表去除主题叠加的容器留白，根目录与文件采用14px字号，根目录保留600字重；计数改为右对齐，文件大小保留在提示中。树区域独立滚动，长名称可省略，选中时文字不横移；移动端保留原字号与触控尺寸。

本机原生界面已核验 240px 窄侧栏、长文件名省略、底部可达和工具栏固定，并截图检查。

## 4.0.7（本机候选，2026-11-12）

日历列宽允许收缩（minmax(0,1fr)），窄侧栏下不再向右溢出、保持居中；文件列表根目录15px/500，子目录14px，文件13px，计数12px浅色，行高36px；图标根目录17px、子目录15px、文件14px，展开箭头11–12px细线；保留容器留白和滚动修复。

自建文件列表忽略不可见附件的结构事件，Markdown变化只失效相关祖先目录计数；排序前过滤附件和隐藏项，同帧打开事件合并定位，重绘保留滚动位置，关闭时取消排队任务。原生文件管理器的计数功能仍沿用原有独立监听。

9500篇笔记测试中单次新建笔记的扩展检查9501→102；95目录/2000附件及隐藏项的根目录排序比较3948→94。这些是操作次数对比，不代表整个应用耗时提升倍数。

```bash
node --test test-behavior.cjs file-explorer-test.cjs
```

行为回归：

```bash
node --test test-behavior.cjs
```
