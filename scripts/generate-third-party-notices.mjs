#!/usr/bin/env node
// Generate the distributable notice from installed, locked dependency sources.
// Run npm ci and cargo fetch --locked first. Network access is opt-in.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'THIRD_PARTY_NOTICES.md');
const cachePath = path.join(root, 'docs/licenses/upstream-license-cache.json');
const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--check', '--refresh-upstream'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
}
if (args.has('--check') && args.has('--refresh-upstream')) {
  throw new Error('--check and --refresh-upstream cannot be combined');
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const read = (filename) => fs.readFileSync(filename, 'utf8');
const json = (filename) => JSON.parse(read(filename));
const normalize = (text) => text.replace(/\r\n/g, '\n').trimEnd() + '\n';
const code = (text) => {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}text\n${normalize(text)}${fence}`;
};
const run = (command, commandArgs) => execFileSync(command, commandArgs, {
  cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const cache = fs.existsSync(cachePath) ? json(cachePath) : {};
const inputHashes = Object.fromEntries(['package-lock.json', 'src-tauri/Cargo.lock'].map((filename) => [
  filename, hash(fs.readFileSync(path.join(root, filename))),
]));
const usedUrls = new Set();
const bodies = new Map();
const addText = (label, text) => {
  if (!text.trim() || text.includes('\0')) throw new Error(`Invalid license text: ${label}`);
  const normalized = normalize(text);
  const digest = hash(normalized);
  if (!bodies.has(digest)) bodies.set(digest, { text: normalized, labels: new Set() });
  bodies.get(digest).labels.add(label);
  return digest;
};
const rawUrl = (repo, revision, filename) => {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`Not an immutable upstream revision: ${repo}`);
  return `https://raw.githubusercontent.com/${repo}/${revision}/${filename}`;
};
const upstream = (url) => {
  const alreadyUsed = usedUrls.has(url);
  usedUrls.add(url);
  if (args.has('--refresh-upstream') && !alreadyUsed) {
    const text = run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--tlsv1.2', '--max-time', '30', url]);
    if (!text.trim() || /<!doctype html|<html/i.test(text)) throw new Error(`Expected plain-text license: ${url}`);
    cache[url] = { sha256: hash(text), text };
  }
  const entry = cache[url];
  if (!entry || hash(entry.text) !== entry.sha256) {
    throw new Error(`Missing or invalid upstream license cache: ${url}. Review the source, then use --refresh-upstream.`);
  }
  return { label: url, text: entry.text };
};

// Search packaged legal documents, including notices in vendored subdirectories.
// Do not follow symlinks or collect implementation files merely named license.rs.
function legalFiles(directory, relative = '') {
  const found = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!['.git', 'node_modules', 'target'].includes(entry.name)) found.push(...legalFiles(directory, name));
    } else if (entry.isFile()
      && /^(?:unlicen[cs]e|licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i.test(entry.name)
      && !/\.(?:rs|c|h|js|ts|json|toml|png|svg)$/i.test(entry.name)) {
      found.push({ label: name, text: read(path.join(directory, name)) });
    }
  }
  return found;
}

// Source-header copyright notices can be more specific than a root license.
// Keep distinct notices without inventing a copyright owner from an author field.
function sourceCopyrights(directory, relative = '') {
  const notices = new Set();
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory() && !['.git', 'node_modules', 'target'].includes(entry.name)) {
      for (const notice of sourceCopyrights(directory, name)) notices.add(notice);
    } else if (entry.isFile() && /\.(?:rs|c|h|cpp|m|mm|js|ts|tsx|md|txt)$/i.test(entry.name)) {
      const text = read(path.join(directory, name));
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*(?:(?:\/\/!?|\/\*+|\*|#)\s*)?Copyright\s+(?:\(c\)|©|[0-9])/i.test(line) && line.length < 600) notices.add(line.trim());
      }
    }
  }
  return notices;
}

const records = [];
const npmLock = json(path.join(root, 'package-lock.json'));
if (npmLock.lockfileVersion !== 3) throw new Error('Expected npm lockfileVersion 3; review traversal before updating');
for (const [location, locked] of Object.entries(npmLock.packages).sort(([a], [b]) => compare(a, b))) {
  if (!location || locked.dev) continue;
  const directory = path.join(root, location);
  const installed = json(path.join(directory, 'package.json'));
  if (installed.version !== locked.version) throw new Error(`Installed npm version does not match lockfile: ${location}`);
  if (!locked.license) throw new Error(`Missing declared npm license: ${location}`);
  const docs = legalFiles(directory);
  let selection = '';
  if (!docs.length && ['@uiw/react-codemirror', '@uiw/codemirror-extensions-basic-setup'].includes(installed.name) && installed.version === '4.25.11') {
    docs.push(upstream(rawUrl('uiwjs/react-codemirror', '990500ad9ae72400272c873df3ae061860ff00c2', 'LICENSE')));
    selection = 'The npm package omits its license file; the upstream v4.25.11 tag was resolved to the immutable commit shown in the source URL.';
  }
  if (!docs.length) throw new Error(`No license text for npm ${installed.name}@${installed.version}`);
  records.push({ ecosystem: 'npm', name: installed.name, version: locked.version, license: locked.license,
    source: locked.resolved, integrity: locked.integrity, selection,
    authors: installed.author ? [typeof installed.author === 'string' ? installed.author : installed.author.name] : [],
    copyrights: [...sourceCopyrights(directory)].sort(compare),
    docs: docs.map((doc) => ({ label: doc.label, id: addText(`npm ${installed.name}@${locked.version}: ${doc.label}`, doc.text) })),
  });
}

const cargoPackages = new Map();
for (const target of targets) {
  const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml', '--filter-platform', target]));
  // metadata is a conservative target graph, including build/proc-macro dependencies.
  for (const pkg of metadata.packages) {
    if (metadata.workspace_members.includes(pkg.id)) continue;
    if (pkg.source !== 'registry+https://github.com/rust-lang/crates.io-index') {
      throw new Error(`Review source handling for non-crates.io package: ${pkg.name}@${pkg.version}`);
    }
    cargoPackages.set(`${pkg.name}@${pkg.version}`, pkg);
  }
}
const mitTemplate = () => upstream(rawUrl('open-i18n/rust-unic', '5878605364af97a3358368a6eaef02104af2e016', 'LICENSE-MIT'));
const mplPackage = [...cargoPackages.values()].find((pkg) => pkg.name === 'cssparser' && pkg.license === 'MPL-2.0');
for (const pkg of [...cargoPackages.values()].sort((a, b) => compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`))) {
  if (!pkg.license) throw new Error(`Missing Cargo license: ${pkg.name}@${pkg.version}`);
  const directory = path.dirname(pkg.manifest_path);
  const docs = legalFiles(directory);
  const vcsFile = path.join(directory, '.cargo_vcs_info.json');
  const revision = fs.existsSync(vcsFile) ? json(vcsFile).git.sha1 : null;
  let selection = '';
  if (!docs.length) {
    if (pkg.repository === 'https://github.com/madsmtm/objc2' && /\bMIT\b/.test(pkg.license)) {
      docs.push(upstream(rawUrl('madsmtm/objc2', revision, 'LICENSE.md')));
      docs.push({ ...mitTemplate(), label: 'MIT license terms (canonical no-copyright-header text; not an attribution to UNIC)' });
      selection = 'MIT is selected where the package offers alternatives. The published crate has no license file or explicit source copyright header; the upstream authors field is preserved separately. The upstream LICENSE.md below also records its Apple SDK provenance caveat; this inventory does not resolve that caveat.';
    } else if (pkg.name === 'alloc-stdlib' && pkg.license === 'BSD-3-Clause') {
      docs.push(upstream(rawUrl('dropbox/rust-alloc-no-stdlib', revision, 'LICENSE')));
    } else if (pkg.name.startsWith('unic-') && pkg.license === 'MIT/Apache-2.0') {
      docs.push(upstream(rawUrl('open-i18n/rust-unic', revision, 'LICENSE-MIT')));
      docs.push(upstream(rawUrl('open-i18n/rust-unic', revision, 'LICENSE-APACHE')));
    } else if (pkg.name === 'tauri-plugin' && pkg.license === 'Apache-2.0 OR MIT') {
      docs.push(upstream(rawUrl('tauri-apps/tauri', revision, 'LICENSE_MIT')));
      docs.push(upstream(rawUrl('tauri-apps/tauri', revision, 'LICENSE_APACHE-2.0')));
    } else if (pkg.name === 'selectors' && pkg.license === 'MPL-2.0' && mplPackage) {
      docs.push({ label: 'MPL-2.0 full text (from the cssparser package; selectors source headers specify MPL-2.0)', text: read(path.join(path.dirname(mplPackage.manifest_path), 'LICENSE')) });
      selection = 'The published crate omits a separate license file. Its source headers specify MPL-2.0; the unmodified full MPL-2.0 text is reproduced below.';
    } else {
      throw new Error(`No license text for Cargo ${pkg.name}@${pkg.version}; review and add an exact upstream source`);
    }
  }
  if (pkg.license_file) {
    const filename = path.resolve(directory, pkg.license_file);
    if (path.relative(directory, filename).startsWith('..')) throw new Error(`License file outside crate: ${pkg.name}`);
    if (!docs.some((doc) => doc.label === pkg.license_file)) docs.push({ label: pkg.license_file, text: read(filename) });
  }
  const checksumFile = path.join(directory, '.cargo-checksum.json');
  records.push({ ecosystem: 'Cargo', name: pkg.name, version: pkg.version, license: pkg.license,
    source: `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`,
    integrity: fs.existsSync(checksumFile) ? `sha256:${json(checksumFile).package}` : '',
    revision, selection, authors: pkg.authors,
    copyrights: [...sourceCopyrights(directory)].sort(compare),
    docs: docs.map((doc) => ({ label: doc.label, id: addText(`Cargo ${pkg.name}@${pkg.version}: ${doc.label}`, doc.text) })),
  });
}

const rustVersion = run('rustc', ['--version']).trim();
const sysroot = run('rustc', ['--print', 'sysroot']).trim();
const rustDocs = path.join(sysroot, 'share/doc/rust');
const rustCopyright = read(path.join(rustDocs, 'COPYRIGHT-library.html'));
const rustLegal = ['Apache-2.0.txt', 'MIT.txt', 'LLVM-exception.txt', 'Unicode-3.0.txt'].map((filename) => ({
  label: `Rust standard library: ${filename}`,
  id: addText(`Rust standard library: ${filename}`, read(path.join(rustDocs, 'licenses', filename))),
}));
// COPYRIGHT-library contains its own dependency notices and complete texts.
// Keep the original HTML verbatim instead of a lossy HTML-to-text conversion.
rustLegal.unshift({ label: 'COPYRIGHT-library.html (verbatim upstream document)', id: addText(`${rustVersion}: COPYRIGHT-library.html`, rustCopyright) });

// These hashes bind the prose provenance statement to the files actually reviewed.
// A replacement asset must not silently inherit the old attribution decision.
const reviewedAssets = {
  'src-tauri/icons/icon.svg': '7a4aa17ed0aba2ab078ed74ad70e9ac1457b381c7d90e41d2984734f560e8dc6',
  'src-tauri/icons/icon.png': '067c583fa7331490a4738e0fb6680dc33136b51201cf77660fa2b6ca40542253',
  'src-tauri/icons/icon.icns': '7dcb0476993b78032be954393d4ac5a1a55ad858c5111c37829870c5a54aa0bd',
  'src-tauri/tests/fixtures/basic.xlsx': '128a1920740b794e9fb6530115c846dde2e5105d00ee46178c6baecd477c2220',
  'src-tauri/tests/fixtures/basic.xls': '1ed7ab812571db3344d20cb1b1a754ba853c28401bea042459d7756940cc839b',
  'src-tauri/tests/fixtures/basic.ods': '78147f934f54672066ba0e55ea644728f08934492078a2ed73b3ec1992282042',
  'src-tauri/tests/fixtures/corrupt.xlsx': 'c2cf1cc7475f7d6695c603ebbcaca9d716d19caa8a439b1a3b10ed47d857dc3c',
  'src-tauri/tests/fixtures/basic.csv': '13f08b13dfca51af17a83e18ef7afe2d7e0ddef3d3208a80d514d7f5f0ebbfa9',
};
for (const [filename, digest] of Object.entries(reviewedAssets)) {
  if (hash(fs.readFileSync(path.join(root, filename))) !== digest) throw new Error(`Asset changed; review provenance before updating its notice: ${filename}`);
}
const npmCount = records.filter((record) => record.ecosystem === 'npm').length;
const cargoCount = records.filter((record) => record.ecosystem === 'Cargo').length;
const document = [
  '# Third-party notices for LocalView',
  'This file preserves third-party license and attribution texts. LocalView\'s own MIT license does not replace the licenses of its dependencies. This is an engineering inventory, not a complete legal audit or a warranty that every distribution obligation has been satisfied.',
  '## Scope and regeneration',
  `Generated by \`node scripts/generate-third-party-notices.mjs\`. Includes ${npmCount} locked npm packages not marked dev-only, ${cargoCount} crates in the union of the default-feature macOS target graphs (\`${targets.join('`, `')}\`), and notices from \`${rustVersion}\`. Cargo build dependencies, procedural macros, optional graph entries retained by Cargo metadata, and bundled upstream legal files are included conservatively; inclusion does not assert that every listed component is linked into the application. npm type packages reached by production dependencies are also retained. Development-only npm tools and the Rust compiler itself are outside this inventory.`,
  'Install the exact npm/Cargo lockfiles and the release Rust toolchain (including rust-docs), then run this script. The normal command and `--check` operate offline. Reviewed upstream license documents missing from published packages are cached in `docs/licenses/upstream-license-cache.json` with immutable source-commit URLs and SHA-256 checksums. `--refresh-upstream` explicitly refreshes those documents over HTTPS; review the resulting diff. A new dependency without license text fails generation. `--check` verifies byte-for-byte freshness; a lockfile, toolchain, or source-license change may require regeneration.',
  `Input SHA-256: package-lock.json \`${inputHashes['package-lock.json']}\`; src-tauri/Cargo.lock \`${inputHashes['src-tauri/Cargo.lock']}\`.`,
  'All paths below are package-relative or repository-relative. Duplicate legal texts are stored once in the full-text appendix and linked from every applicable package. Upstream wording and copyright statements are retained, including references to upstream contributor lists.',
  '## Source availability and qualifications',
  'Each Cargo entry links to the exact published source archive for its locked version. Source code for the MPL-2.0 components is available there under MPL-2.0; the full license is included below. LocalView uses those registry packages without a source patch. If a distributor modifies an MPL-covered component, the corresponding modified source and notices must be provided as required by the MPL. See [Mozilla\'s distribution FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) and the full license, not this summary, for the applicable terms.',
  'The objc2 family\'s upstream LICENSE.md explicitly discusses its derivation from Apple SDKs and an unresolved upstream interpretation question. That statement is reproduced below, not silently treated as cleared. Apple\'s macOS/WebKit/Quick Look frameworks, system fonts, and Xcode SDK are platform-provided, not relicensed by LocalView; this inventory does not certify compliance with Apple\'s separate agreements. Recheck both legal provenance and the actual release toolchain before public redistribution.',
  '## Project assets and test fixtures',
  'The app icon SVG is a simple geometric L mark introduced in LocalView commit `88dc30d8e493d88f8789f7123ef53e682653ac88`, alongside its PNG/ICNS exports. It contains no embedded or linked third-party artwork. The spreadsheet fixtures were introduced in commit `ed9d0fb01a3b6bfa59dd241091c4ad06e77108f3`; the original task record specified purpose-generated minimal test files, and the current four original fixture hashes match its recorded verification hashes. The ODS metadata identifies LibreOfficeDev as the generator. The CSV is a small LocalView regression fixture. These observations establish repository provenance, not a separate legal determination of authorship; no downloaded sample-document source or third-party asset license was found. Test fixtures are not application runtime resources. Any later replacement asset needs a new provenance review.',
  ...Object.entries(reviewedAssets).map(([filename, digest]) => `- \`${filename}\`: SHA-256 \`${digest}\``),
  '## Package inventory',
  ...records.map((record) => [
    `### ${record.ecosystem}: ${record.name} ${record.version}`,
    `Declared license: \`${record.license}\`.`,
    `Source: [exact published package](${record.source}).${record.revision ? ` Upstream revision: \`${record.revision}\`.` : ''}`,
    record.integrity ? `Package integrity: \`${record.integrity}\`.` : '',
    record.authors?.length ? `Upstream authors field (not a substituted copyright statement): ${record.authors.join('; ')}.` : '',
    record.selection,
    record.copyrights.length ? `Additional copyright lines retained from package sources:\n\n${code(record.copyrights.join('\n'))}` : '',
    'License and notice texts:\n\n' + record.docs.map((doc) => `- [${doc.label.replace(/[\[\]]/g, '')}](#text-${doc.id})`).join('\n'),
  ].filter(Boolean).join('\n\n')),
  '## Rust standard library',
  `Toolchain: \`${rustVersion}\`. This section includes the standard library\'s original copyright document, including its own dependencies and license texts, plus the principal Rust/LLVM/Unicode terms. The document covers multiple supported Rust targets conservatively; it is not a list of binaries bundled by LocalView. It does not include the compiler\'s unrelated documentation fonts or development tools.`,
  ...rustLegal.map((doc) => `- [${doc.label}](#text-${doc.id})`),
  '## Full-text appendix',
  ...[...bodies.entries()].sort(([a], [b]) => compare(a, b)).map(([id, value]) => [
    `<a id="text-${id}"></a>`,
    `### Legal text ${id.slice(0, 12)}`,
    `SHA-256 of normalized text: \`${id}\`.`,
    'Used by:\n\n' + [...value.labels].sort(compare).map((label) => `- ${label}`).join('\n'),
    code(value.text),
  ].join('\n\n')),
].join('\n\n') + '\n';

// Prevent accidental local path leakage through newly collected metadata.
for (const [filename, digest] of Object.entries(inputHashes)) {
  if (hash(fs.readFileSync(path.join(root, filename))) !== digest) throw new Error(`${filename} changed during generation; retry from stable inputs`);
}
if (/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/.test(document)) {
  throw new Error('Personal absolute path detected in generated notices; inspect source metadata before publishing');
}
if (args.has('--refresh-upstream')) {
  const current = Object.fromEntries([...usedUrls].sort(compare).map((url) => [url, cache[url]]));
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(current, null, 2) + '\n');
}
if (args.has('--check')) {
  if (!fs.existsSync(outputPath) || read(outputPath) !== document) throw new Error('THIRD_PARTY_NOTICES.md is stale; regenerate using the release lockfiles and Rust toolchain');
  console.log(`Notices are current: ${npmCount} npm packages, ${cargoCount} Cargo packages, ${bodies.size} unique legal texts, ${rustVersion}`);
} else {
  fs.writeFileSync(outputPath, document);
  console.log(`Generated THIRD_PARTY_NOTICES.md: ${npmCount} npm packages, ${cargoCount} Cargo packages, ${bodies.size} unique legal texts, ${Buffer.byteLength(document)} bytes`);
}
