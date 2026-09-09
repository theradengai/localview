# Screenshot paste validation

Verified on 2026-09-07 UTC, Apple Silicon macOS, Node.js 24.19.0.

## Behavior

- Markdown Edit and Split accept clipboard images with Command-V.
- PNG, JPEG, GIF and WebP batches are limited to 8 images / 10 MB total.
- Desktop saves unique files to `assets/` beside the current document, then inserts relative references in one CodeMirror transaction.
- The existing 600 ms auto-save coordinator persists Markdown. Command-S and window close wait for an in-flight paste before saving.
- Failed writes preserve source and selection. Undo restores source and retains attachment files. Partial disk results are retained if a later write fails.
- Window workspace generation, document identity, directory scope, symlinks, bundle boundaries and exclusive creation are checked by the backend.
- Browser demo attachments use in-memory object URLs. Live Preview table-cell inputs direct image pastes to the body or Split source; Preview remains read-only.

## Automated checks

| Check | Result |
| --- | --- |
| `npm install --offline --no-audit --no-fund --cache /tmp/localview-image-paste-npm-cache` | Passed |
| `npm test -- --maxWorkers=4` | 29 files / 342 tests passed |
| `npm run build` | Passed, including WebKit compatibility check |
| `cargo check --locked --offline --manifest-path src-tauri/Cargo.toml` | Passed |
| `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml` | 90 passed, 2 existing real-Trash tests ignored |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml` | Passed |
| `npm run tauri:build` | Passed; ARM64 app and DMG produced |
| `codesign --verify --deep --strict` on the app | Passed |
| `hdiutil verify` on the DMG | Passed |
| `git diff --check` | Passed |

The new tests cover clipboard extraction and limits, byte preservation, Edit/Split insertion, undo, failed writes, stale editor results, text paste, read-only surfaces, close/save coordination and backend filesystem boundaries. An existing rename test fixture now returns the renamed directory entry during its delayed refresh, removing a timing-dependent false deletion from its mock filesystem.

## Browser and native WebKit evidence

- Playwright with the actual React application: a 120 × 60 clipboard PNG rendered successfully via a demo object URL; source contained a relative `assets/screenshot-…` reference; one undo restored the exact previous source.
- A temporary AppKit/WKWebView harness loaded the actual application frontend and invoked the WebKit native `paste:` responder, using generated 40 × 20 bitmap data. It preserved and restored the clipboard unless another application changed it during the test.
- PNG + TIFF pasteboard: trusted paste event, `types: ["Files"]`, one `image/png` file; image rendered at 40 × 20 and source reference was inserted.
- TIFF-only pasteboard: trusted paste event, one `image/png` file after WebKit conversion; the second image rendered at 40 × 20 and its reference was inserted.

The native WebKit check used the browser demo. Desktop persistence was verified separately with Rust filesystem tests and frontend integration tests. The newly packaged app was not installed over or launched in place of the user's existing LocalView. Intel hardware and macOS 12 were not exercised in this run.

## Local artifact

- App: `src-tauri/target/release/bundle/macos/LocalView.app`
- DMG: `src-tauri/target/release/bundle/dmg/LocalView_0.2.0-beta.1_aarch64.dmg`
- DMG SHA-256: `71a2a63ecb254f8bac5df471c61beac1a1685b9fdcb1eca525fe47593adc2198`

This is a local build from the existing working tree. No release, tag, push or installation was performed. Existing unrelated edits were retained. The first sandboxed DMG attempt failed at `bundle_dmg.sh`; the authorized retry succeeded. Existing ad-hoc signing and non-notarized Beta packaging remain in effect.
