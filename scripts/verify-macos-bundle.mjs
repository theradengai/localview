import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { checkBundlePrivacy } from './check-bundle-privacy.mjs';

const [appArgument, expectedArchitecture] = process.argv.slice(2);
if (!appArgument || !['arm64', 'x86_64'].includes(expectedArchitecture)) {
  throw new Error('Usage: node scripts/verify-macos-bundle.mjs <LocalView.app> <arm64|x86_64>');
}
const appPath = path.resolve(appArgument);
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents/Info.plist')]));
const executable = path.join(appPath, 'Contents/MacOS', plist.CFBundleExecutable);
const architectures = run('/usr/bin/lipo', ['-archs', executable]);
if (architectures !== expectedArchitecture) throw new Error(`Unexpected architecture: ${architectures}`);
if (plist.CFBundleShortVersionString !== config.version) throw new Error('Bundle version does not match release config');
if (plist.LSMinimumSystemVersion !== '12.0') throw new Error('Expected macOS 12.0 deployment minimum');
const csv = plist.CFBundleDocumentTypes.find(type => type.CFBundleTypeExtensions?.includes('csv'));
if (csv?.CFBundleTypeRole !== 'Viewer' || !csv.LSItemContentTypes?.includes('public.comma-separated-values-text')) {
  throw new Error('CSV Viewer association or UTI is missing');
}
for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  const bundled = path.join(appPath, 'Contents/Resources', notice);
  if (!statSync(bundled).isFile() || !readFileSync(bundled).equals(readFileSync(notice))) {
    throw new Error(`Bundled notice is missing or stale: ${notice}`);
  }
}
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
checkBundlePrivacy(appPath);
console.log(`Verified LocalView ${config.version}: ${architectures}, macOS 12+, CSV association, signature, license notices, private build paths excluded.`);
