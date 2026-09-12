"""Validate the actual read-only DMG; launch only a disposable CI app copy."""
import hashlib
import json
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time

TARGET, ARCH, SOURCE = sys.argv[1:]
VERSION = '0.2.0-beta.5'
root = pathlib.Path.cwd()
out = root / 'release-out'
out.mkdir(exist_ok=True)
bundle = root / 'src-tauri' / 'target' / TARGET / 'release' / 'bundle'
app = bundle / 'macos' / 'LocalView.app'
images = list((bundle / 'dmg').glob('*.dmg'))
if len(images) != 1:
    raise RuntimeError('Expected exactly one installer')
image = images[0]
expected_name = 'LocalView_' + VERSION + ('_aarch64.dmg' if ARCH == 'arm64' else '_x64.dmg')
if image.name != expected_name:
    raise RuntimeError('Unexpected installer name: ' + image.name)

def run(args):
    return subprocess.check_output(args, text=True).strip()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def verify(path):
    subprocess.run(['node', 'scripts/verify-macos-bundle.mjs', str(path), ARCH], check=True)

if run(['git', 'rev-parse', 'HEAD']) != SOURCE:
    raise RuntimeError('Checkout does not match pinned candidate')
if run(['git', 'status', '--porcelain', '--untracked-files=no']):
    raise RuntimeError('Build changed tracked files')
verify(app)
subprocess.run(['hdiutil', 'verify', str(image)], check=True)
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
exe_name = info['CFBundleExecutable']
exe_sha = sha(app / 'Contents/MacOS' / exe_name)
result = {'version': VERSION, 'source_commit': SOURCE, 'source_tree': run(['git', 'rev-parse', 'HEAD^{tree}']), 'target': TARGET, 'architecture': ARCH, 'macos_minimum': '12.0', 'signing': 'ad-hoc', 'apple_notarized': False, 'installer': image.name, 'sha256': sha(image), 'executable_sha256': exe_sha, 'size': image.stat().st_size, 'bundle_verified': True, 'dmg_verified': True, 'mounted_contents_verified': False, 'startup': 'not executed for cross-compiled Intel target', 'native_kanban_ui_acceptance': 'not performed', 'workflow_run_id': int(os.environ['GITHUB_RUN_ID'])}
with tempfile.TemporaryDirectory(prefix='localview-beta5-') as temp:
    temp = pathlib.Path(temp)
    mount = temp / 'mount'
    mount.mkdir()
    subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(image)], check=True)
    try:
        mounted_app = mount / 'LocalView.app'
        verify(mounted_app)
        if sha(mounted_app / 'Contents/MacOS' / exe_name) != exe_sha:
            raise RuntimeError('DMG executable differs from the verified build')
        result['mounted_contents_verified'] = True
        if ARCH == 'arm64':
            installed_app = temp / 'installed' / 'LocalView.app'
            installed_app.parent.mkdir()
            subprocess.run(['ditto', str(mounted_app), str(installed_app)], check=True)
            verify(installed_app)
            fixture_dir = temp / 'synthetic-workspace'
            fixture_dir.mkdir()
            fixture = fixture_dir / 'Release-smoke.md'
            shutil.copy2(root / 'docs/fixtures/kanban.md', fixture)
            fixture_hash = sha(fixture)
            with (out / 'startup-arm64.stdout.log').open('w') as stdout, (out / 'startup-arm64.stderr.log').open('w') as stderr:
                process = subprocess.Popen([str(installed_app / 'Contents/MacOS' / exe_name), str(fixture)], cwd=fixture_dir, stdout=stdout, stderr=stderr)
                try:
                    for _ in range(12):
                        time.sleep(1)
                        if process.poll() is not None:
                            raise RuntimeError('Candidate exited during isolated startup: ' + str(process.returncode))
                    result['startup'] = 'exact DMG app copy remained running for 12 seconds in isolated macOS CI'
                    result['startup_pid'] = process.pid
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
            if sha(fixture) != fixture_hash:
                raise RuntimeError('Startup unexpectedly changed the synthetic fixture')
            result['startup_fixture_unchanged'] = True
            result['startup_stderr_empty'] = not (out / 'startup-arm64.stderr.log').read_text().strip()
    finally:
        subprocess.run(['hdiutil', 'detach', str(mount)], check=True)
shutil.copy2(image, out / image.name)
(out / ('SHA256SUMS-' + ARCH + '.txt')).write_text(result['sha256'] + '  ' + image.name + '\n')
(out / ('BUILD-INFO-' + ARCH + '.json')).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
