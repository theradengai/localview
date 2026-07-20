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
- No database
- No import
- No hidden metadata files

### Markdown

Support:

- Open .md files
- Edit content
- Live preview
- Edit / Split / Preview modes
- Save back to original file
- UTF-8
- Relative image paths

### HTML

Support:

- Open .html files
- Source mode
- Preview mode
- Local CSS/images
- Interactive preview

### Spreadsheet and system document preview

Support:

- `.xls`, `.xlsx`, and `.ods` as a read-only data grid
- saved sheet names and typed cell display values
- bounded parsing and bounded 200-row / 50-column pages for large workbooks
- `.numbers`, `.pages`, `.key`, Word, and PowerPoint through macOS Quick Look
- Preview-only behavior that never enters dirty or save state
- visible parse/thumbnail errors with Quick Look and default-application actions

Not included:

- Excel editing or formula recalculation
- macros, charts, embedded objects, or complete formatting fidelity
- in-app editing for Numbers, Pages, Keynote, Word, or PowerPoint

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
- system Quick Look for Numbers/Pages/Keynote/Word/PowerPoint

Future renderers may add richer formatting and editing without changing the workspace model.
