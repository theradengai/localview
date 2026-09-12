"""Publish a guarded prerelease; never overwrite existing release assets."""
import base64
import hashlib
import io
import json
import os
import pathlib
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = 'theradengai/localview'
API = 'https://api.github.com/repos/' + REPO
SOURCE = '645ff6a06806acc129c58a876f747f31718f4830'
RUN = 34685131579
TRIGGER = '282083a6e47523991a31e086cfc9debe040b1334'
VERSION = '0.2.0-beta.5'
TAG = 'v' + VERSION
RELEASE = os.environ['RELEASE_SHA']
TOKEN = os.environ['GH_TOKEN']
OUT = pathlib.Path('/tmp/beta5-publication')
OUT.mkdir(exist_ok=True)

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def api(endpoint, method='GET', body=None):
    payload = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(API + endpoint, data=payload, method=method, headers={'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)

def optional(endpoint):
    try:
        return api(endpoint)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None

def anonymous_bytes(url):
    require(url.startswith('https://'), 'Non-HTTPS download')
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'LocalView-release-verifier'}), timeout=90) as response:
        require(response.status == 200, 'Download did not return 200')
        return response.read()

def artifact_bytes(artifact):
    request = urllib.request.Request(API + '/actions/artifacts/' + str(artifact['id']) + '/zip', headers={'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
            data = response.read()
    except urllib.error.HTTPError as error:
        require(error.code in (301, 302, 303, 307, 308), 'Artifact request failed: ' + str(error.code))
        # Redirect target receives no GitHub token, cookie or authorization header.
        data = anonymous_bytes(error.headers['Location'])
    if artifact.get('digest'):
        require(artifact['digest'] == 'sha256:' + digest(data), 'Artifact archive hash differs')
    return zipfile.ZipFile(io.BytesIO(data))

def member(archive, name):
    matches = [p for p in archive.namelist() if pathlib.PurePosixPath(p).name == name]
    require(len(matches) == 1, 'Missing or duplicate archive member: ' + name)
    return archive.read(matches[0])

for branch in ['main', 'staging']:
    require(api('/git/ref/heads/' + branch)['object']['sha'] == RELEASE, branch + ' moved from expected release commit')
source_tree = api('/git/commits/' + SOURCE)['tree']['sha']
require(api('/git/commits/' + RELEASE)['tree']['sha'] == source_tree, 'Released tree differs from built candidate')
pr = api('/pulls/7')
require(pr['merged'] and pr['head']['sha'] == SOURCE, 'Release PR is not the reviewed candidate')
run = api('/actions/runs/' + str(RUN))
require(run['head_sha'] == TRIGGER and run['status'] == 'completed' and run['conclusion'] == 'success', 'Candidate validation/build did not pass')
jobs = api('/actions/runs/' + str(RUN) + '/jobs?per_page=100')['jobs']
require(len(jobs) == 4 and all(j['conclusion'] == 'success' for j in jobs), 'Expected all four candidate jobs to succeed')
# Both regular checks must independently have passed on the release commit.
runs = api('/actions/runs?head_sha=' + RELEASE + '&per_page=100')['workflow_runs']
for path in ['.github/workflows/check.yml', '.github/workflows/kanban.yml']:
    selected = [r for r in runs if r['path'] == path and r['head_branch'] == 'main' and r['event'] == 'push']
    require(selected, 'Missing post-promotion main check: ' + path)
    last = max(selected, key=lambda r: r['id'])
    require(last['status'] == 'completed' and last['conclusion'] == 'success', 'Post-promotion check not successful: ' + path)
artifacts = api('/actions/runs/' + str(RUN) + '/artifacts?per_page=100')['artifacts']
artifacts = {a['name']: a for a in artifacts if not a['expired']}
assets = {}
builds = []
for target, arch, suffix in [('aarch64-apple-darwin', 'arm64', 'aarch64'), ('x86_64-apple-darwin', 'x86_64', 'x64')]:
    artifact = artifacts['LocalView-' + VERSION + '-' + target]
    archive = artifact_bytes(artifact)
    info = json.loads(member(archive, 'BUILD-INFO-' + arch + '.json'))
    require(info['source_commit'] == SOURCE and info['source_tree'] == source_tree and info['version'] == VERSION and info['target'] == target, 'Incorrect artifact provenance')
    for flag in ['bundle_verified', 'dmg_verified', 'mounted_contents_verified']:
        require(info[flag] is True, 'Missing installer verification: ' + flag)
    name = 'LocalView_' + VERSION + '_' + suffix + '.dmg'
    data = member(archive, name)
    require(digest(data) == info['sha256'] and len(data) == info['size'], 'Installer hash mismatch')
    assets[name] = data
    builds.append(info)
    for name in ['npm-audit.json', 'npm-audit-production.json']:
        audit = json.loads(member(archive, name))
        require(all(value == 0 for value in audit['metadata']['vulnerabilities'].values()), 'Dependency audit not clean')
    if arch == 'arm64':
        tests = json.loads(member(archive, 'frontend-tests.json'))
        require(tests['success'] and tests['numPassedTests'] == 495 and tests['numFailedTests'] == 0 and tests['numPendingTests'] == 0, 'Frontend regression mismatch')
        require(b'90 passed; 0 failed' in member(archive, 'rust-tests.log'), 'Missing native regressions')
        require(b'2 passed; 0 failed; 0 ignored' in member(archive, 'trash-tests.log'), 'Missing opt-in Trash checks')
        require(info['startup'].startswith('exact DMG app copy remained running') and info['startup_fixture_unchanged'], 'Missing installed-copy startup check')
browser_zip = artifact_bytes(artifacts['beta5-browser'])
require(member(browser_zip, 'SOURCE_SHA.txt').decode().strip() == SOURCE, 'Browser source mismatch')
browsers = json.loads(member(browser_zip, 'results.json'))
require(len(browsers) == 2 and {b['browser'] for b in browsers} == {'chromium', 'webkit'}, 'Expected both browser engines')
require(all(b['status'] == 'passed' and len(b['cases']) == 17 and not b['errors'] for b in browsers), 'Browser regressions failed')
fixture = api('/contents/docs/fixtures/kanban.md?ref=' + SOURCE)
assets['kanban-example.md'] = base64.b64decode(fixture['content'])
provenance = {'version': VERSION, 'release_commit': RELEASE, 'installer_source_commit': SOURCE, 'git_tree': source_tree, 'source_tree_identical': True, 'build_run': RUN, 'builds': builds}
validation = {'version': VERSION, 'source_commit': SOURCE, 'frontend_passed': 495, 'frontend_failed': 0, 'native_rust_passed': 90, 'real_trash_passed': 2, 'npm_audit_vulnerabilities': 0, 'browsers': browsers, 'limits': ['ad-hoc signed, not Apple-notarized', 'macOS 12+', 'startup is not full native Kanban UI acceptance', 'no physical Intel or older macOS UI acceptance', 'no card multiselection or automatic completion columns']}
assets['BUILD-PROVENANCE.json'] = (json.dumps(provenance, indent=2) + '\n').encode()
assets['VALIDATION-SUMMARY.json'] = (json.dumps(validation, ensure_ascii=False, indent=2) + '\n').encode()
assets['SHA256SUMS.txt'] = ''.join(digest(data) + '  ' + name + '\n' for name, data in sorted(assets.items())).encode()
for name, data in assets.items():
    (OUT / name).write_bytes(data)
body = '''## LocalView 0.2.0-beta.5 — Markdown 可操作看板

**公开预发布测试版 / Public prerelease · macOS 12+**

### 下载与使用

M 系列选择 `LocalView_0.2.0-beta.5_aarch64.dmg`，Intel 选择 `LocalView_0.2.0-beta.5_x64.dmg`。正常退出旧版后用 DMG 替换应用。

在文件夹 `+` 菜单选择 **新建看板**，或打开附件 `kanban-example.md`。文件仍为普通 Markdown；只有 `localview: kanban` 文件头启用看板。二级标题是列，顶层任务是卡片。

- 拖动卡片跨列或调整顺序；单击打开右侧详情，编辑标题、说明和子任务。
- 新增、重命名和排序列；删除时确认，非空列可先迁移卡片。
- 预览是可操作看板，编辑是源码，分栏为左看板/右源码；共享撤销、600 ms 自动保存和外部修改冲突保护。
- 修复未提交标题框的撤销误操作，以及演示模式切换文件后内容丢失。
- 完成状态与所在列独立；不包含卡片多选或自动完成列。

### Validation / 验证

495/495 frontend regressions, 90 Rust regressions plus 2 explicitly run real macOS Trash checks, and 17 cases in each of Chromium/WebKit passed. Both npm audits reported zero vulnerabilities. Both DMGs passed architecture, version, signature, license, disk-image and read-only mounted-content verification. An exact Apple Silicon DMG app copy passed isolated startup.

The attached provenance and validation files identify the exact source and checks. Installers are unchanged verified build artifacts; older releases were not replaced.

### Limits / 边界

Ad-hoc signatures; **not Apple-notarized**. Installer startup is not full native Kanban UI, physical Intel or older macOS acceptance. Do not disable macOS security globally. Use a disposable example first.

[安装说明](https://github.com/theradengai/localview/blob/v0.2.0-beta.5/docs/INSTALL.md) · [看板格式](https://github.com/theradengai/localview/blob/v0.2.0-beta.5/docs/KANBAN.md)
'''
body += '\nInstaller source: `' + SOURCE + '`. Release commit: `' + RELEASE + '`. Identical file trees.\n'
tag = optional('/git/ref/tags/' + TAG)
require(tag is None or (tag['object']['type'] == 'commit' and tag['object']['sha'] == RELEASE), 'Existing tag points elsewhere')
release = optional('/releases/tags/' + TAG)
if release is None:
    release = api('/releases', 'POST', {'tag_name': TAG, 'target_commitish': RELEASE, 'name': 'LocalView ' + VERSION + ' — Markdown 看板 / Kanban', 'body': body, 'draft': True, 'prerelease': True, 'make_latest': 'false'})
require(release['tag_name'] == TAG and release['prerelease'] and release['target_commitish'] == RELEASE, 'Unexpected existing release')
existing = {a['name']: a for a in api('/releases/' + str(release['id']) + '/assets?per_page=100')}
require(set(existing).issubset(assets), 'Unexpected release attachments')
for name, data in assets.items():
    if name in existing:
        require(existing[name]['state'] == 'uploaded' and existing[name].get('digest') == 'sha256:' + digest(data), 'Existing asset differs; refusing overwrite')
        continue
    require(release['draft'], 'Published release missing an asset; refusing mutation')
    url = 'https://uploads.github.com/repos/' + REPO + '/releases/' + str(release['id']) + '/assets?name=' + urllib.parse.quote(name)
    content_type = 'application/x-apple-diskimage' if name.endswith('.dmg') else ('application/json' if name.endswith('.json') else 'text/plain; charset=utf-8')
    request = urllib.request.Request(url, data=data, method='POST', headers={'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': content_type})
    with urllib.request.urlopen(request, timeout=120) as response:
        result = json.load(response)
    require(result['state'] == 'uploaded' and result.get('digest') == 'sha256:' + digest(data), 'Uploaded asset digest mismatch')
final_assets = api('/releases/' + str(release['id']) + '/assets?per_page=100')
require({a['name'] for a in final_assets} == set(assets), 'Incomplete release assets')
require(api('/git/ref/heads/main')['object']['sha'] == RELEASE and api('/git/ref/heads/staging')['object']['sha'] == RELEASE, 'Release refs changed before publication')
if release['draft']:
    release = api('/releases/' + str(release['id']), 'PATCH', {'draft': False, 'prerelease': True, 'make_latest': 'false'})
require(not release['draft'] and release['prerelease'], 'Release not published as prerelease')
require(api('/git/ref/tags/' + TAG)['object']['sha'] == RELEASE, 'Published tag mismatch')
for asset in final_assets:
    data = anonymous_bytes(asset['browser_download_url'])
    require(digest(data) == digest(assets[asset['name']]), 'Anonymous download checksum mismatch')
    print('Anonymous HTTP 200 / SHA256 verified: ' + asset['name'])
(OUT / 'PUBLISHED.json').write_text(json.dumps({'release_id': release['id'], 'url': release['html_url'], 'draft': release['draft'], 'prerelease': release['prerelease'], 'source_commit': SOURCE, 'release_commit': RELEASE, 'verified_public_assets': len(assets)}, indent=2) + '\n')
print('Published and anonymously verified: ' + release['html_url'])
