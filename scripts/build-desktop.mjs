import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const separator = '\u001f';
// Cargo splits RUSTFLAGS on whitespace; encoded flags preserve spaces in paths.
const flags = process.env.CARGO_ENCODED_RUSTFLAGS !== undefined
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split(separator).filter(Boolean)
  : (process.env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
const remappings = new Map();
const remap = (source, destination) => {
  remappings.set(path.resolve(source), destination);
  remappings.set(realpathSync(source), destination);
};
remap(homedir(), '/build-user');
if (process.env.CARGO_HOME) remap(process.env.CARGO_HOME, '/build/cargo');
if (process.env.RUSTUP_HOME) remap(process.env.RUSTUP_HOME, '/build/rustup');
// More specific entries go last: rustc uses the last matching path prefix.
remap(process.cwd(), '/build/localview');
for (const [source, destination] of remappings) {
  flags.push(`--remap-path-prefix=${source}=${destination}`);
}
const result = spawnSync(process.execPath, [
  require.resolve('@tauri-apps/cli/tauri.js'), 'build', ...process.argv.slice(2),
], {
  stdio: 'inherit',
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join(separator) },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
