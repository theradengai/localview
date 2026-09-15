# Interface languages / 界面语言

The development version supports **System / 简体中文 / English** in the title bar.
This change is not included in the already-published Beta 5 installers; a new release is required.

开发版可在标题栏选择 **跟随系统 / 简体中文 / English**。已经发布的 Beta 5 安装包不包含本次改动，需要后续新版本。

## Behavior

- First launch follows the preferred supported system language: Chinese variants use Simplified Chinese; English uses English. Other languages fall back to English.
- An explicit selection takes effect immediately and is stored in application-local storage, not in workspace files. Returning to System restores automatic language selection.
- Existing windows synchronize through storage events, with an additional native Tauri event for desktop windows. New windows and subsequent launches read the saved preference.
- No window reload or locale-keyed editor remount. Switching does not save, translate, rename, or rewrite documents; the active editor, selection and undo history remain intact.
- LocalView-owned menus, file actions, buttons, status labels, dialogs, Markdown formatting tools, tables, board controls and preview wrappers are translated. Native menu labels are changed in place without changing their IDs, shortcuts, actions, or quit coordination.
- Native system-owned surfaces such as Finder, file-picker controls, printing settings and Quick Look provider content can follow the operating system language. Raw filesystem/library diagnostic details are retained verbatim for troubleshooting.

## Document content stays content

File names, paths, Markdown/HTML bodies, spreadsheet cells, sheet names, board titles, columns, cards and descriptions are never translated by switching the interface.

Newly created boards and inserted template text use the language selected at creation time. Their Markdown then becomes ordinary document content; later switches do not translate it. The `localview: kanban` format marker never changes.

## Maintenance and validation

`src/lib/locales/en.json` maps explicit application-owned Chinese message keys to English. `t()` inserts arguments once, never recursively translates values, and leaves unknown diagnostics untouched. Components subscribe through `useI18n`; runtime labels in Live Preview update only explicitly registered application-owned nodes, without rebuilding editor state or replacing active table inputs.

Locale tests cover system detection, persistence failures, storage propagation, placeholders, opaque user data, the real CodeMirror instance/selection/history, application drafts and spreadsheet paging without a second file read. The isolated Chromium/WebKit checks cover both languages, preference persistence/propagation and board source preservation. They use only synthetic browser-demo documents, not an installed LocalView or private local files.

macOS CI checks the native command and reversible label mapping. OS dialogs, multiple real desktop windows and the native language picker still require a macOS acceptance pass before a release is claimed.
