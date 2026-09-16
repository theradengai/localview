"""Publish only a complete Windows prerelease after exact-tree acceptance checks."""
import base64
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = 'theradengai/localview'
API = 'https://api.github.com/repos/' + REPO + '/'
HEAD = os.environ['VALIDATED_HEAD']
RELEASE = os.environ['RELEASE_COMMIT']
RUNS = {'windows': int(os.environ['WINDOWS_RUN']), 'macos': int(os.environ['MACOS_RUN']), 'browser': int(os.environ['BROWSER_RUN'])}
TAG = 'v0.2.0-beta.7'
VERSION = TAG[1:]
NAME = 'LocalView_0.2.0-beta.7_x64-setup.exe'
TOKEN = os.environ['GH_TOKEN']
OUT = Path(os.environ['RUNNER_TEMP']) / 'published-windows'
CACHE = Path(os.environ['RUNNER_TEMP']) / 'verified-windows'
OUT.mkdir(exist_ok=True)
CACHE.mkdir(exist_ok=True)

def request(path, method='GET', data=None):
    raw = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(API + path, data=raw, method=method, headers={
        'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'LocalView-verified-release',
        'Content-Type': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=90) as result:
        content = result.read()
    return json.loads(content) if content else None

def optional(path):
    try:
        return request(path)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def write_json(name, content):
    (OUT / name).write_text(json.dumps(content, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def download(run, name, folder):
    folder.mkdir(exist_ok=True)
    subprocess.run(['gh', 'run', 'download', str(run), '--repo', REPO, '--name', name, '--dir', str(folder)], check=True)

def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def log(name):
    return re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', (CACHE/'evidence'/name).read_text(encoding='utf-8-sig'))

def immutable_mac_assets():
    release = request('releases/tags/v0.2.0-beta.6')
    return {a['name']: [a['id'], a['digest'], a['size']] for a in release['assets']}

mac_before = immutable_mac_assets()
head_tree = request('git/commits/' + HEAD)['tree']['sha']
release_tree = request('git/commits/' + RELEASE)['tree']['sha']
assert head_tree == release_tree, 'Validated and promoted source trees differ'
for branch in ['main', 'staging']:
    assert request('git/ref/heads/' + branch)['object']['sha'] == RELEASE, branch + ' is not the reviewed release'
package = request('contents/package.json?ref=' + RELEASE)
assert json.loads(base64.b64decode(package['content']))['version'] == VERSION
checks = {}
for name, run_id in RUNS.items():
    run = request('actions/runs/' + str(run_id))
    assert run['status'] == 'completed' and run['conclusion'] == 'success', (name, run['status'], run['conclusion'])
    assert run['head_sha'] == HEAD, (name, 'Unexpected checked head')
    checks[name] = {'runId': run_id, 'url': run['html_url'], 'headCommit': HEAD, 'conclusion': run['conclusion']}

download(RUNS['windows'], 'LocalView-Windows-x64', CACHE/'installer')
download(RUNS['windows'], 'windows-native-evidence', CACHE/'evidence')
build = read_json(CACHE/'installer/BUILD-PROVENANCE.json')
install = read_json(CACHE/'evidence/install.json')
native = read_json(CACHE/'evidence/native-ui.json')
assert build['installer'] == NAME and build['version'] == VERSION and build['architecture'] == 'x86_64'
assert build['signed'] is False
assert build['sourceTree'] == install['sourceTree'] == native['sourceTree'] == release_tree
assert build['sourceCommit'] == install['sourceCommit'] == native['sourceCommit']
assert request('git/commits/' + build['sourceCommit'])['tree']['sha'] == release_tree
assert sha(CACHE/'installer'/NAME) == build['sha256'] == install['installerSHA256']
assert install['executableSHA256'] == native['executableSHA256']
assert install['installExitCode'] in [0, 3010] and install['signature'] == 'NotSigned'
assert native['status'] == 'passed' and native['errors'] == []
assert native['htmlIPC']['denied'] is True and 'not allowed' in native['htmlIPC']['reason']
assert native['pdfPreview']['originalFixtureUnchanged'] is True
assert native['pdfPreview']['status'] == 200 and 'application/pdf' in native['pdfPreview']['type']
assert len(native['cases']) >= 10
assert sha(CACHE/'evidence/windows-pdf.png') == os.environ['PDF_SCREENSHOT_SHA256'], 'PDF visual review does not match this build'
front = re.search(r'Tests\s+(\d+) passed', log('frontend.log'))
rust = re.search(r'test result: ok\. (\d+) passed; 0 failed; (\d+) ignored', log('tests.log'))
assert front and rust
assert '1 passed; 0 failed; 0 ignored' in log('recycle.log')
assert 'found 0 vulnerabilities' in log('audit.log')
frontend_count, rust_count = int(front[1]), int(rust[1])
shutil.copy2(CACHE/'installer'/NAME, OUT/NAME)
for name in ['windows-chinese.png', 'windows-english.png', 'windows-kanban.png', 'windows-pdf.png']:
    assert (CACHE/'evidence'/name).is_file()
    shutil.copy2(CACHE/'evidence'/name, OUT/name)
write_json('BUILD-PROVENANCE.json', {
    'version': VERSION, 'releaseCommit': RELEASE, 'validatedHeadCommit': HEAD,
    'releaseTree': release_tree, 'build': build, 'installation': install,
    'buildAndReleaseTreesIdentical': True,
    'buildCommitExplanation': 'GitHub PR merge commit built by CI; its entire tree is identical to the reviewed release commit.',
    'productionDebuggingEnabled': False, 'authenticodeSigned': False,
})
write_json('VALIDATION-SUMMARY.json', {
    'version': VERSION, 'releaseCommit': RELEASE, 'sourceTree': release_tree,
    'checks': checks, 'frontendTestsPassed': frontend_count, 'nativeRustTestsPassed': rust_count,
    'ignoredByDefault': int(rust[2]), 'explicitRecycleBinTestsPassed': 1,
    'dependencyAuditVulnerabilities': 0,
    'nativeApplication': {key: value for key, value in native.items() if key != 'pdfFrames'},
    'pdfVisualReview': {'file': 'windows-pdf.png', 'sha256': sha(OUT/'windows-pdf.png'), 'result': 'Actual native PDF fixture screenshot inspected before publication.'},
    'limitations': [
        'Unsigned public prerelease, not a stable or Authenticode-signed release.',
        'Hosted Windows Server 2022 x64 with the WebView2 version recorded above; not comprehensive physical Windows 10/11 or IME certification.',
        'OS-owned file-picker/print dialogs and third-party default applications are separate manual compatibility checks.',
        'Office/iWork opens in the default application; spreadsheet grids are read-only, with no formula recalculation or macros.',
        'Local drive-letter workspaces only; no UNC/network, junction/reparse traversal, cross-volume moves, Windows native ARM64 or Linux package.',
        'macOS Beta 6 installers and release are unchanged.',
    ],
})
checksums = ''.join(sha(file) + '  ' + file.name + '\n' for file in sorted(OUT.iterdir()))
(OUT/'SHA256SUMS.txt').write_text(checksums, encoding='utf-8')
notes = f'''## LocalView Windows x64 — 无需索引，直接打开

**0.2.0-beta.7 · 公开预发布测试版 · Windows 10/11 x64 + Microsoft WebView2**

下载 `LocalView_0.2.0-beta.7_x64-setup.exe`，安装到当前用户。缺少 WebView2 时安装程序需要联网下载 Microsoft 引导程序。打开应用后使用“打开文件 / Ctrl+O”或“打开文件夹”。不导入、不建索引，编辑写回原文件。

### 支持范围

- Markdown：编辑、实时预览、分栏、任务和表格、自动保存、撤销/重做。
- Markdown 看板：拖动卡片与列、详情编辑，仍保存为普通 `.md`。
- HTML：源码编辑、本地相对 CSS/图片/脚本与交互预览，预览帧不能调用原生命令。
- 文本/常见代码：编辑与保存；图片/PDF：预览；CSV/XLS/XLSX/ODS：只读数据表格。
- 新建/重命名/多选/工作区内移动/回收站、独立窗口和中英文界面。

Word/PowerPoint/iWork 使用默认应用打开，**不是内嵌 Office 编辑器或预览器**。首版仅支持普通本地盘符目录，不支持 UNC/网络目录、重解析点穿越或跨卷移动。Windows 原生 ARM64 和 Linux 包不包含在本版中。

### 验证与安装边界

{frontend_count} 项前端测试、{rust_count} 项 Windows Rust 测试、额外真实回收站测试，以及 macOS/浏览器回归通过。实际 NSIS 安装后的 WebView2 应用已用临时文件验证中文路径、原文件保存/撤销/自动保存、图片/表格/HTML/PDF、看板拖动、目录监听和双语多窗口；附图来自该安装后的应用，不是浏览器演示或概念图。源提交、构建/安装哈希和完整验证范围见附件。

**安装包未进行 Authenticode 代码签名**，可能提示未知发布者/SmartScreen。请从本仓库下载并核对 SHA-256；校验值证明完整性，不等于身份认证。不要关闭 Defender、SmartScreen 或系统级安全策略。托管 Windows 测试不代表已覆盖全部 Windows 10/11 实机、输入法与系统对话框。

macOS Beta 6 安装包保持不变。详见仓库 `docs/WINDOWS.md`。

---

## English

**Open local files directly. No indexing. No import step.**

The first Windows x64 Beta adds a current-user NSIS installer with WebView2. Edit Markdown, HTML and text in place; preview local images/PDF and read-only CSV/Excel/ODS grids; use Markdown Kanban, auto-save, undo/redo, Recycle Bin, multiple windows and English/Chinese UI.

Office/iWork opens in the default application, not an embedded Office renderer. This Beta supports local drive-letter workspaces only, not UNC/network roots, reparse-point traversal or cross-volume moves. No native Windows ARM64 or Linux installer is included.

The actual installed release app was tested against disposable local files, not only browser mocks. Build provenance, source-tree equality, checksums, native acceptance results and real UI screenshots are attached. The installer is **unsigned**; verify its origin and hash without disabling system-wide protections. Hosted-runner checks are not complete physical-device/IME/OS-dialog certification. Existing macOS Beta 6 packages are unchanged.
'''
existing = [r for r in request('releases?per_page=100') if r['tag_name'] == TAG]
assert len(existing) <= 1, 'Ambiguous release drafts'
if existing:
    release = existing[0]
    assert release['draft'], 'Do not overwrite a published release'
    assert release['target_commitish'] in [RELEASE, 'main'], 'Unexpected existing draft'
else:
    release = request('releases', 'POST', {'tag_name': TAG, 'target_commitish': RELEASE, 'name': 'LocalView 0.2.0-beta.7 — Windows x64', 'body': notes, 'draft': True, 'prerelease': True})
rid = release['id']
(OUT.parent/'windows-release-id.txt').write_text(str(rid))
assets = {a['name']: a for a in request(f'releases/{rid}/assets?per_page=100')}
expected = {p.name: {'size': p.stat().st_size, 'digest': 'sha256:' + sha(p)} for p in OUT.iterdir()}
assert set(assets) <= set(expected), 'Unexpected draft assets'
for file in sorted(OUT.iterdir()):
    if file.name in assets:
        old = assets[file.name]
        assert old['state'] == 'uploaded' and old['size'] == expected[file.name]['size'] and old['digest'] == expected[file.name]['digest'], 'Do not overwrite mismatched draft assets'
        continue
    url = release['upload_url'].split('{')[0] + '?name=' + urllib.parse.quote(file.name)
    assert url.startswith('https://uploads.github.com/repos/' + REPO + '/releases/')
    req = urllib.request.Request(url, data=file.read_bytes(), method='POST', headers={
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': mimetypes.guess_type(file.name)[0] or 'application/octet-stream',
        'User-Agent': 'LocalView-verified-release',
    })
    with urllib.request.urlopen(req, timeout=180) as response:
        uploaded = json.loads(response.read())
    assert uploaded['state'] == 'uploaded' and uploaded['size'] == file.stat().st_size
assets = {a['name']: a for a in request(f'releases/{rid}/assets?per_page=100')}
assert set(assets) == set(expected)
for name, spec in expected.items():
    assert assets[name]['digest'] == spec['digest'] and assets[name]['size'] == spec['size'], name
assert request('git/ref/heads/main')['object']['sha'] == RELEASE
ref = optional('git/ref/tags/' + TAG)
if ref is None:
    request('git/refs', 'POST', {'ref': 'refs/tags/' + TAG, 'sha': RELEASE})
else:
    assert ref['object']['sha'] == RELEASE and ref['object']['type'] == 'commit'
release = request(f'releases/{rid}', 'PATCH', {'draft': False, 'prerelease': True, 'target_commitish': RELEASE, 'body': notes, 'make_latest': 'false'})
assert not release['draft'] and release['prerelease'] and release['published_at']
assert request('git/ref/tags/' + TAG)['object']['sha'] == RELEASE
for item in release['assets']:
    # Read back public distributed bytes without passing an authentication token.
    req = urllib.request.Request(item['browser_download_url'], headers={'User-Agent': 'LocalView-release-verifier'})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                digest = hashlib.sha256(response.read()).hexdigest()
            break
        except urllib.error.HTTPError as error:
            if error.code not in [404, 429, 500, 502, 503, 504] or attempt == 5:
                raise
            time.sleep(2 ** attempt)
    assert 'sha256:' + digest == expected[item['name']]['digest'], item['name']
assert immutable_mac_assets() == mac_before, 'Unexpected change to existing macOS release'
print(json.dumps({'published': True, 'releaseId': rid, 'url': release['html_url'], 'sourceCommit': RELEASE, 'sourceTree': release_tree, 'assets': expected}, indent=2))
