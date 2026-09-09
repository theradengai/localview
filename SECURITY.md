# Security policy

## Supported versions

Security fixes currently target the latest Beta release. Older previews may not receive backports.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/theradengai/localview/security/advisories/new) from **Security → Report a vulnerability**.

Include the app version, macOS version, CPU architecture, affected feature, and a minimal reproduction using synthetic files. Describe whether the issue can read outside the selected workspace, overwrite changes, execute privileged commands, or expose data between windows.

Do not put credentials, personal documents, or an exploitable vulnerability in a public issue. If private reporting is unavailable, open a public issue requesting a private reporting channel without including exploit details or sensitive attachments.

## Security boundaries

- Original files are edited in place. Save coordination must not silently overwrite external changes or discard unsaved edits.
- HTML preview is sandboxed with document/window-scoped resource access; preview scripts must not reach privileged Tauri commands.
- Workspace capabilities, watchers, preview resources, and sessions are isolated per window.
- Moving and renaming must reject workspace escapes, unsupported symlinks, destination collisions, and uncertain results.

Beta installers currently use ad-hoc signing and are not Apple-notarized. A checksum detects a mismatched download; it does not replace a verified publisher signature. See [installation and verification](docs/INSTALL.md).
