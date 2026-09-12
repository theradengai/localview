# Markdown 看板 / Markdown Kanban

## 使用

在根目录或任意文件夹的 `+` 菜单选择 **新建看板**。创建的仍是普通 `.md` 文件，预览自动显示看板。编辑模式显示源码；分栏为左看板、右源码。

- 单击卡片打开右侧详情，修改标题、说明和子任务。说明使用 Markdown 文本编辑，自动缩进写回。
- 卡片与列的 `⠿` 把手支持拖动排序。卡片详情中的目标列、上移/下移，以及列菜单的左右移动提供不依赖拖放的操作。
- 每列底部添加卡片，Enter 连续添加、Esc 取消；新增列和列菜单支持列名编辑。
- 完成复选框只修改 `[ ]`/`[x]`，与列名及拖动目的地无关。
- 删除卡片或列前确认。非空列可先将所有卡片迁到另一列，再删除列。所有这些内容修改可用同一份 CodeMirror 撤销/重做。
- 使用原有 600 ms 自动保存和 `⌘S`，不绕过文件版本校验；外部修改冲突时保留本地内容，不覆盖磁盘新版本。

## 文件约定

```markdown
---
localview: kanban
---

# 发布计划

## 待办

- [ ] 更新文档 #文档
  说明文字。
  - [ ] 补充步骤

## 进行中

## 已完成
```

See [the synthetic fixture](fixtures/kanban.md). This is an explicit LocalView dialect, not automatic conversion of arbitrary Markdown or a claim of Obsidian plugin compatibility.

A marked file is one board. Top-level `##` headings define columns. Unindented bullet task items (`-`, `+`, or `*`) define cards; indented continuation content belongs to the card. Keep at least two spaces or a tab before descriptions and subtasks. Column/card order is source order. Duplicate names are safe: commands address immutable source ranges, not labels. No persistent card IDs, database, sidecar files or file indexing are introduced. Plain Markdown task documents do not become boards.

Only the explicit `localview: kanban` marker in the opening `---` frontmatter enables this renderer (quoted `kanban` is also accepted). Unknown frontmatter is preserved byte-for-byte, not parsed or serialized as configuration. Conflicting duplicate markers and unclosed marked headers fail closed.

## Safety and limits

The existing GFM syntax tree distinguishes real headings/tasks from code, quotes and HTML. Unowned prose, non-task lists and unsupported block layouts inside columns show a source-only fallback. Nothing is silently discarded or regenerated. Correct them in Edit or Split. Body edits that would absorb neighboring cards or otherwise produce an unsafe layout are rejected with a message; use the source editor for incomplete fenced Markdown. Newly edited body text uses the file's line ending and two-space indentation; untouched blocks and moved blocks preserve original bytes. Trailing Enter stays in the detail input without repeatedly adding block separators.

Every board change is an isolated CodeMirror transaction; raw-source history metadata preserves mixed CRLF/CR/LF when moving and undoing. The original file content remains the only document model. Preview operations are rejected when their source or document key is stale, the workspace changes, the native operation gate is locked, or an input composition is active. Source edits invalidate open selection, drag and deletion snapshots. Pointer cancellation, Esc, window blur or an outside drop do not mutate content.

Parsing limits: 1 MiB in UTF-16 code units, 100 columns, 2000 cards, 1000 code units per newly entered title. Larger or unsupported boards remain source-editable. Card preview displays literal short text and tag chips; it does not run HTML or scripts. Printing continues to use the existing Markdown print renderer, not a board screenshot. No card multiselection, automatic completion lanes, cross-file boards, due-date automation or real-time collaboration in this version.

## Verification

`npm test` includes parser/source-range, component interaction, real CodeMirror undo/redo and App versioned-save/conflict regression tests. The App suite uses a native-command test double; it is not macOS filesystem end-to-end evidence.

`node scripts/verify-kanban-browser.mjs /tmp/localview-browser/package.json output/kanban-browser` exercises the production in-memory demo in Chromium and WebKit. Install the isolated `playwright@1.58.2` and its browser engines first. No user documents or native bridge are used. Existing macOS CI separately checks the Tauri crate and isolated native file-operation regressions. A browser pass is not full installed-app manual acceptance.
