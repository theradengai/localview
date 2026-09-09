# Codex task: finish and validate the LocalView MVP

## Objective

Turn the existing implementation into a reliable macOS MVP while preserving the exact product direction and the visual language of `prototype/local-folder-viewer-prototype.html`.

Do not start over. Audit the existing React/Tauri implementation, keep working parts, fix incomplete behavior, and validate the complete flow.

---

## Canonical user journey

### Journey A: open a Markdown file from Finder

1. The user double-clicks or chooses **Open With → LocalView** on `project/docs/plan.md`.
2. LocalView receives the absolute file path.
3. It determines a workspace root.
4. The left sidebar displays the real folder tree for that workspace.
5. All ancestor folders of `docs/plan.md` are expanded.
6. `plan.md` is selected.
7. Markdown opens in Preview; Edit and Split require an explicit user action for the current file.
8. Edit uses source-preserving Live Preview. Split keeps the full preview on the left and softly wrapped raw source on the right. Editing schedules a single auto-save after 600 ms of idle time.
9. Selecting text shows the only LocalView Markdown formatting surface: a compact horizontal toolbar with source styles, highlight, and fixed font colors, without moving focus or collapsing the selection. An ordinary right-click at an empty caret opens that same toolbar at the pointer; selected-text right-click keeps the toolbar and remains native. `Shift` + right-click, the Context Menu key, `Shift` + `F10`, and interactive-widget context menus remain native operating-system paths.
10. Each selection-toolbar, task-checkbox, or document-toolbar GFM table action is one CodeMirror transaction, one undo step, one preview update, and one auto-save update. In Edit Live Preview, a header/body cell may also be edited directly; each accepted cell input updates only its exact Markdown source range.
11. Auto-save writes the exact latest content to the original file; `Command-S` flushes immediately.
12. The status bar shows **等待自动保存 / 正在保存 / 已保存** or a terminal conflict, missing-file, or error state.
13. **打印**, **File → Print…**, and `Command-P` all print the same rendered snapshot of the latest in-memory Markdown through the native macOS print settings, without saving or changing the active mode.

### Journey B: open an HTML file from Finder

1. The user opens `prototype/index.html` with LocalView.
2. LocalView opens the containing workspace and selects the file.
3. HTML defaults to Preview.
4. Relative `./style.css`, scripts, fonts, images, and nested assets resolve from the HTML file's directory.
5. Page interactions work inside the preview.
6. Source and Split modes use the in-memory edited source.
7. The preview remains sandboxed and cannot call privileged Tauri APIs.

### Journey C: open a folder in the application

1. Click **打开文件夹**.
2. Select any local directory.
3. Show only its immediate children initially.
4. Read child directories when the user expands them.
5. Never perform automatic full-text indexing or recursive content loading.

### Journey D: compare independent workspaces in multiple windows

1. Use **工作区菜单 → 新建窗口** or `Command-N`.
2. A new empty LocalView window opens without flushing, changing, or closing the current editor.
3. Each window may open a different folder, or the same file, while retaining independent tree, watcher, preview, session, and close state.
4. An additional Finder/file-association request creates another window in the running process instead of replacing an existing workspace.
5. Each main or additional workspace window moves from its titlebar background/title, while the titlebar action buttons remain clickable.
6. `Command-Q` waits for every live window to save or explicitly approve discard. A cancel in any window aborts the whole quit and preserves all remaining dirty editor content.

---

## Workspace-root rules

When opened from a file, search upward for the first useful project marker:

- `.localview-root`
- `.git`
- `package.json`
- `Cargo.toml`
- `pyproject.toml`

Stop after a conservative number of ancestors. When no marker is found, use the file's direct parent directory.

Do not create a marker file automatically.

---

## Exact visual requirements

The production interface must remain visibly consistent with the prototype.

### Window structure

- title bar: `46px`
- content area: remaining height
- status bar: `28px`
- sidebar: `250px` on normal desktop widths
- document toolbar: `42px`

### Palette

- application background: `#f3f3f0`
- sidebar: `#f8f8f5`
- primary surface: `#ffffff`
- separators: `#d7d7d1`
- primary text: `#181818`
- muted text: `#777`
- hover surface: `#efefe9` / `#ecece6`
- selected tree item: `#deded7`

### Interaction styling

- compact native-feeling buttons
- rounded corners around 7–9 px
- thin borders
- no heavy shadows or gradients
- no large branded landing page inside the app
- no IDE activity bar, terminal, minimap, tabs, command palette, or Git UI in the MVP

### Markdown reading view

- centered body
- maximum width approximately `820px`
- top padding around `42px`
- H1 around `34px`
- readable line-height around `1.72`
- dark code blocks and subtle inline code background

---

## File behavior

### Markdown

Required:

- `.md`, `.markdown`, `.mdown`, `.mkd`
- CodeMirror editing
- GitHub-flavored tables and task lists
- Ordinary paragraph/quote/list continuation newlines remain visible in reading, Split and printing, including text nested in emphasis; code and raw HTML are not rewritten
- Mode changes preserve the editor instance and undo history; Preview hides and locks the retained editor
- Inactive editable table cells render inline Markdown through the same safe renderer as reading; activation reveals exact source and maintains existing IME/undo behavior
- Edit as source-preserving Live Preview; Split as left full preview plus right softly wrapped raw source; Preview as the default reading mode
- relative images
- automatic single-line formatting toolbar for non-empty selections, plus the same pointer-anchored toolbar after an ordinary empty-selection right-click; highlight and font color are disabled without selected text
- exact `<mark>...</mark>` highlight source and exact `<span data-localview-color="red|orange|green|blue|purple|gray">...</span>` color source, with bounded balanced-pair parsing and arbitrary raw HTML kept escaped
- native operating-system menus for selected-text right-click, `Shift` + right-click, the Context Menu key, `Shift` + `F10`, and interactive widgets
- stable cross-line mouse selection inside rendered fenced-code content, with the language label as the explicit fenced-source escape
- document-toolbar **表格** control in Edit and Split for bounded GFM table insertion and strict top-level row, column, deletion, and alignment operations
- one active auto-height table-cell input in Edit Live Preview, with stable DOM patching during ordinary input, `Enter`/`Tab` navigation, boundary focus restoration, blur exit, `Escape`, IME-safe updates, native copy/cut/paste/context menu, CodeMirror undo/redo, and a whole-table source escape
- one transaction and one undo step per formatting action
- 600 ms idle auto-save with `Command-S` immediate flush
- one rendered Markdown print path shared by the toolbar, focused-window **File → Print…**, and `Command-P`, using the latest in-memory content in Edit, Split, or Preview
- an immutable offscreen print snapshot that waits at most three seconds for fonts/images, excludes application chrome/source editors, survives native dispatch, and never saves or changes mode/dirty/conflict state
- fail-closed handling for non-Markdown files so `Command-P` never prints the whole LocalView window
- line count
- UTF-8 status
- workspace-root and per-folder `+` menus for creating a Markdown file or ordinary folder
- kind-aware inline name entry where Enter creates the real item immediately and Escape cancels
- automatic `.md` suffix when the input does not already end in `.md` (case-insensitive)
- one shared explicit whitespace/control rule and a 255 UTF-16-code-unit limit on the final suffixed filename
- exclusive creation that rejects a same-name file instead of overwriting it
- pinned Unix workspace capability, no-follow parent traversal, and root/parent identity checks before the exclusive create
- save-gated creation, followed by selecting the new saved file in Edit mode
- folder creation outside the document save gate, preserving the current document and dirty editor
- tree-name/title double-click, row-menu, and row-focused F2 rename for ordinary files, ordinary subfolders, and whole iWork bundles; Enter or clicking outside commits and Escape cancels
- inline stem editing with the original file or bundle suffix locked; ordinary folders edit their complete name
- Enter/blur submit, Escape cancel, unchanged-blur silent exit, IME-safe composition, and retained input/focus after a definitive failure

Creation supports empty Markdown files and ordinary folders, but not other file types or copy. Ordinary files, ordinary subfolders, and whole iWork document bundles may be renamed in place; root, symlink, bundle-interior, extension-changing, unchanged, case-only, reserved, overlong, collision, changed-identity, and ambiguous cases fail closed. A dirty selected document contained by a renamed file or folder is saved first, then its document, save, session, and renderer paths migrate to the confirmed new prefix. An unrelated dirty document is not flushed. Rename watcher events use the same bounded relocation buffer as move, and an uncertain outcome only refreshes loaded affected directories without migrating the UI or claiming success. Ordinary files, non-empty ordinary folders, and whole iWork bundles may also move atomically inside the same workspace by internal tree drag, with a desktop-only native folder picker as the menu fallback. iWork bundle contents are never exposed as independent move sources or destinations. The macOS commit resolves root-relative paths from the pinned workspace handle, requires exclusive no-follow/no-replace behavior, verifies inode/device postconditions, and safely reconciles uncertain outcomes. Root, symlink, outside-workspace, same-parent move, folder self/descendant, collision, changed-identity, and cross-volume moves are rejected without overwrite or copy-delete. Creating either item is immediate; subsequent Markdown content auto-saves after 600 ms of idle time, while `Command-S` flushes the active table surface first and then saves immediately. Folder names reject hidden/watcher-reserved names and iWork bundle suffixes. Files and workspace subfolders may be moved to macOS Trash, but permanent deletion and workspace-root deletion are unavailable. Browser development mode must use the same name normalization, simulate creation, rename, internal file/folder dragging, and Trash only in memory, and never invoke desktop filesystem commands.

### HTML

Required:

- `.html`, `.htm`
- syntax highlighting
- Source / Split / Preview
- relative resources
- interactive JavaScript
- refresh when source changes
- default Preview mode
- per-document preview capabilities bound to the current workspace generation
- capability-scoped local CSS, image, font, media, and JavaScript resources
- sandbox and CSP enforcement that block external network access, forms, nested frames, objects, and top-level navigation
- HTTP 403 for missing, stale, released, wrong-generation, or out-of-scope preview capabilities, with no workspace-wide fallback or wildcard CORS

### Text and images

Required:

- edit common text/code formats as plain text
- preview common image formats

### Spreadsheet and Office preview

Required:

- UTF-8 `.csv`, `.xls`, `.xlsx`, and `.ods` render as bounded, read-only data grids
- CSV is a single text-preserving worksheet with optional UTF-8 BOM, quoted fields, embedded newlines and ragged rows; unsupported encodings have a visible error
- spreadsheet cells show complete wrapped saved values with automatic row heights instead of ellipsis truncation
- `.numbers`, `.pages`, `.key`, Word, and PowerPoint use macOS Quick Look
- Quick Look is embedded in the LocalView document area so provider-supported multi-page documents and presentations can use native navigation
- Office files always use Preview mode and never participate in dirty-state or `Command-S`
- embedded Quick Look and spreadsheet parse failures show their real error plus thumbnail/native fallback actions

Explicit limitations:

- no Excel editing, formula recalculation, macros, charts, or complete formatting fidelity
- no in-app editing for Numbers, Pages, Keynote, Word, or PowerPoint
- no Office animations or full slideshow playback
- large, corrupt, encrypted, or limit-exceeding workbooks may fall back to Quick Look/default application

### Unsupported formats

Show a restrained placeholder explaining that a future renderer will support the type. Do not pretend unsupported Office files are rendered.

---

## Unsaved and external-change behavior

At minimum:

- changing files or workspaces first flushes pending edits; only a save error, missing file, or external conflict requires a discard decision
- all startup, Finder, and picker workspace requests use one serialized latest-request transition
- workspace preparation keeps the old UI readable but disables editing, save, reveal, tree, and create actions
- failed preparation rolls the backend root back and preserves the old tree/document/draft; failed rollback clears untrusted workspace state
- closing the window with unsaved edits must not silently discard them
- application quit must collect a per-window save/discard disposition before exiting; discard approval must not clear dirty state until exit is committed, and any cancellation must restore every window's interaction gate
- saving is atomic where practical

Required:

- watch the workspace for external create, modify, remove, rename, and rescan events
- refresh only already-loaded directory branches and keep a 5-second selected-file consistency fallback
- provide an in-place manual reload when the watcher is unavailable or misses an event
- when disk content changes and the editor is clean, reload it
- when disk content changes and the editor is dirty, show choices: reload disk, keep local, compare

Do not silently overwrite an externally changed file.

---

## macOS integration

Required configuration:

- application bundle registers every extension recognized by the renderer registry: Markdown, HTML, common text/code, images, PDF, spreadsheet, document, presentation, OpenDocument, and iWork
- Markdown/HTML/text/code role is Editor; image/PDF/Office/OpenDocument/iWork role is Viewer
- every association uses alternate-handler rank so LocalView never silently takes over a default application
- app receives cold-start open-file events
- app receives open-file events when already running
- single-instance behavior keeps one process but creates a new window for each additional path, or an empty window for a pathless second launch
- `Command-N` creates an empty dynamic window; Dock reopen focuses the last active live window or restores the last-active workspace when no window remains
- each window reload restores its own private session; a full relaunch restores only the most recently active non-empty workspace in one window

The user remains in control of setting LocalView as the default application in Finder.

---

## Security requirements

- HTML preview must be isolated from the main application UI
- arbitrary preview JavaScript must not access Tauri invoke APIs
- do not use Node integration
- do not globally expose unrestricted filesystem commands to preview content
- local asset access should be scoped as narrowly as practical

If Safe Preview and Interactive Preview are added, Interactive Preview may allow page scripts but must still remain separated from privileged app APIs.

---

## Acceptance checklist

### Browser UI review

- `npm run dev` shows the demo tree
- layout visually matches the prototype
- Markdown editing and live preview work
- HTML demo interaction works
- mode buttons and selected tree rows work
- the Markdown **打印** button and `Command-P` open the browser print dialog with rendered Markdown only; unsupported file kinds never print the application shell
- root and folder Markdown-create controls update only the in-memory demo tree
- tree-name/title double-click, row-menu, and F2 rename update only the in-memory demo tree and keep file suffixes locked

### Desktop functional review

- Clipboard screenshots paste in Markdown Edit/Split, appear in preview, and persist as relative references to uniquely named sibling `assets/` files; one undo restores the prior source without deleting attachments
- Text paste remains native; image-paste errors, oversized/unsupported batches, read-only surfaces, stale document results, other-window paths, symlinks, and attachment-folder collisions preserve document content
- Closing or `Command-S` during image persistence waits for the mutation before saving; switching is gated, and application quit cancels while the operation is active
- opening a folder shows real files
- expanding folders loads children lazily
- clicking Markdown reads the real file
- Markdown formatting preserves the selected range, updates Split preview immediately, and remains one undo step
- Markdown Edit renders supported inactive syntax in place without changing source; entering the syntax reveals its exact Markdown again
- selecting text shows a clamped single-line toolbar without stealing focus; formatting closes it and one undo restores the prior source
- ordinary right-click at an empty Markdown caret opens that same toolbar at the pointer; highlight/color are disabled, other actions insert at the caret, and Shift-right-click stays native
- Split keeps the preview on the left and a vertically scrolling, softly wrapped source editor on the right without ordinary paragraph-level horizontal scrolling
- a 3-column × 2-data-row GFM table can be inserted without overwriting surrounding text
- strict top-level tables support safe row, column, alignment, and table deletion; malformed or nested tables are left unchanged
- Markdown Edit activates exactly one table header/body cell in place; accepted input updates only that source range, IME does not submit early, navigation and undo/redo stay in sync, and Split/Preview do not expose cell inputs
- a non-empty Markdown selection survives ordinary native right-click while the automatic toolbar remains visible; `Shift` + right-click, the Context Menu key, `Shift` + `F10`, table-cell inputs, HTML, and plain text remain native
- mouse selection can cross multiple rendered fenced-code lines without replacing the block DOM or changing source; clicking the language label reveals the fenced source
- root and nested folder `+` menus create a new empty Markdown file or ordinary folder without overwriting existing entries
- repeated `+` activation for one unloaded folder reuses one directory read; failure clears busy state and can be retried
- every eligible file/folder row exposes `…`; double-clicking its name, double-clicking the active document title, choosing **重命名**, or pressing F2 opens one inline input with a locked file/bundle suffix
- Enter or clicking outside commits rename, Escape cancels, unchanged blur exits silently, and validation failures keep and refocus the same input
- current-file and ancestor-folder rename require a stable save and migrate selected/save/session/renderer paths; unrelated dirty documents are not flushed
- rename rejects root, symlink, bundle interior, extension change, unchanged/case-only name, collision, identity race, and ambiguous outcome without overwrite or false success
- self-generated rename watcher batches converge once, overflow rescans loaded directories, and external rename/remove updates or cancels an active draft deterministically
- workspace transitions wait for in-flight create/save mutations and ignore stale file, conflict-reload, poll, and folder responses
- creating, switching, and closing flush pending edits first and do not show the old discard dialog after a successful save
- a created file is selected in Edit mode and its later content auto-saves after 600 ms
- `Command-S` immediately flushes the real file through the same serial save coordinator
- Markdown **打印**, focused-window **File → Print…**, and `Command-P` open native print settings from Edit, Split, and Preview with the latest unsaved rendered content, without saving or changing mode
- print output excludes titlebar, sidebar, toolbar, status bar, source editor, and inactive split pane; fonts/images are given a bounded readiness wait and a delayed native render cannot lose its snapshot
- `Command-P` on HTML, text, images, PDF, spreadsheets, and Office/iWork previews fails closed instead of printing the LocalView window
- with two LocalView windows, the File-menu print request reaches only the currently focused window and does not change or print the other workspace
- watcher events refresh only loaded directories; manual reload preserves workspace, selection, expansion, editor, and scroll
- ordinary files, non-empty ordinary folders, and iWork document bundles move through tree-row drag/workspace-header-or-folder drop; each node menu destination picker uses the current workspace and browser mode performs only an in-memory equivalent
- moving the selected dirty editable file or a folder containing it requires a successful stable save and follows the new path prefix without resetting mode/content/scroll; moving an unrelated item does not flush the current draft
- same-parent, same-name, symlink, root-source, folder self/descendant, outside-workspace, identity-race, cross-volume, and ambiguous move results never overwrite, copy-delete, or silently report success
- folder `…`, right-click, and tree-row-focused `Command-Delete` move eligible nodes to macOS Trash; root and symlinks are rejected
- reload/relaunch restores bounded workspace context without persisting file bodies or tree cache
- clicking HTML previews its local resources
- Finder reveal works
- opening any associated Markdown/HTML/text/code/image/PDF/Office/OpenDocument/iWork file selects the target in its folder context
- `Command-N` and the project menu each create exactly one independent empty window without touching the current dirty editor
- two windows can show different folders and same-named resources without tree, watcher, asset, HTML capability, spreadsheet, or Quick Look cross-talk
- the main window and a second `workspace-*` window both move from titlebar empty/title areas, and **打开文件夹** / **在 Finder 中显示** remain clickable
- two windows opening the same file preserve the first successful save and surface an external conflict for the stale second save
- closing one window leaves all others running; `Command-Q` exits only after every window is ready, while one cancel preserves every window and dirty draft

### Build review

Run successfully:

```bash
npm install
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

On macOS:

```bash
npm run tauri:build
```

Confirm the generated `.app` and `.dmg` exist under `src-tauri/target/release/bundle/`.

---

## Deliverable

Submit a focused change set that:

1. preserves prototype visual parity;
2. completes the user journeys above;
3. fixes build/type/Rust errors;
4. documents any remaining limitations honestly;
5. does not add unrelated knowledge-management or AI features.
