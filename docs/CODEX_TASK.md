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
7. Markdown opens in the last-used mode, defaulting to Split.
8. Editing updates the preview without writing to disk.
9. `Command-S` writes the exact current content to the original file.
10. The status bar changes from **未保存** to **已保存**.

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
- Edit / Split / Preview
- relative images
- explicit save
- line count
- UTF-8 status

### HTML

Required:

- `.html`, `.htm`
- syntax highlighting
- Source / Split / Preview
- relative resources
- interactive JavaScript
- refresh when source changes
- default Preview mode

### Text and images

Required:

- edit common text/code formats as plain text
- preview common image formats

### Unsupported formats

Show a restrained placeholder explaining that a future renderer will support the type. Do not pretend unsupported Office files are rendered.

---

## Unsaved and external-change behavior

At minimum:

- changing files or workspaces with unsaved edits requires confirmation
- closing the window with unsaved edits must not silently discard them
- saving is atomic where practical

Preferred before MVP release:

- watch the current file for external modification
- when disk content changes and the editor is clean, reload it
- when disk content changes and the editor is dirty, show choices: reload disk, keep local, compare

Do not silently overwrite an externally changed file.

---

## macOS integration

Required configuration:

- application bundle supports Markdown and HTML document types
- document role is Editor
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

### Desktop functional review

- opening a folder shows real files
- expanding folders loads children lazily
- clicking Markdown reads the real file
- `Command-S` writes the real file
- clicking HTML previews its local resources
- Finder reveal works
- opening associated Markdown/HTML files selects the target

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
