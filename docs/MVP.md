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
- Rename ordinary files, ordinary subfolders, and whole iWork document bundles inline by double-clicking the tree name or active document title, from the row menu, or with F2; Enter or clicking outside commits, Escape cancels, and file/bundle extensions remain locked
- Refresh loaded tree branches in real time from workspace filesystem events
- Reload loaded directories in place without clearing selection, expansion, editor, or scroll state
- Move ordinary files and iWork document bundles between real folders inside the current workspace by dropping them on a folder or the workspace root, with a native destination-folder picker as the desktop keyboard/menu fallback
- Move files and workspace subfolders to macOS Trash; never permanently delete or delete the workspace root
- Restore the last root, selected file, expanded folders, and view mode without caching file bodies or the tree
- Create an independent empty workspace window from the workspace menu or `Command-N`
- Move every main or additional workspace window from the titlebar background or centered title while preserving titlebar button clicks
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
- Preserve ordinary text line breaks in reading, Split and printing; retain GFM block/list semantics without rewriting document whitespace
- Preserve the active editor instance, selection and undo history across mode changes; the retained editor is hidden and read-only in Preview
- Render ordinary list bullets/numbers, semantic nesting, setext headings and escaped punctuation in Edit; inactive table cells share the reading renderer and reveal original Markdown when activated
- Preview as the default mode whenever a Markdown file is opened
- Rendered Markdown printing from the document toolbar, **File → Print…**, and `Command-P` in every Markdown mode
- One immutable print snapshot from the latest in-memory Markdown, without saving, changing mode, or mutating dirty/conflict state; non-Markdown files fail closed
- Compact single-line formatting toolbar after a non-empty selection, without stealing editor focus; an ordinary empty-selection right-click opens the same surface at the pointer, with highlight and font color disabled until text is selected
- Native operating-system context menus for a non-empty selection, `Shift` + right-click, the Context Menu key, `Shift` + `F10`, and interactive widgets; selected-text right-click does not hide the already-visible LocalView toolbar
- Document-toolbar **表格** control in Edit and Split for table insertion and table structure actions
- GFM table insertion plus bounded top-level row, column, and alignment editing
- In-place editing of one header or body cell at a time in Edit Live Preview, while preserving the original Markdown source as the only document model
- Save back to original file
- Auto-save after 600 ms of editing idle time; `Command-S` flushes immediately
- UTF-8
- Relative image paths
- Paste clipboard screenshots/images in Markdown Edit or Split; save uniquely named PNG/JPEG/GIF/WebP attachments in the document's sibling `assets/` directory and insert relative references in one undoable transaction
- At most 8 images / 10 MB per paste; failures preserve the document, native text paste remains unchanged, and image paste in a Live Preview table-cell input directs the user to the body or Split source
- Inline filename entry: Enter creates immediately and Escape cancels
- Add `.md` when the entered name does not already end in `.md`, case-insensitively
- Reject control characters, path separators, reserved dot names, and final names over 255 UTF-16 code units
- Never overwrite an existing same-name file
- Select a newly created file in Edit mode while keeping its initial empty content in a saved state

Live Preview does not introduce a second rich-text document model. It renders headings, emphasis, links, quotes, lists, tasks, fenced code, images, bounded top-level tables, and thematic breaks directly over Markdown source. Unknown, malformed, nested, or oversized structures fail closed to source. Mouse selection across fenced-code content keeps the rendered block DOM stable; clicking its language label is the explicit escape that reveals the fenced source. In Edit, one table header/body cell becomes an auto-height plain-Markdown input and every accepted input replaces only that cell range in CodeMirror; ordinary input patches the existing table DOM so the active textarea, selection, IME composition, and horizontal scroll remain stable. `Enter`/`Tab` navigate cells, boundary Tab restores focus to the current cell, blur exits cleanly, `Escape` exits, and the source escape control reveals the whole table. Split continues to expose the complete editable Markdown source, while Preview remains a read-only complete rendering.

Printing reuses the reading renderer but not the visible preview DOM. A single offscreen snapshot is captured from the current editor buffer, waits up to three seconds for its fonts and images, excludes all application chrome and source editors, then opens the native macOS print settings. The snapshot remains available until the print lifecycle completes or the next print replaces it, so a delayed native print render does not produce a blank page. Printing never triggers auto-save, changes view mode, or silently falls through to whole-window printing for unsupported file kinds.

The automatic selection toolbar transforms Markdown source in one undoable editor transaction and provides common text and list actions, links, highlight, and six fixed font colors. At an empty caret, ordinary right-click prevents the native menu and opens this same toolbar at the pointer; selection-independent commands insert at that caret, while highlight and font color are disabled. With a non-empty selection, ordinary right-click remains native and does not hide the automatic toolbar. `Shift` + right-click, the Context Menu key, `Shift` + `F10`, and interactive-widget context menus also remain native. Highlight uses exact `<mark>...</mark>` source; color uses exact `<span data-localview-color="red|orange|green|blue|purple|gray">...</span>` source. Only balanced LocalView-owned pairs within the parser bounds render specially; arbitrary raw HTML remains escaped, and malformed, unknown, crossing, nested-too-deep, or oversized markers fail closed to editable source. GFM table insertion and strict top-level row, column, deletion, and alignment actions are opened by the document-toolbar **表格** control in Edit and Split.

Creation is limited to empty Markdown files and ordinary folders; other-file creation and copy remain outside this MVP. Ordinary files, ordinary subfolders, and whole iWork document bundles may be renamed in place. File and bundle suffixes are locked, and root, symlink, bundle-interior, unchanged, case-only, reserved, overlong, collision, identity-race, and ambiguous results fail closed. Renaming the current editable file, or a folder containing it, first requires a successful stable save; confirmed results migrate the selected path, save target, loaded descendants, session, and path-keyed renderer. Renaming an unrelated item does not flush the current draft, and an uncertain outcome refreshes the affected directory without claiming success. Ordinary files, non-empty ordinary folders, and iWork document bundles may also move atomically within the same workspace by tree drag or the native destination picker; root, symlink, outside-workspace, same-parent, folder self/descendant, collision, identity-race, and cross-volume cases fail closed without copy-delete or overwrite. Files and workspace subfolders may also be moved to Trash, but permanent deletion and workspace-root deletion are unavailable. On desktop the selected create action is immediate; Markdown edits then auto-save after 600 ms and `Command-S` flushes immediately. Folder creation leaves the current document and dirty editor untouched. The browser demo mirrors creation, rename, Trash, and internal file/folder dragging only in memory.

On macOS/Unix, the desktop create commands pin the canonical workspace directory, traverse each parent component without following a replacement symlink, recheck directory identities, and perform one exclusive final create. Moves and same-parent renames resolve paths from that pinned root, require exclusive no-follow/no-replace rename semantics, validate source, destination, parent, and root identities, and safely reconcile any uncertain outcome instead of claiming success. iWork bundles are atomic boundaries: a whole bundle may move or change stem, but LocalView never mutates an item inside its directory structure or changes its bundle suffix. A changed root, parent, source, or late destination collision is rejected before or safely reconciled after the disk commit point. Folder names additionally reserve `.DS_Store`, LocalView temporary-file patterns, and `.numbers`/`.pages`/`.key` bundle suffixes. The application limit does not replace volume-specific filename rules; stricter filesystem errors remain visible.

Workspace changes form one serialized latest-request queue shared by startup, Finder open events, and the folder picker. The old committed tree/document stays visible but locked during preparation. Success commits the new root/tree together; failure restores the previous backend root and preserves the inline draft, while a failed rollback clears the untrusted UI.

LocalView remains a single process with multiple native windows. Opening a folder replaces only the current window's workspace. A running-app Finder request creates another window and never displaces an existing editor. Reload restores only the current window's private session; a complete relaunch restores the most recently active non-empty workspace in one window rather than recreating the previous window set.

Screenshot attachments are the explicit exception to the file-creation scope above. The backend accepts bounded raster-image batches only for an existing Markdown document in the caller window's current workspace generation. It rejects symlinks, iWork interiors, stale paths, and attachment-directory collisions, writes through exclusive temporary files, and never replaces an existing attachment. The frontend holds its mutation gate until insertion completes; the usual save coordinator handles the Markdown change. Undo removes references only and retains attachment files. If a batch fails after some attachments have been written, those files remain available in `assets/`; no incomplete reference is inserted. The browser demo uses window-local object URLs and an in-memory tree, with no filesystem writes.

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

- UTF-8 `.csv`, `.xls`, `.xlsx`, and `.ods` as a read-only data grid
- CSV as one text-preserving worksheet; BOM, quoted commas, escaped quotes, embedded newlines and ragged rows are accepted
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
- CSV/Excel/ODS read-only grids
- embedded system Quick Look for Numbers/Pages/Keynote/Word/PowerPoint, with system-thumbnail fallback

Future renderers may add richer formatting and editing without changing the workspace model.
