import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkBundlePrivacy(bundlePath) {
  const home = homedir();
  const account = path.basename(home);
  const failures = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const bytes = readFileSync(file);
        const text = bytes.toString('latin1');
        const homePath = /(?:\/Users\/(?!runner\/|Shared\/)[^\s/\x00]{1,80}\/|\/home\/(?!runner\/)[^\s/\x00]{1,80}\/|[A-Z]:\\Users\\(?!runner\\|Public\\)[^\s\\\x00]{1,80}\\)/i.test(text);
        const localHome = home.length > 1 && bytes.includes(Buffer.from(home));
        const localAccount = !['runner', 'root', 'build', 'builder'].includes(account)
          && account.length >= 4 && bytes.includes(Buffer.from(account));
        if (homePath || localHome || localAccount) failures.push(path.relative(bundlePath, file));
      }
    }
  };
  visit(bundlePath);
  if (failures.length) {
    // Report filenames only; do not repeat private strings into CI logs.
    throw new Error(`Private build identity found in bundle files: ${failures.join(', ')}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/check-bundle-privacy.mjs <LocalView.app>');
  checkBundlePrivacy(path.resolve(process.argv[2]));
  console.log('Bundle privacy check passed: no personal home paths or local build identity.');
}
