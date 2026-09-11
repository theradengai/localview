# Changelog

## 0.2.0-beta.2 — candidate (not released)

- Directory/file multi-selection and batch move/Trash.
- Save-before-preflight Trash ordering and retained move identities.
- Candidate installers only; pending desktop acceptance and staging promotion.

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
