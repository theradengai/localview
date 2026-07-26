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
9. Selecting text shows a compact horizontal Markdown toolbar without moving focus or collapsing the selection. A normal right-click opens the full source-formatting menu; `Shift` + right-click retains the native macOS menu.
10. Each toolbar, context-menu, task-checkbox, or GFM table action is one CodeMirror transaction, one undo step, one preview update, and one auto-save update.
11. Auto-save writes the exact latest content to the original file; `Command-S` flushes immediately.
12. The status bar shows **等待自动保存 / 正在保存 / 已保存** or a terminal conflict, missing-file, or error state.

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
- Edit as source-preserving Live Preview; Split as left full preview plus right softly wrapped raw source; Preview as the default reading mode
- relative images
- automatic single-line formatting toolbar for non-empty selections, with headings, paragraph, inline styles, links, quotes, fenced code, and lists
- right-click source formatting for headings, paragraph, bold, italic, strikethrough, inline code, links, quotes, fenced code, and lists
- `Shift` + right-click native-menu fallback
- bounded GFM table insertion and strict top-level row, column, deletion, and alignment operations
- one transaction and one undo step per formatting action
- 600 ms idle auto-save with `Command-S` immediate flush
- line count
- UTF-8 status
- workspace-root and per-folder `+` controls for creating a Markdown file
- inline filename entry where Enter creates an empty real file immediately and Escape cancels
- automatic `.md` suffix when the input does not already end in `.md` (case-insensitive)
- one shared explicit whitespace/control rule and a 255 UTF-16-code-unit limit on the final suffixed filename
- exclusive creation that rejects a same-name file instead of overwriting it
- pinned Unix workspace capability, no-follow parent traversal, and root/parent identity checks before the exclusive create
- save-gated creation, followed by selecting the new saved file in Edit mode

Markdown creation does not include folders, non-Markdown file types, rename, move, or copy. Creating the empty file is immediate; subsequent content auto-saves after 600 ms of idle time, while `Command-S` flushes immediately. Files and workspace subfolders may be moved to macOS Trash, but permanent deletion and workspace-root deletion are unavailable. Browser development mode must use the same filename normalization, simulate creation and Trash only in memory, and never invoke desktop filesystem commands.

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

- `.xls`, `.xlsx`, and `.ods` render as bounded, read-only data grids
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

- application bundle supports Markdown, HTML, spreadsheet, document, presentation, OpenDocument, and iWork types
- Markdown/HTML role is Editor; Office/OpenDocument/iWork role is Viewer
- app receives cold-start open-file events
- app receives open-file events when already running
- single-instance behavior forwards the path to the existing window
- the window is shown, focused, and unminimized

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
- root and folder Markdown-create controls update only the in-memory demo tree

### Desktop functional review

- opening a folder shows real files
- expanding folders loads children lazily
- clicking Markdown reads the real file
- Markdown formatting preserves the selected range, updates Split preview immediately, and remains one undo step
- Markdown Edit renders supported inactive syntax in place without changing source; entering the syntax reveals its exact Markdown again
- selecting text shows a clamped single-line toolbar without stealing focus; formatting closes it and one undo restores the prior source
- Split keeps the preview on the left and a vertically scrolling, softly wrapped source editor on the right without ordinary paragraph-level horizontal scrolling
- a 3-column × 2-data-row GFM table can be inserted without overwriting surrounding text
- strict top-level tables support safe row, column, alignment, and table deletion; malformed or nested tables are left unchanged
- `Shift` + right-click opens the native menu, while HTML and plain text never receive the Markdown menu
- root and nested folder `+` create a new empty Markdown file without overwriting existing files
- repeated `+` activation for one unloaded folder reuses one directory read; failure clears busy state and can be retried
- workspace transitions wait for in-flight create/save mutations and ignore stale file, conflict-reload, poll, and folder responses
- creating, switching, and closing flush pending edits first and do not show the old discard dialog after a successful save
- a created file is selected in Edit mode and its later content auto-saves after 600 ms
- `Command-S` immediately flushes the real file through the same serial save coordinator
- watcher events refresh only loaded directories; manual reload preserves workspace, selection, expansion, editor, and scroll
- right-click and `Command-Delete` move eligible nodes to macOS Trash; root and symlinks are rejected
- reload/relaunch restores bounded workspace context without persisting file bodies or tree cache
- clicking HTML previews its local resources
- Finder reveal works
- opening associated Markdown/HTML/Office/OpenDocument/iWork files selects the target

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
