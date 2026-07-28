# LocalView agent instructions

## Read first

Before changing code, read these files in order:

1. `prototype/local-folder-viewer-prototype.html`
2. `docs/MVP.md`
3. `docs/CODEX_TASK.md`
4. `README.md`

The interactive HTML prototype is the canonical visual and interaction reference. Do not redesign the product or replace its layout with a generic IDE, dashboard, component library, or VS Code clone.

## Product definition

LocalView is a lightweight macOS-first local document workspace.

Core behavior:

> Open a file, see the folder context.

The filesystem is the source of truth.

Non-negotiable principles:

- no Vault concept
- no file import step
- no database
- no mandatory content indexing
- no hidden project metadata
- read folders lazily and files on demand
- write edits back to the original file through the 600 ms auto-save coordinator; `Command-S` flushes immediately and external conflicts must never be overwritten

## MVP scope

The MVP must support:

- opening any local folder
- displaying the real folder tree
- creating empty Markdown files and ordinary folders inline from the root or any real folder
- moving files and workspace subfolders to macOS Trash without exposing permanent or workspace-root deletion
- opening independent workspaces in multiple windows through the workspace menu or `Command-N`
- routing each additional Finder/file-association request to a new window in the same LocalView process
- opening a `.md` or `.html` file from Finder and selecting it inside its folder context
- Markdown source editing with CodeMirror 6
- Markdown Edit / Split / Preview modes
- 600 ms idle auto-save to the original file, with `Command-S` immediate flush
- unsaved-state indication and protection against silent overwrite
- HTML Source / Split / Preview modes
- relative HTML CSS, image, font, and JavaScript resources
- interactive HTML preview inside a sandboxed frame
- image preview
- basic text-file editing
- revealing the active file in Finder

PDF, Excel, PowerPoint, and Word are future renderers. Do not implement full Office editing in this MVP.

## Visual contract

Match the prototype closely:

- 46 px title bar
- 28 px status bar
- 250 px sidebar at desktop width
- 42 px document toolbar
- neutral black, white, and warm-gray palette
- thin `#d7d7d1` separators
- Finder-like tree rows
- compact rounded controls
- centered document title
- Markdown body width and spacing from the prototype

Use custom CSS. Do not add Ant Design, Material UI, Tailwind component kits, or another visual system.

## Technical direction

- Tauri 2
- React
- TypeScript
- CodeMirror 6
- `react-markdown` + `remark-gfm`
- Rust commands for filesystem access and macOS open-file events

Keep renderer selection explicit by file kind so future renderers can be added without changing the core workspace model.

## Safety and correctness

- never silently discard unsaved edits
- never silently overwrite a file changed externally
- keep workspace roots, watchers, resource scopes, HTML capabilities, Quick Look state, sessions, save/close flows, and emitted events isolated by caller window; never reintroduce an app-global workspace capability
- treat application quit as a two-phase all-window save/discard transaction; cancelling one window must preserve all windows and dirty content
- do not expose Tauri commands to arbitrary HTML preview content
- keep HTML preview sandboxed
- normalize and validate paths
- reserve `.DS_Store`, internal `.localview-*.tmp` names, and iWork bundle suffixes for folder creation
- do not recursively scan the entire workspace on startup
- ignore `.DS_Store`; hidden-file behavior should be deliberate

## Validation

Before considering a task complete, run:

```bash
npm install
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

On macOS, also run when possible:

```bash
npm run tauri:build
```

Preserve the browser demo fallback unless the task explicitly removes it. The browser fallback is useful for fast UI review, but real filesystem behavior must remain in Tauri.
