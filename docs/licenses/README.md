# Maintaining third-party notices

`THIRD_PARTY_NOTICES.md` at the repository root is the self-contained document
to include in the application bundle and release materials. It includes full
license texts, copyright notices, locked package versions, exact Cargo source
archive links, and the release toolchain's Rust standard-library notice.

This is an engineering inventory, not a complete legal audit. In particular,
the upstream objc2 Apple-SDK provenance caveat remains visible in the notice.

## Reproduce the document

Use the same Rust toolchain as the release and install its `rust-docs`
component. Install dependencies from the committed lockfiles:

```sh
npm ci
cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin --target x86_64-apple-darwin
node scripts/generate-third-party-notices.mjs
node scripts/generate-third-party-notices.mjs --check
```

The generation and `--check` commands are offline. Do not run generation while
another process is editing the lockfiles. A toolchain change also changes the
standard-library notices, even if the application dependencies stay unchanged.

The inventory deliberately includes the union of the two macOS Cargo metadata
graphs, including build/proc-macro dependencies. npm packages marked dev-only
are excluded, while types and peer dependencies reached by production packages
are retained. This is a conservative inventory, not a binary-linkage report.

## Missing upstream license files

Some npm packages and crates omit the license text present in their upstream
repository. `upstream-license-cache.json` stores reviewed plain-text documents
from immutable Git commit URLs, together with their SHA-256 checksums. The
generator uses the crate's `.cargo_vcs_info.json` revision when available.

For the two UIW packages, release tag `v4.25.11` resolves through annotated tag
`ae79f567e6936746f08eda94b306530dad4770ae` to commit
`990500ad9ae72400272c873df3ae061860ff00c2`. The cached MIT license is from that
commit, not a moving branch.

When a dependency changes or a new upstream document is needed:

1. Verify its declared license, published source, and immutable source revision.
2. Add or update the narrow fallback in the generator if needed. Do not invent
   a copyright holder from an author field.
3. Run `node scripts/generate-third-party-notices.mjs --refresh-upstream` with
   HTTPS access to the upstream repositories.
4. Review the cache and generated-notice diff, then run `--check` offline.

The generator fails when an included dependency has no license text, a cached
document's checksum is invalid, or a reviewed app asset has changed. Exact
duplicate legal texts are deduplicated only in the generated appendix; every
package retains its own version, declared license, source, and references.

The objc2 family selects MIT where an upstream choice is offered and includes
the upstream licensing explanation plus full MIT terms. `selectors` source
headers specify MPL-2.0 but its crate omits a standalone license file; the
complete standard MPL-2.0 text from `cssparser` is included with that fact
explicitly labeled. Other packages' supplied alternative texts are retained.

## Asset provenance

- The icon SVG and its PNG/ICNS exports first appear in LocalView commit
  `88dc30d8e493d88f8789f7123ef53e682653ac88`. The SVG is a simple L-shaped path
  and two rounded rectangles, without linked or embedded external artwork.
- `basic.xlsx`, `basic.xls`, `basic.ods`, and `corrupt.xlsx` first appear in
  `ed9d0fb01a3b6bfa59dd241091c4ad06e77108f3`. The original Office-preview task
  required purpose-generated minimal fixtures, and its recorded verification
  hashes match the current files. ODS metadata identifies LibreOfficeDev.
- `basic.csv` is the small CSV regression fixture. Shared filename JSON test
  data and in-memory browser demo content are project source, not downloaded
  document assets.

The generator pins the reviewed binary/icon/CSV hashes so replacements cannot
silently inherit this provenance statement. A source history record is not a
separate legal determination of authorship. No sample-document download source
or additional third-party artwork license was found during this preparation.
