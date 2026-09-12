# Changelog

## 0.2.0-beta.5 — 2026-09-12

### Added

- Interactive Markdown Kanban with explicit `localview: kanban` frontmatter. One ordinary `.md` file remains the only document model; ordinary task lists keep their normal preview.
- New board entry in every folder’s create menu, card and column sorting, cross-column moves, right-side card details, subtasks, and confirmed deletion with a move-before-delete option for nonempty columns.
- Preview board, raw-source Edit and left-board/right-source Split share CodeMirror undo/redo, 600 ms auto-save and external-file conflict protection. Keyboard alternatives are available for moving cards and columns.

### Fixed

- Unsubmitted new-card and new-column title fields retain their own native undo instead of undoing previously committed board changes.
- Browser demo saves update the existing in-memory file tree so new boards and edited notes survive switching between demo files.

### Safety and validation

- Source-range edits retain untouched Markdown and moved card blocks; ambiguous syntax and stale operations fail closed. No database, hidden sidecar, new runtime dependency or Rust permission change.
- 495 frontend regressions, 17 interaction cases in each of Chromium and WebKit, the standard macOS Rust checks and isolated real Trash checks form the release validation gate.
- macOS 12+; ad-hoc signing, not Apple notarization. Installer startup checks do not establish full native UI, physical Intel or older macOS acceptance. Card multiselection and automatic completion columns are not included.
- [Kanban format and examples](docs/KANBAN.md).

## 0.2.0-beta.4 — 2026-09-11 (prerelease)

### Added and fixed

- Select directories, files, or mixed groups using Command/Ctrl-click, Shift-click, visible-item select-all, keyboard ranges, and Escape.
- Drag a selected group, move it to a chosen folder, or move it to macOS Trash with one confirmation. Parent/child targets are deduplicated; failures stop the batch and retain unfinished selections.
- Save before preparing Trash identities and retain original move candidates so a later same-name replacement is not silently accepted.
- Retain confirmed batch progress on rejected operations; empty errors never report success.
- Preserve the Markdown/task-list improvements documented under Beta 2 and all changes from the internal Beta 3 candidate.
- Update vulnerable development/test dependencies within compatible ranges and enforce npm audit in CI; production dependency records are unchanged.
- Add production Chromium/WebKit multi-selection regressions, explicitly execute isolated native Trash smoke tests in macOS CI, refresh dependency notices, and update GitHub Actions.

### Validation and compatibility

- Verified installer source: `d50eedc17f40f8032cb698476ccf01d5cfb47c36`. Release publication adds documentation/download-link updates only; the release provenance records the exact tag commit and source comparison.
- 433 frontend tests, 90 standard Rust tests, 2 separately invoked real macOS Trash tests, and 16 Chromium/WebKit interaction cases passed. Both npm audits reported zero vulnerabilities at validation time.
- Both DMGs passed architecture, version, signature, license, disk-image and read-only mounted-content checks. An isolated Apple Silicon startup check passed with synthetic files.
- Public prerelease, not a stable release. Both installers require macOS 12 or later, use ad-hoc signing, and are not Apple-notarized. Full native UI physical-device, Intel hardware, and older macOS acceptance remain separate checks.

## 0.2.0-beta.3 — candidate (not released)

- Directory/file multi-selection and batch move/Trash.
- Save-before-preflight Trash ordering and retained move identities.
- Internal candidate superseded by the Beta 4 prerelease.

## 0.2.0-beta.2 — 2026-09-10

### Fixed

- Task checkboxes can be toggled directly in Markdown Preview and Split. Changes use the existing auto-save coordinator and preserve conflict protection.
- Each preview toggle has its own undo step; undo/redo also works after switching modes. WebKit checkbox focus is restored after a click.
- Recognize pasted task continuations with deep spaces, tabs, non-breaking spaces, or full-width spaces, and compact task markers in both reading and live editing. Explicit code blocks, inline code, HTML, and links retain their original meaning.
- Update only the selected task marker; preserve original indentation, CRLF and mixed line endings, including through task undo/redo.
- Add synthetic regression fixtures and tests for task rendering, editing, auto-save, external conflicts, file navigation, and line-ending offsets.

### Validation and compatibility

- 389 frontend tests passed; Chromium and native macOS WKWebView task interactions passed. See [the validation report](docs/MARKDOWN_FORMAT_VALIDATION.md).
- Apple Silicon and Intel DMGs target macOS 12 or later. Installers remain ad-hoc-signed and not Apple-notarized; Intel hardware interaction testing remains a separate compatibility check.

## 0.2.0-beta.1 — 2026-09-04

First public open-source Beta under the MIT License. Original source is MIT-licensed; third-party notices remain under their upstream licenses.

### Added and improved

- Source-preserving Markdown Live Preview, selection formatting toolbar, highlight and fixed font colors, and in-place editing of supported table cells.
- Inline file/folder rename, internal drag-to-move, and separate workspace windows.
- Rendered Markdown printing through native macOS print settings.
- UTF-8 CSV read-only grids, preserving text values, quoted fields, embedded newlines, and leading zeros.
- Guarded window closing after auto-save, with recovery when closing fails.
- English/Chinese project documentation, contribution and security guidance, and third-party notices bundled with the app.
- Apple Silicon and Intel installers targeting macOS 12 or later; reproducible dependency installation and CI for both architectures.

### Beta limitations

- Installers are ad-hoc-signed and not Apple-notarized. First launch may require an explicit macOS exception.
- The app interface is primarily Simplified Chinese. Windows/Linux are not supported release targets.
- Spreadsheet and Office previews are read-only. CSV accepts UTF-8/comma-delimited input only.
- Complex or unsupported Markdown table syntax may remain source-editable. Printing currently supports Markdown only.
- See [the full feature reference](docs/FEATURES.md) for limits and native-provider-dependent behavior.

## 0.1.0 Preview — 2026-08-26

Earlier private preview. The historical release remains available for reference; use the current Beta for the newer editor, file-operation, CSV, and closing behavior.
