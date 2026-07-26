# LocalView

A lightweight, macOS-first local file workspace.

> Open a file, see the folder context.

LocalView browses the real filesystem without Vaults, imports, hidden workspace metadata, or mandatory indexing.

## Current MVP

- Open any local folder
- Lazy-load the real directory tree
- Create an empty Markdown file from the workspace root or any folder with the sidebar `+`; an input that does not end in `.md` (case-insensitive) receives that suffix automatically
- Read and edit Markdown, HTML, and text files
- Markdown Edit / Split / Preview modes, opening in Preview by default; Edit is a source-preserving Live Preview, while Split keeps the full preview on the left and softly wrapped raw source on the right
- Select Markdown text to show a compact single-line formatting toolbar; the full source-formatting menu remains available on right-click in Edit/Split
- GFM table insertion and safe top-level row, column, deletion, and alignment actions; `Shift` + right-click keeps the native macOS menu
- HTML interactive preview with relative CSS, images, and JavaScript
- Auto-save Markdown, HTML, and text to the original file after 600 ms of idle time; `⌘S` flushes immediately
- Detect external edits, reload clean files, and block conflicting saves
- Flush pending edits before switching files, changing workspaces, or closing; only save errors, missing files, or conflicts require a decision
- Watch the active workspace for external create, remove, modify, and rename events, refreshing only directories already loaded in the tree
- Reload the current directory tree in place without reopening the folder picker
- Move files and workspace subfolders to the macOS Trash from the tree context menu or `⌘Delete`; permanent deletion and workspace-root deletion are not exposed
- Restore the last workspace, selected file, expanded folders, and view mode after WebView reload or a normal relaunch
- Keep the committed workspace visible but read-only during a workspace switch; serialize Finder, startup, and folder-picker requests and roll back cleanly if preparation fails
- Preview local images and PDFs
- Read `.xls`, `.xlsx`, and `.ods` as a read-only data grid with sheet switching, bounded pagination, and complete wrapped cell text with automatic row heights
- Preview Numbers, Pages, Keynote, Word, and PowerPoint documents through an interactive macOS Quick Look view embedded in LocalView
- Navigate multi-page presentations and documents with Quick Look's native controls; fall back to a system thumbnail, a separate Quick Look window, or the file's default application when embedding is unavailable
- Run interactive HTML in a sandbox through a per-document preview capability; relative local CSS, images, fonts, media, and JavaScript work, while external network access, forms, nested frames, objects, and top-level navigation are blocked
- Reveal the current item in Finder
- Register Markdown, HTML, spreadsheet, document, presentation, and iWork file associations on macOS builds
- Reuse the running application when another associated file is opened

The browser development mode keeps the original mock project so the interface can be reviewed without Tauri. Auto-save, Markdown creation, refresh, and Trash are simulated only in memory and never call Tauri filesystem commands.

## Stack

- Tauri 2
- React + TypeScript
- CodeMirror 6
- react-markdown + remark-gfm
- Custom CSS matching `prototype/local-folder-viewer-prototype.html`

## Run the browser prototype

```bash
npm install
npm run dev
```

Open the local Vite URL shown in the terminal.

Run the frontend regression suite with:

```bash
npm test
```

## Run the macOS desktop app

Prerequisites:

- Node.js
- Rust via rustup
- Xcode Command Line Tools

```bash
npm install
npm run tauri:dev
```

## Build the macOS application locally

```bash
npm run tauri:build
```

The generated `.app` and `.dmg` are placed under `src-tauri/target/release/bundle/`.

## Build a test package with GitHub Actions

Open **Actions → Build LocalView for macOS → Run workflow**. After the run finishes, download the `LocalView-macOS` artifact containing the unsigned `.app` and `.dmg` test bundles.

After installing or opening the built app once, macOS can list LocalView under **Open With** for supported Markdown, HTML, Office, OpenDocument, and iWork files. Finder double-click opens LocalView only after the user explicitly chooses LocalView as the default application for that type; LocalView does not change default-app settings.

## Product constraints

- The filesystem is the source of truth
- No database for the MVP
- No automatic full-folder content indexing
- Folders load on demand
- Do not redesign the interface into an IDE

## Known MVP limitations

- New-file actions create Markdown files only. Creating folders or other file types, renaming, moving, and copying are not included. Files and workspace subfolders can only be moved to Trash, never permanently deleted in LocalView.
- Markdown Live Preview is a reversible CodeMirror view over the original Markdown source, not a separate rich-text data model. Headings, emphasis, links, quotes, lists, tasks, fenced code, images, bounded top-level tables, and thematic breaks render in place when inactive; active or unsupported syntax stays source-editable.
- The automatic selection toolbar covers headings, paragraph, inline styles, links, quotes, code blocks, and lists. GFM table insertion and structural row/column/alignment actions remain in the full right-click menu. Table actions do not include merged cells, dragged column widths, TSV conversion, or Excel editing; nested, malformed, ambiguous, or oversized tables stay source-editable but are not structurally rewritten.
- Pressing Enter in the inline name field immediately creates an empty file on desktop. Later text changes auto-save after 600 ms; `⌘S` flushes immediately, and an existing same-name file is never overwritten.
- The final filename is limited to 255 UTF-16 code units by LocalView after the optional `.md` suffix is added. The mounted volume may enforce a stricter or different filename limit, which is reported as an I/O error.
- On macOS/Unix, creation walks from a pinned workspace directory capability with no-follow component opens, verifies root and parent identities, and uses one exclusive final create. A replaced root/parent fails closed instead of redirecting the write.
- While a workspace switch is being prepared, the old tree and document remain readable but editing, save, reveal, tree, and create actions are disabled. Preparation failure restores the previous backend root and inline draft; rollback failure clears the untrusted workspace.
- Conflict handling offers **reload disk** or **keep local**; a side-by-side diff is not included yet.
- Directory watching can miss events on some network or unusual mounted volumes; the selected-file 5-second consistency check and **重新载入目录** remain available fallbacks.
- HTML preview capabilities are bound to the selected document and current workspace generation. A stale or invalid capability fails closed with HTTP 403 instead of exposing workspace-wide file access; remote API calls and third-party embeds are intentionally unavailable in preview.
- Relaunch restoration in the current non-sandbox build uses the stored path. A Mac App Store sandbox build will need security-scoped bookmarks for durable cross-process folder access.
- Excel and ODS are data-only, read-only grids. Saved cell text wraps completely with automatic row heights, but editing, formula calculation, macros, charts, embedded objects, and complete formatting fidelity are not implemented; formulas show only saved cached values when available.
- Numbers, Pages, Keynote, Word, and PowerPoint use an embedded macOS Quick Look view and are read-only in LocalView. Multi-page navigation is available when the installed Quick Look provider exposes it; Office editing, animations, and full slideshow playback are not implemented.
- Large workbooks, malformed files, unsupported encryption, or parser limits return a visible error and offer system preview/default-app fallback; LocalView never labels a failed parse as rendered.
- PDF uses the operating system webview renderer.
- macOS test bundles use an ad-hoc signature and are not notarized, so Gatekeeper may require an explicit first open. Public distribution still requires a Developer ID signature and notarization.

See `docs/MVP.md` for the detailed requirements and `prototype/local-folder-viewer-prototype.html` for the interaction and visual reference.

## Roadmap

- v0.1 Markdown + HTML workspace
- v0.2 richer file operations and conflict comparison
- v0.3 richer PDF renderer
- v0.4 richer spreadsheet formatting and Office-native editing workflows
