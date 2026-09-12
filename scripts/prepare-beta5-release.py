"""Prepare release metadata only; never change application code or dependencies."""
import json
import os
import pathlib
import re
import subprocess
import tomllib

BASE = 'e0b131e72e0e51b7598f43e5cb9de144718f752e'
BRANCH = 'release/beta5-kanban'
OLD = '0.2.0-beta.4'
NEW = '0.2.0-beta.5'

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def replace(path, old, new, count=None):
    p = pathlib.Path(path)
    text = p.read_text()
    require(old in text, 'Expected original text missing: ' + path)
    if count is not None:
        require(text.count(old) == count, 'Unexpected replacement count: ' + path)
    p.write_text(text.replace(old, new))

require(git('rev-parse', 'HEAD') == BASE, 'Candidate base changed')
require(not git('status', '--porcelain'), 'Initial working tree is not clean')
require(git('ls-remote', 'origin', 'refs/heads/' + BRANCH).split()[0] == BASE, 'Release branch advanced')
package_before = json.loads(pathlib.Path('package.json').read_text())
lock_before = json.loads(pathlib.Path('package-lock.json').read_text())
cargo_before = tomllib.loads(pathlib.Path('src-tauri/Cargo.lock').read_text())
require(package_before['version'] == OLD and lock_before['version'] == OLD and lock_before['packages']['']['version'] == OLD, 'Unexpected npm version')
replace('package.json', '"version": "' + OLD + '"', '"version": "' + NEW + '"', 1)
replace('package-lock.json', '"version": "' + OLD + '"', '"version": "' + NEW + '"', 2)
replace('src-tauri/tauri.conf.json', '"version": "' + OLD + '"', '"version": "' + NEW + '"', 1)
replace('src-tauri/Cargo.toml', 'version = "' + OLD + '"', 'version = "' + NEW + '"', 1)
replace('src-tauri/Cargo.lock', 'name = "localview"\nversion = "' + OLD + '"', 'name = "localview"\nversion = "' + NEW + '"', 1)
package_before['version'] = NEW
lock_before['version'] = NEW
lock_before['packages']['']['version'] = NEW
require(json.loads(pathlib.Path('package.json').read_text()) == package_before, 'npm dependency declarations changed')
require(json.loads(pathlib.Path('package-lock.json').read_text()) == lock_before, 'npm resolution changed')
for package in cargo_before['package']:
    if package['name'] == 'localview':
        require(package['version'] == OLD and 'source' not in package, 'Unexpected root Cargo package')
        package['version'] = NEW
require(tomllib.loads(pathlib.Path('src-tauri/Cargo.lock').read_text()) == cargo_before, 'Cargo dependency resolution changed')
for path in ['README.md', 'README.zh-CN.md', 'docs/INSTALL.md']:
    replace(path, OLD, NEW)
replace('README.md', '## What you can do\n', '## What you can do\n\n- **Use Markdown as an interactive Kanban board.** Create a board from a folder’s `+` menu. Drag cards and columns, edit in the right-hand details panel, and switch to Split to see the same `.md` source. Board and source share undo and auto-save. [Format and limits](docs/KANBAN.md).\n', 1)
replace('README.zh-CN.md', '## 能做什么\n', '## 能做什么\n\n- **Markdown 可操作看板：** 在文件夹 `+` 菜单选择“新建看板”，拖动卡片和列，单击卡片在右侧编辑详情；分栏查看同一份 `.md` 源码，共享撤销和自动保存。[格式与边界](docs/KANBAN.md)。\n', 1)
entry = '''## 0.2.0-beta.5 — 2026-09-12

### Added

- Interactive Markdown Kanban with explicit `localview: kanban` frontmatter. One ordinary `.md` file remains the only document model; ordinary task lists keep their normal preview.
- New board entry in every folder’s create menu, card and column sorting, cross-column moves, right-side card details, subtasks, and confirmed deletion with a move-before-delete option for nonempty columns.
- Preview board, raw-source Edit and left-board/right-source Split share CodeMirror undo/redo, 600 ms auto-save and external-file conflict protection. Keyboard alternatives are available for moving cards and columns.

### Fixed

- Unsubmitted new-card and new-column title fields retain their own native undo instead of undoing previously committed board changes.
- Browser demo saves update the existing in-memory file tree so new boards and edited notes survive switching between demo files.

### Safety and validation

- Source-range edits retain untouched Markdown and moved card blocks; ambiguous syntax and stale operations fail closed. No database, hidden sidecar, new runtime dependency or Rust permission change.
- 495 frontend regressions, 17 interaction cases in each of Chromium and WebKit, the standard macOS Rust checks and isolated real Trash checks form the release validation gate.
- macOS 12+; ad-hoc signing, not Apple notarization. Installer startup checks do not establish full native UI, physical Intel or older macOS acceptance. Card multiselection and automatic completion columns are not included.
- [Kanban format and examples](docs/KANBAN.md).

'''
replace('CHANGELOG.md', '# Changelog\n\n', '# Changelog\n\n' + entry, 1)
allowed = {'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'README.md', 'README.zh-CN.md', 'docs/INSTALL.md', 'CHANGELOG.md'}
changed = set(git('diff', '--name-only').splitlines())
require(changed == allowed, 'Unexpected release delta: ' + repr(changed))
subprocess.run(['git', 'diff', '--check'], check=True)
git('config', 'user.name', 'github-actions[bot]')
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
subprocess.run(['git', 'add', '--', *sorted(allowed)], check=True)
subprocess.run(['git', 'commit', '-m', 'release: prepare Markdown Kanban 0.2.0-beta.5'], check=True)
sha = git('rev-parse', 'HEAD')
subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/' + BRANCH], check=True)
require(not git('status', '--porcelain'), 'Candidate working tree is dirty')
with open(os.environ['GITHUB_OUTPUT'], 'a') as out:
    out.write('source_sha=' + sha + '\n')
print('RELEASE_CANDIDATE=' + sha)
print('Only nine version/documentation paths changed; npm and Cargo dependency records preserved.')
