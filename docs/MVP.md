# LocalView MVP Specification

## Product positioning

LocalView is a local-first document workspace.

Core idea:

> Open a file, see the folder context.

It is not a knowledge base. It does not require vaults, imports, or indexing.

The filesystem is the source of truth.

---

## Reference UI

The implementation should follow prototype.html.

Visual style:

- macOS native application feeling
- black/white/gray palette
- thin borders
- rounded controls
- Finder-like simplicity

Main layout:

```
+------------------------------------------------+
| Window Bar                                     |
+----------------+-------------------------------+
| File Tree      | Editor / Preview               |
|                |                               |
| README.md      | Markdown Editor                |
| docs/          | Markdown Preview               |
| prototype.html | HTML Preview                  |
| assets/        |                               |
+----------------+-------------------------------+
| Status Bar                                     |
+------------------------------------------------+
```

---

## MVP Features

### Workspace

- Open any local folder
- Show real directory tree
- Create an empty Markdown file from the workspace root or any real folder
- Show the create control for each folder without eagerly loading its children
- Refresh loaded tree branches in real time from workspace filesystem events
- Reload loaded directories in place without clearing selection, expansion, editor, or scroll state
- Move files and workspace subfolders to macOS Trash; never permanently delete or delete the workspace root
- Restore the last root, selected file, expanded folders, and view mode without caching file bodies or the tree
- No database
- No import
- No hidden metadata files

### Markdown

Support:

- Open .md files
- Edit content
- Source-preserving Live Preview in Edit mode: CodeMirror still owns and saves the original Markdown bytes while inactive syntax is rendered through reversible decorations
- Edit / Split / Preview modes; Split is the full reading preview on the left and softly wrapped raw Markdown source on the right
- Preview as the default mode whenever a Markdown file is opened
- Context-menu formatting in Edit and Split for headings, paragraph text, inline styles, links, quotes, code blocks, and lists
- Compact single-line formatting toolbar after a non-empty selection, without stealing editor focus; table insertion and table structure actions remain in the full right-click menu
- `Shift` + right-click preserves the native macOS context menu
- GFM table insertion plus bounded top-level row, column, and alignment editing
- Save back to original file
- Auto-save after 600 ms of editing idle time; `Command-S` flushes immediately
- UTF-8
- Relative image paths
- Inline filename entry: Enter creates immediately and Escape cancels
- Add `.md` when the entered name does not already end in `.md`, case-insensitively
- Reject control characters, path separators, reserved dot names, and final names over 255 UTF-16 code units
- Never overwrite an existing same-name file
- Select a newly created file in Edit mode while keeping its initial empty content in a saved state

Live Preview does not introduce a second rich-text document model. It renders headings, emphasis, links, quotes, lists, tasks, fenced code, images, bounded top-level tables, and thematic breaks directly over Markdown source; entering an active structure reveals its source again. Unknown, malformed, nested, or oversized structures fail closed to source. Table widget cells are plain text in Live Preview, while the complete Markdown rendering remains available in Preview and Split.

Both formatting surfaces transform Markdown source in one undoable editor transaction. The automatic selection toolbar provides common text and list actions plus links. GFM table insertion and strict top-level row, column, deletion, and alignment actions remain in the full right-click menu. `Shift` + right-click always leaves the native macOS context-menu path available.

Creation is limited to Markdown files. Folder creation, other file types, rename, move, and copy are outside this MVP. Files and workspace subfolders may be moved to Trash, but permanent deletion and workspace-root deletion are unavailable. On desktop the empty file is created immediately; later edits auto-save after 600 ms and `Command-S` flushes immediately. The browser demo mirrors these interactions only in memory.

On macOS/Unix, the desktop command pins the canonical workspace directory, traverses each parent component without following a replacement symlink, rechecks directory identities, and performs one exclusive final create. A changed root or parent is rejected before the disk commit point. The application limit does not replace volume-specific filename rules; stricter filesystem errors remain visible.

Workspace changes form one serialized latest-request queue shared by startup, Finder open events, and the folder picker. The old committed tree/document stays visible but locked during preparation. Success commits the new root/tree together; failure restores the previous backend root and preserves the inline draft, while a failed rollback clears the untrusted UI.

### HTML

Support:

- Open .html files
- Source mode
- Preview mode
- Preview as the default mode whenever an HTML file is opened
- Local CSS/images
- Interactive preview
- Per-document preview capability bound to the active workspace generation
- Relative local CSS, images, fonts, media, and JavaScript served only through that capability
- Sandboxed execution with external network access, forms, nested frames, objects, and top-level navigation blocked by CSP

An invalid, released, or stale HTML preview capability must fail closed with HTTP 403. The preview protocol must not fall back to workspace-wide reads or expose wildcard CORS. Remote API calls and third-party embeds are outside this MVP.

### Spreadsheet and system document preview

Support:

- `.xls`, `.xlsx`, and `.ods` as a read-only data grid
- saved sheet names and typed cell display values
- complete wrapped cell text with automatic row heights, including saved line breaks and long unbroken values
- bounded parsing and bounded 200-row / 50-column pages for large workbooks
- `.numbers`, `.pages`, `.key`, Word, and PowerPoint through an interactive macOS Quick Look view embedded in the LocalView document area
- native Quick Look page or slide navigation when the installed provider exposes it
- Preview-only behavior that never enters dirty or save state
- visible embedded-preview/thumbnail errors with separate Quick Look and default-application actions

Not included:

- Excel editing or formula recalculation
- macros, charts, embedded objects, or complete formatting fidelity
- in-app editing for Numbers, Pages, Keynote, Word, or PowerPoint
- Office animations or full slideshow playback

### macOS integration

Support:

- Open supported Markdown, HTML, Office, OpenDocument, and iWork files from Finder
- App receives file path
- Find workspace root
- Open tree and select file
- Keep LocalView registered as an alternate viewer/editor; changing the default application remains an explicit Finder action by the user

---

## Technical direction

Frontend:

- React
- TypeScript
- CodeMirror 6
- react-markdown

Desktop:

- Tauri 2

Do not introduce:

- database
- vault system
- backlinks
- knowledge graph
- cloud sync

---

## Renderer architecture

The explicit renderer registry currently supports:

- PDF
- Images
- Excel/ODS read-only grids
- embedded system Quick Look for Numbers/Pages/Keynote/Word/PowerPoint, with system-thumbnail fallback

Future renderers may add richer formatting and editing without changing the workspace model.
