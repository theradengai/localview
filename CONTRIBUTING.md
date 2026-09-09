# Contributing to LocalView

Welcome! Please discuss larger features in an issue before starting them. Small bug fixes with a reproducible case are especially helpful during Beta.

## Product boundaries

LocalView opens ordinary files in their folder context. The filesystem is the source of truth. Preserve the compact interface in [the prototype](prototype/local-folder-viewer-prototype.html), lazy directory loading, per-window isolation, auto-save, and external-conflict protection. Do not introduce a vault, mandatory indexing, or a second document data model.

## Setup and tests

On macOS, install Node.js 24, Rust (CI uses 1.91.1), and Xcode Command Line Tools. `.nvmrc` selects the Node major version. Keep both lockfiles committed.

```bash
npm ci
npm run dev          # in-memory browser demo
npm run tauri:dev    # native filesystem application
```

Before submitting:

```bash
npm test
npm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Use disposable sample folders for native filesystem tests. Tests that interact with the real macOS Trash are ignored by default. Native printing, file associations, IME input, and window interactions require native checks in addition to browser/unit tests.

## Build installers

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:build -- --target aarch64-apple-darwin
npm run tauri:build -- --target x86_64-apple-darwin
```

DMGs are written to `src-tauri/target/<target>/release/bundle/dmg/`. The default local build (`npm run tauri:build`) uses `src-tauri/target/release/bundle/`. The GitHub **Build LocalView for macOS** workflow builds both architectures and uploads DMG artifacts without creating a public release.

Use `npm run tauri:build` for distributable builds. Its wrapper remaps Rust compile paths to neutral build directories so local account names are not embedded in executables. The bundle verifier checks for personal home paths and the current build account before CI uploads installers. Run it locally for each architecture too:

```bash
node scripts/verify-macos-bundle.mjs src-tauri/target/aarch64-apple-darwin/release/bundle/macos/LocalView.app arm64
node scripts/verify-macos-bundle.mjs src-tauri/target/x86_64-apple-darwin/release/bundle/macos/LocalView.app x86_64
```

Use your GitHub noreply email for commits. Raw browser captures, local QA output, private recovery backups, and installers remain ignored; add only reviewed synthetic demonstration assets to `docs/images/`.

All current Beta builds use ad-hoc signing, not Developer ID signing or Apple notarization. See [installation notes](docs/INSTALL.md).

Before packaging a dependency change, regenerate and review `THIRD_PARTY_NOTICES.md` with `node scripts/generate-third-party-notices.mjs`. The generator needs installed npm dependencies and downloaded Cargo sources. Preserve upstream copyright notices and applicable source-availability requirements.

## Pull requests and releases

- Create a focused feature branch and explain the user-visible before/after behavior.
- Include relevant checks and a minimal synthetic fixture for a regression. Never commit personal documents, credentials, signing keys, local `.tasks`, or build output.
- Target `staging`. Changes are verified on staging before reaching `main`.
- Maintainers release a version only after the same candidate passes checks and desktop smoke. Fast-forward `main` to the verified staging commit, create the version tag, and attach both architecture DMGs plus `SHA256SUMS.txt`.
- Keep `package.json`, `Cargo.toml`, `tauri.conf.json`, lockfiles, release notes, and download links consistent. A locally installed app must be verified separately from a release artifact.

By contributing code you have the right to contribute, you agree to license your original contributions under the project's MIT License. Third-party material keeps its own license and needs explicit attribution. Keep discussions constructive and respectful.
