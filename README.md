# LocalView

**No indexing. Just open your files.**

Preview common formats. Edit Markdown, HTML and text in place.

You just want to read a Markdown note, inspect a local HTML prototype, and check the PDF or spreadsheet beside it—not set up a knowledge base or keep switching applications.

LocalView is a lightweight local document workspace for **macOS and Windows**. Open an existing file or folder, browse its real directory tree, and work with the files where they already are. **No vault, no import step, no content index. Your folder is the workspace.**

[简体中文](README.zh-CN.md) · [Download](#download) · [Quick start](#quick-start) · [Supported formats](#preview-and-edit) · [Report a bug](https://github.com/theradengai/localview/issues/new/choose)

![LocalView: Markdown preview, split view, editing, tasks and HTML](docs/images/localview-demo.gif)

*Browser demo using synthetic documents; changes stay in memory. This is not a recording of desktop startup, a system folder picker or a file-manager context menu. [Static screenshot](docs/images/localview-demo.png).*

## Download

**Public Beta builds, not stable releases.** Both platforms include English and Simplified Chinese.

| Platform | Version | Installer |
| --- | --- | --- |
| Windows 10/11 x64 + WebView2 | 0.2.0-beta.8 | [Windows EXE](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.8/LocalView_0.2.0-beta.8_x64-setup.exe) |
| macOS 12+ · Apple Silicon (M-series) | 0.2.0-beta.6 | [Apple Silicon DMG](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.6/LocalView_0.2.0-beta.6_aarch64.dmg) |
| macOS 12+ · Intel | 0.2.0-beta.6 | [Intel DMG](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.6/LocalView_0.2.0-beta.6_x64.dmg) |

[Windows release and checksums](https://github.com/theradengai/localview/releases/tag/v0.2.0-beta.8) · [macOS release and checksums](https://github.com/theradengai/localview/releases/tag/v0.2.0-beta.6)

**Windows:** run the EXE to install for the current user. If WebView2 is missing, the installer downloads Microsoft's bootstrapper and needs an internet connection. This Beta is **unsigned** and may trigger a publisher or SmartScreen warning. Verify the download source and checksum; do not disable system-wide security protection. See the [Windows guide](docs/WINDOWS.md).

**macOS:** quit the older app, open the DMG, drag **LocalView** into **Applications**, eject the disk image, and launch the installed copy. These builds are **ad-hoc signed and not notarized by Apple**; first launch may be blocked. Read the [installation and verification guide](docs/INSTALL.md).

## Quick start

1. Launch **LocalView** and click **Open folder**.
2. Choose an existing local folder in the system picker. Its real directory tree appears; subfolders load when expanded, not through a startup scan of every document.
3. Select a file to preview it. For Markdown, HTML or text, switch to **Edit** or **Split** to make changes. Edits save back to the original file.

Use **Open file** for an individual document; Windows also supports `Ctrl+O`.

### Windows: open a folder from Explorer

With **Beta 8 installed**, right-click a local folder—or the empty background inside it—and choose **Open with LocalView**. Windows 11 may require **Show more options** first.

The menu label follows the installer language, not the in-app language switch. Registration is per-user, leaves default applications unchanged, and is cleaned up by the matching uninstaller. Beta 7 does not gain this entry without an upgrade. [Explorer menu details](docs/WINDOWS.md#explorer-folder-menu--资源管理器右键).

### macOS: open a file from Finder

Right-click a supported file, such as `.md` or `.html`, and choose **Open With → LocalView**. The document opens with its folder context. For a whole folder, use **Open folder** inside LocalView; file associations are not a promise of a built-in Finder folder context-menu item.

## Preview and edit

**Previewing a format does not mean it is editable.**

| Format | Preview | Edit in LocalView |
| --- | --- | --- |
| Markdown | Reading view, task checkboxes and split view | Source-preserving Live Preview, text formatting, supported table cells and source editing |
| Markdown Kanban (`localview: kanban`) | Interactive board and card details | Drag cards/columns, edit details and subtasks; changes update the same `.md` |
| HTML | Sandboxed local page with relative CSS, images and JavaScript interactions | Source editing and split view |
| Plain text / common code files | Text view | Text editing; not a full IDE |
| Images / PDF | Image and PDF preview | No |
| CSV / XLS / XLSX / ODS | Read-only grid, wrapped cells and workbook sheet navigation | No |
| Word / PowerPoint / Pages / Keynote / Numbers | macOS: provider-dependent Quick Look. Windows: open in the default app, not an embedded preview | No |

Local HTML can be viewed and interacted with **without switching to a separate browser**. It remains sandboxed: external network requests, remote APIs, third-party embeds and native application commands are not available to the preview.

## Markdown Kanban

**A board you can use, still stored as a Markdown file.**

Choose **New board** from a folder's `+` menu, or open the [sample board](docs/fixtures/kanban.md). The opening `localview: kanban` header enables the board: `##` headings become columns, top-level task items become cards, and indented descriptions/subtasks move with their card. Ordinary task lists keep their normal preview.

![LocalView Markdown board with four columns, cards, tags and subtask progress](docs/images/localview-kanban-board.png)

*Beta 5 production frontend captured in an isolated WebKit browser with synthetic sample data; not a native desktop recording. Browser edits remain in memory. [Capture provenance](docs/images/KANBAN_CAPTURES.md).*

Drag a card by its handle, reorder columns, or open a card's right-side details panel. **Preview** shows the board, **Edit** shows Markdown, and **Split** shows both. They share the same source, undo history and auto-save.

[Card details](docs/images/localview-kanban-details.png) · [Board and source side by side](docs/images/localview-kanban-split.png) · [Board format and limits](docs/KANBAN.md)

Moving a card to a column does not automatically mark it complete. Board cards do not yet support multiselection. Printing uses the Markdown reading view, not a board image.

## Work directly in your folder

- **Edit and save in place.** Markdown/HTML/text auto-save after 600 ms of idle time; `⌘S` / `Ctrl+S` saves immediately. External-change detection prevents silent overwrites. Switching Markdown modes preserves undo history; task checkboxes also work in Preview.
- **Organize files without importing them.** Create Markdown files and folders, rename inline, use `⌘` / `Ctrl` or `Shift` to select files and folders, and move the selection within the workspace. One confirmation moves a selection to macOS Trash or the Windows Recycle Bin; there is no permanent-delete action. [Selection and safety](docs/FOLDER_SELECTION.md).
- **Paste screenshots into Markdown.** In Edit or Split, `⌘V` / `Ctrl+V` saves clipboard images beside the document in `assets/` and inserts relative references. PNG/JPEG/GIF/WebP; up to 8 images and 10 MB per paste.
- **Compare and print.** `⌘N` / `Ctrl+N` opens an independent workspace window. `⌘P` / `Ctrl+P` opens print settings for rendered Markdown. Printing is currently Markdown-only.

## Interface language

Choose **System / 简体中文 / English** in the title bar. Switching is immediate and remembered across launches; it does not translate your documents or reset the editor. Native OS dialogs and external applications may follow their own language settings. [Language behavior and verification](docs/LANGUAGES.md).

## Current limits

LocalView is a local-file workspace, not a complete Office suite or a general-purpose browser. Images, PDFs and spreadsheet grids are preview-only. Office editing, formula recalculation, macros, charts and complete Office formatting fidelity are not implemented.

CSV requires UTF-8 (BOM accepted) and comma-separated values; leading zeros are preserved as text. Complex Markdown tables may fall back to source editing. Ordinary Markdown line breaks and task indentation are preserved; see the [format regression sample](docs/fixtures/markdown-format-matrix.md) and [validation report](docs/MARKDOWN_FORMAT_VALIDATION.md).

The Windows Beta supports local drive-letter workspaces. UNC/network workspaces, junction/reparse-point traversal, cross-volume moves and native ARM64 Windows packages are not included. No Linux installer is published. Hosted checks do not certify every physical Windows 10/11 device, IME, system dialog or WebView2 version; Intel/Monterey compatibility also benefits from real-device testing. Keep backups when testing a Beta with important documents.

[All features and limits](docs/FEATURES.md) · [Windows verification](docs/WINDOWS.md) · [Release notes](CHANGELOG.md)

## Develop locally

Use **Node.js 24** and **Rust 1.91.1 or later**. macOS needs Xcode Command Line Tools; Windows needs the MSVC Rust toolchain, C++ Build Tools/Windows SDK and WebView2. See [Windows development](docs/WINDOWS.md#development).

```bash
git clone https://github.com/theradengai/localview.git
cd localview
npm ci
npm run tauri:dev
```

`npm run dev` starts the in-memory browser demo; it does not read or write your real folders.

```bash
npm test
npm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Built with **Tauri 2 · React · TypeScript · CodeMirror 6 · Rust**. The [interactive prototype](prototype/local-folder-viewer-prototype.html) defines the visual language. The [MVP specification](docs/MVP.md) describes the product model; use the format table above and release notes for currently shipped capabilities.

## Contribute

Focused improvements and reproducible bug reports are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for build, test and pull-request instructions; target `staging`. Current priorities include reliable file operations, smoother Markdown/table editing and desktop compatibility.

Do not post private documents or credentials in public issues. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License

LocalView's original source is available under the [MIT License](LICENSE). Third-party components retain their own licenses; notices and source links are collected in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and included in the app bundle.
