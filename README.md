# LocalView

A lightweight, macOS-first local file workspace.

> Open a file, see the folder context.

LocalView browses the real filesystem without Vaults, imports, hidden workspace metadata, or mandatory indexing.

## Current MVP

- Open any local folder
- Lazy-load the real directory tree
- Read and edit Markdown, HTML, and text files
- Markdown Edit / Split / Preview modes
- HTML interactive preview with relative CSS, images, and JavaScript
- Save directly to the original file with `⌘S`
- Detect external edits, reload clean files, and block conflicting saves
- Protect unsaved edits when switching files, changing workspaces, or closing the window
- Preview local images and PDFs
- Read `.xls`, `.xlsx`, and `.ods` as a read-only data grid with sheet switching and bounded pagination
- Preview Numbers, Pages, Keynote, Word, and PowerPoint documents through macOS Quick Look
- Fall back to native Quick Look or the file's default application when a system thumbnail or spreadsheet parse is unavailable
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
- Excel and ODS are data-only, read-only grids. Editing, formula calculation, macros, charts, embedded objects, and complete formatting fidelity are not implemented; formulas show only saved cached values when available.
- Numbers, Pages, Keynote, Word, and PowerPoint use macOS Quick Look and are read-only in LocalView.
- Large workbooks, malformed files, unsupported encryption, or parser limits return a visible error and offer system preview/default-app fallback; LocalView never labels a failed parse as rendered.
- PDF uses the operating system webview renderer.
- macOS test bundles use an ad-hoc signature and are not notarized, so Gatekeeper may require an explicit first open. Public distribution still requires a Developer ID signature and notarization.

See `docs/MVP.md` for the detailed requirements and `prototype/local-folder-viewer-prototype.html` for the interaction and visual reference.

## Roadmap

- v0.1 Markdown + HTML workspace
- v0.2 file watching and conflict handling
- v0.3 richer PDF renderer
- v0.4 richer spreadsheet formatting and Office-native editing workflows
