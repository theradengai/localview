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

### macOS integration

Future MVP:

- Double click markdown/html file
- App receives file path
- Find workspace root
- Open tree and select file

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

## Future Renderers

Architecture should allow adding:

- PDF
- Excel
- PowerPoint
- Word
- Images

using a renderer system.
