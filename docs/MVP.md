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
- Create an ordinary folder inline from the workspace root or any real folder without interrupting the current document
- Show the create control for each folder without eagerly loading its children
- Refresh loaded tree branches in real time from workspace filesystem events
- Reload loaded directories in place without clearing selection, expansion, editor, or scroll state
- Move files and workspace subfolders to macOS Trash; never permanently delete or delete the workspace root
- Restore the last root, selected file, expanded folders, and view mode without caching file bodies or the tree
- Create an independent empty workspace window from the workspace menu or `Command-N`
- Keep filesystem capability, watcher events, preview resources, Quick Look, edits, auto-save, dialogs, and close state isolated by window
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
- Compact single-line formatting toolbar after a non-empty selection, without stealing editor focus; it is the only LocalView Markdown formatting surface and includes source styles, highlight, six fixed font colors, links, quotes, code blocks, and lists
- Native operating-system context menus for ordinary right-click, `Shift` + right-click, the Context Menu key, and `Shift` + `F10`; LocalView does not intercept those paths for formatting
- Document-toolbar **表格** control in Edit and Split for table insertion and table structure actions
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

The automatic selection toolbar transforms Markdown source in one undoable editor transaction and provides common text and list actions, links, highlight, and six fixed font colors. Highlight uses exact `<mark>...</mark>` source; color uses exact `<span data-localview-color="red|orange|green|blue|purple|gray">...</span>` source. Only balanced LocalView-owned pairs within the parser bounds render specially; arbitrary raw HTML remains escaped, and malformed, unknown, crossing, nested-too-deep, or oversized markers fail closed to editable source. GFM table insertion and strict top-level row, column, deletion, and alignment actions are opened by the document-toolbar **表格** control in Edit and Split. Every mouse and keyboard context-menu path remains native.

Creation is limited to empty Markdown files and ordinary folders. Other file types, rename, move, and copy are outside this MVP. Files and workspace subfolders may be moved to Trash, but permanent deletion and workspace-root deletion are unavailable. On desktop the selected action is created immediately; Markdown edits then auto-save after 600 ms and `Command-S` flushes immediately. Folder creation leaves the current document and dirty editor untouched. The browser demo mirrors these interactions only in memory.

On macOS/Unix, the desktop commands pin the canonical workspace directory, traverse each parent component without following a replacement symlink, recheck directory identities, and perform one exclusive final create. A changed root or parent is rejected before the disk commit point. Folder names additionally reserve `.DS_Store`, LocalView temporary-file patterns, and `.numbers`/`.pages`/`.key` bundle suffixes. The application limit does not replace volume-specific filename rules; stricter filesystem errors remain visible.

Workspace changes form one serialized latest-request queue shared by startup, Finder open events, and the folder picker. The old committed tree/document stays visible but locked during preparation. Success commits the new root/tree together; failure restores the previous backend root and preserves the inline draft, while a failed rollback clears the untrusted UI.

LocalView remains a single process with multiple native windows. Opening a folder replaces only the current window's workspace. A running-app Finder request creates another window and never displaces an existing editor. Reload restores only the current window's private session; a complete relaunch restores the most recently active non-empty workspace in one window rather than recreating the previous window set.

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

- Open every supported Markdown, HTML, text/code, image, PDF, Office, OpenDocument, and iWork extension from Finder
- App receives file path
- Find workspace root
- Open tree and select file
- Route each additional Finder path to a newly created workspace window in the same application process
- Focus the last active window on Dock reopen, or create one last-active restore window when none remains
- Treat `Command-Q` as an application-wide prepare/save transaction; any cancel aborts the whole quit without clearing another window's dirty content
- Register Markdown, HTML, and common text/code formats with the Editor role; register images, PDF, Office, OpenDocument, and iWork formats with the Viewer role
- Keep every association at alternate-handler rank; changing the default application remains an explicit Finder action by the user

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
