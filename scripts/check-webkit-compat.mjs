import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDirectory = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const unsupportedSyntax = [
  { token: '(?<=', description: 'positive regular-expression lookbehind' },
  { token: '(?<!', description: 'negative regular-expression lookbehind' },
];

const assetNames = (await readdir(assetsDirectory))
  .filter((assetName) => assetName.endsWith('.js'));
const violations = [];

for (const assetName of assetNames) {
  const contents = await readFile(path.join(assetsDirectory, assetName), 'utf8');

  for (const syntax of unsupportedSyntax) {
    if (contents.includes(syntax.token)) {
      violations.push(`${assetName}: ${syntax.description} (${syntax.token})`);
    }
  }
}

if (violations.length > 0) {
  console.error('WebKit compatibility check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`WebKit compatibility check passed (${assetNames.length} JavaScript assets).`);
}
