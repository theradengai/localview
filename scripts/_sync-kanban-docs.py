"""One-shot documentation edits; every replacement must match the reviewed baseline."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def replace(path, old, new):
    p = ROOT / path
    text = p.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f'{path}: expected one exact replacement, got {text.count(old)}')
    p.write_text(text.replace(old, new, 1))

replace('README.md',
    '| Markdown | Edit, Live Preview, Split, Preview with task checkboxes, rendered printing |',
    '| Markdown | Edit, Live Preview, Split, Preview with task checkboxes, rendered printing |\n| Markdown Kanban (`localview: kanban`) | Interactive board, card details and subtasks, card/column sorting; shared source, undo and auto-save |')
replace('README.zh-CN.md',
    '| Markdown | 编辑、实时预览、分栏、可勾选任务的预览、渲染后打印 |',
    '| Markdown | 编辑、实时预览、分栏、可勾选任务的预览、渲染后打印 |\n| Markdown 看板（`localview: kanban`） | 可操作看板、卡片详情与子任务、卡片／列排序；与源码共享撤销和自动保存 |')
replace('README.md', '## Download\n', '''## Markdown Kanban

In a folder's `+` menu, choose **新建看板** (New board), or open the [sample Markdown file](docs/fixtures/kanban.md). A `localview: kanban` opening header enables the board: `##` headings are columns, top-level task items are cards, and indented descriptions/subtasks move with each card. Ordinary task lists keep their normal preview.

![LocalView Kanban preview with four columns, cards, tags and subtask progress](docs/images/localview-kanban-board.png)

*Actual Beta 5 production frontend in an isolated WebKit browser, using the repository's synthetic sample. This is not a native macOS acceptance screenshot; browser edits stay in memory.*

[Right-side card details](docs/images/localview-kanban-details.png) · [Board and Markdown in Split](docs/images/localview-kanban-split.png) · [Capture provenance](docs/images/KANBAN_CAPTURES.md) · [Full guide and limits](docs/KANBAN.md)

Drag a card by its handle, or move it with the details panel's column selector. **Preview** is the board; **Edit** is Markdown source; **Split** shows board and source side by side. Moving to a column does not automatically mark a card complete. File-tree multiselection does not imply card multiselection, which is not included. Printing uses the Markdown reading view, not a board image.

## Download
''')
replace('README.zh-CN.md', '## 下载与安装\n', '''## Markdown 看板

在文件夹 `+` 菜单选择 **新建看板**，或打开[示例 Markdown 文件](docs/fixtures/kanban.md)。文件开头的 `localview: kanban` 标记启用看板：`##` 二级标题是列，顶层任务项是卡片，缩进的说明和子任务随卡片一起移动。普通任务清单仍使用原来的预览。

![LocalView 看板预览：四列卡片、标签和子任务进度](docs/images/localview-kanban-board.png)

*截图来自 Beta 5 实际生产前端，在隔离的 WebKit 浏览器中使用仓库内的虚构示例；不是 macOS 原生安装包的验收截图，浏览器中的编辑仅保存在内存。*

[右侧卡片详情](docs/images/localview-kanban-details.png) · [看板／Markdown 分栏](docs/images/localview-kanban-split.png) · [截图来源](docs/images/KANBAN_CAPTURES.md) · [完整说明与限制](docs/KANBAN.md)

拖动卡片把手整理位置，也可在详情中选择目标列。**预览**显示看板，**编辑**显示 Markdown 源码，**分栏**同时显示两者。移动到某一列不会自动勾选完成。文件树支持多选，但本版看板卡片不支持多选。打印仍使用 Markdown 阅读视图，不是看板图片。

## 下载与安装
''')
# Keep the capability list compact after adding the dedicated visual guide.
for p in ['README.md', 'README.zh-CN.md']:
    text = (ROOT / p).read_text()
    text = text.replace('[Format and limits](docs/KANBAN.md).\n\n- **Start', '[Format and limits](docs/KANBAN.md).\n- **Start')
    text = text.replace('[格式与边界](docs/KANBAN.md)。\n\n- **从文件', '[格式与边界](docs/KANBAN.md)。\n- **从文件')
    (ROOT / p).write_text(text)

replace('docs/FEATURES.md',
    '- Use the workspace-root or folder-row `+` menu to create an empty Markdown file or a real folder inline; Markdown names receive `.md` automatically when needed',
    '- Use the workspace-root or folder-row `+` menu to create an empty Markdown file, a Markdown Kanban board with its template, or a real folder inline; Markdown names receive `.md` automatically when needed')
replace('docs/FEATURES.md',
    '- Read and edit Markdown, HTML, and text files',
    '- Read and edit Markdown, HTML, and text files\n- Open explicitly marked Markdown as an interactive Kanban board: add/edit cards and columns, drag cards within or across columns, reorder columns, edit right-side details and subtasks, and confirm deletion or migrate cards before deleting a nonempty column. Preview, Edit and Split share the same source, undo/redo and auto-save; see [Kanban usage and limits](KANBAN.md)')
replace('docs/FEATURES.md',
    '- Move ordinary files, ordinary folders, and iWork document bundles inside the workspace by dragging them onto a folder or the workspace header; each node menu provides a native destination-folder picker on desktop',
    '- Select files and folders with `⌘`/Ctrl-click, `Shift`-click for a visible range, or `⌘A` while the file tree has focus; `Esc` clears selection. Move the selected group by dragging to a folder/workspace header or by using the destination-folder picker. Batch Trash uses one confirmation. See [selection controls and safety](FOLDER_SELECTION.md)')
replace('docs/FEATURES.md',
    'Auto-save, Markdown/folder creation, rename, internal file dragging, refresh, and Trash are simulated only in memory',
    'Auto-save, Markdown/Kanban/folder creation, Kanban editing, rename, internal file dragging, refresh, and Trash are simulated only in memory')
replace('docs/FEATURES.md',
    '- Creation actions support empty Markdown files and ordinary folders; other-file creation and copy are not included.',
    '- Creation actions support empty Markdown files, template-backed Markdown Kanban files, and ordinary folders; other-file creation and copy are not included.')
replace('docs/FEATURES.md',
    'Ordinary files, non-empty ordinary folders, and whole iWork bundles may also move atomically inside the same workspace;',
    'Each eligible file, non-empty ordinary folder, or whole iWork bundle may move atomically inside the same workspace. A selected batch is sequential, not all-or-nothing: it stops on failure, reports completed operations and retains remaining selections;')
replace('docs/FEATURES.md',
    '- Markdown Preview and Split task checkboxes update the original source through auto-save and preserve conflict protection.',
    '- Markdown Kanban is enabled only by an explicit `localview: kanban` opening header. Source-range operations preserve complete moved blocks and untouched metadata/line endings; stale or unsafe operations are rejected. Unsupported layouts or boards above 1,048,576 UTF-16 code units, 100 columns or 2000 cards remain source-editable. Newly entered titles are limited to 1000 code units. New-card/new-column drafts keep native input undo; committed changes share CodeMirror history. No card multiselection, automatic completion columns, cross-file aggregation, due-date automation or real-time collaboration is included. No Obsidian plugin compatibility is claimed. Printing renders Markdown rather than the board. See [format, examples and validation boundaries](KANBAN.md).\n- Ordinary Markdown Preview and Split task checkboxes update the original source through auto-save and preserve conflict protection.')
replace('docs/FEATURES.md',
    '- Pressing Enter in the inline name field immediately creates an empty file on desktop. Later text changes auto-save after 600 ms;',
    '- Pressing Enter in a new Markdown filename field creates an empty file on desktop. New Kanban creation uses the same exclusive file creation, then writes the board template through the versioned auto-save coordinator; existing files are never overwritten. Later text changes auto-save after 600 ms;')

replace('docs/INSTALL.md', '## 中文安装摘要\n', '''## Try the Markdown Kanban

Choose **新建看板** (New board) in the workspace-root or folder-row `+` menu, or open [the synthetic example](fixtures/kanban.md). The file remains `.md`; only the explicit `localview: kanban` header enables a board. Click a card to edit its right-side details, drag its handle to move it, and choose **分栏** (Split) to inspect the same Markdown source.

Start with a disposable copy: edits auto-save to the original file. Moving a card does not change its completion checkbox. See [the Kanban guide](KANBAN.md) for source syntax, undo, deletion and limits. The README screenshots show the in-memory browser frontend, not completion of native macOS UI acceptance.

## 中文安装摘要
''')
replace('docs/INSTALL.md',
    '5. 问题反馈请注明版本、macOS、芯片类型和复现步骤；上传内容前移除私人资料。',
    '5. 体验看板：文件夹 `+` → **新建看板**，或打开[虚构示例](fixtures/kanban.md)。单击卡片编辑右侧详情，拖动把手移动，切到“分栏”查看同一份 Markdown。操作会自动保存，首次请使用可丢弃副本。[完整说明](KANBAN.md)。\n6. 问题反馈请注明版本、macOS、芯片类型和复现步骤；上传内容前移除私人资料。')
replace('docs/KANBAN.md', '## 文件约定\n', '''## 预览、详情与源码 / Views

![看板预览 / Board preview](images/localview-kanban-board.png)

[右侧卡片详情 / Card details](images/localview-kanban-details.png) · [看板与源码分栏 / Split view](images/localview-kanban-split.png) · [截图来源 / Capture provenance](images/KANBAN_CAPTURES.md)

截图使用仓库内的[虚构示例](fixtures/kanban.md)，来自 Beta 5 实际生产前端的隔离 WebKit 浏览器；不是原生 macOS 安装包验收。Screenshots show the production browser frontend with synthetic in-memory documents, not a mockup or native filesystem/UI acceptance.

## 文件约定
''')
replace('docs/KANBAN.md',
    'Parsing limits: 1 MiB in UTF-16 code units, 100 columns, 2000 cards, 1000 code units per newly entered title.',
    'Parsing limits: 1,048,576 UTF-16 code units (JavaScript string length, not file bytes), 100 columns, 2000 cards, 1000 code units per newly entered title.')
print('Updated five documentation files; no runtime, dependency, version or release edits.')
