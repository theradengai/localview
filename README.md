# LocalView

A lightweight, macOS-first local file workspace.

> Open a file, see the folder context.

LocalView browses the real filesystem without Vaults, imports, hidden workspace metadata, or mandatory indexing.

## Current MVP

- Open any local folder
- Lazy-load the real directory tree
- Read and edit Markdown, HTML, and text files
- Markdown Edit / Split / Preview modes, opening in Preview by default
- HTML interactive preview with relative CSS, images, and JavaScript
- Save directly to the original file with `⌘S`
- Detect external edits, reload clean files, and block conflicting saves
- Protect unsaved edits when switching files, changing workspaces, or closing the window
- Preview local images and PDFs
- Read `.xls`, `.xlsx`, and `.ods` as a read-only data grid with sheet switching, bounded pagination, and complete wrapped cell text with automatic row heights
- Preview Numbers, Pages, Keynote, Word, and PowerPoint documents through an interactive macOS Quick Look view embedded in LocalView
- Navigate multi-page presentations and documents with Quick Look's native controls; fall back to a system thumbnail, a separate Quick Look window, or the file's default application when embedding is unavailable
- Run interactive HTML in a sandbox with read-only assets scoped to the active workspace
- Reveal the current item in Finder
- Register Markdown, HTML, spreadsheet, document, presentation, and iWork file associations on macOS builds
- Reuse the running application when another associated file is opened

The browser development mode keeps the original mock project so the interface can be reviewed without Tauri.

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

- Conflict handling offers **reload disk** or **keep local**; a side-by-side diff is not included yet.
- Excel and ODS are data-only, read-only grids. Saved cell text wraps completely with automatic row heights, but editing, formula calculation, macros, charts, embedded objects, and complete formatting fidelity are not implemented; formulas show only saved cached values when available.
- Numbers, Pages, Keynote, Word, and PowerPoint use an embedded macOS Quick Look view and are read-only in LocalView. Multi-page navigation is available when the installed Quick Look provider exposes it; Office editing, animations, and full slideshow playback are not implemented.
- Large workbooks, malformed files, unsupported encryption, or parser limits return a visible error and offer system preview/default-app fallback; LocalView never labels a failed parse as rendered.
- PDF uses the operating system webview renderer.
- macOS test bundles use an ad-hoc signature and are not notarized, so Gatekeeper may require an explicit first open. Public distribution still requires a Developer ID signature and notarization.

See `docs/MVP.md` for the detailed requirements and `prototype/local-folder-viewer-prototype.html` for the interaction and visual reference.

## Roadmap

- v0.1 Markdown + HTML workspace
- v0.2 file watching and conflict handling
- v0.3 richer PDF renderer
- v0.4 richer spreadsheet formatting and Office-native editing workflows
