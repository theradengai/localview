"""Publish only the reviewed, checksum-pinned LocalView Beta 4 artifacts."""
import hashlib
import io
import json
import os
import pathlib
import subprocess
import time
import zipfile

REPO = 'theradengai/localview'
TAG = 'v0.2.0-beta.4'
SOURCE = 'd50eedc17f40f8032cb698476ccf01d5cfb47c36'
BUILD_RUN = 34598018207
SOURCE_CHECK_RUN = 34598191652
DOCS_HEAD = 'b1c8250c6d2c43cdd2bfb46dcfc3889704c229a4'
DOCS = {'README.md', 'README.zh-CN.md', 'docs/INSTALL.md', 'CHANGELOG.md'}
ARTIFACTS = [
    (10262783418, '99eb60643ce9e63df76e1b2f187c92ab3378af3468ac4a8ee4708c728e3e1be7', 'LocalView_0.2.0-beta.4_aarch64.dmg', '584d8ebc51d8ce50afd57e0a2bf0a034165133d458f749e91658beee0e4306af', 'arm64'),
    (10263152376, 'af339ea10adbc8c4cb77328bd69f63925685938e2ebf5a6dc51949a763bc09be', 'LocalView_0.2.0-beta.4_x64.dmg', '14bd31ec654e6049225896d744bf39d1128d8785a67b48f851633d94294e77d3', 'x86_64'),
]

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def gh(args, *, data=None):
    result = subprocess.run(['gh', *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', 'replace'))
    return result.stdout

def api(path, method='GET', data=None, optional=False):
    args = ['api', '-X', method, '-H', 'X-GitHub-Api-Version: 2026-03-10', f'repos/{REPO}/{path}']
    payload = None
    if data is not None:
        args += ['--input', '-']
        payload = json.dumps(data).encode()
    try:
        result = gh(args, data=payload)
    except RuntimeError as exc:
        if optional and '(HTTP 404)' in str(exc):
            return None
        raise
    return json.loads(result) if result else None

def digest(data):
    return hashlib.sha256(data).hexdigest()

def tree(sha):
    value = api(f'git/trees/{sha}?recursive=1')
    require(not value.get('truncated'), 'Refuse incomplete Git tree')
    return {item['path']: (item['type'], item['mode'], item['sha']) for item in value['tree'] if item['type'] != 'tree'}

def archive(artifact_id, expected_digest):
    meta = api(f'actions/artifacts/{artifact_id}')
    require(not meta['expired'], 'Artifact has expired')
    require(meta['workflow_run']['id'] == BUILD_RUN, 'Artifact belongs to a different workflow')
    require(meta['digest'] == 'sha256:' + expected_digest, 'Artifact metadata digest mismatch')
    data = gh(['api', f'repos/{REPO}/actions/artifacts/{artifact_id}/zip'])
    require(digest(data) == expected_digest, 'Downloaded artifact digest mismatch')
    result = zipfile.ZipFile(io.BytesIO(data))
    require(sum(item.file_size for item in result.infolist()) < 25000000, 'Unexpected archive size')
    require(len(result.namelist()) == len(set(result.namelist())), 'Duplicate ZIP members')
    require(result.testzip() is None, 'Corrupt ZIP member')
    return result

def release_notes(release_sha):
    return f'''## LocalView 0.2.0-beta.4

**Public prerelease / 公开预发布测试版 — macOS 12 or later.**

### 下载 / Downloads

- **Apple Silicon / M 系列：** `LocalView_0.2.0-beta.4_aarch64.dmg`
- **Intel Mac：** `LocalView_0.2.0-beta.4_x64.dmg`
- Check the installer against `SHA256SUMS.txt`; build and validation metadata are attached separately.

正常退出旧版后，打开对应 DMG，将 LocalView 拖入“应用程序”替换，再弹出安装磁盘。首次请用可丢弃样本目录测试。These apps use **ad-hoc signing and are not Apple-notarized**. Do not disable macOS security globally; see the [installation guide](https://github.com/{REPO}/blob/{TAG}/docs/INSTALL.md).

### 新增与修复 / Changes

- 文件夹、文件可混合多选：⌘/Ctrl 增选，Shift 连选，可见项全选、键盘区间选择和 Esc 清空。
- 整组拖动、批量移动、一次确认后移到系统废纸篓；同时选中父子项时去重。失败立即停止，保留剩余选择和已确认完成数；不是全有或全无事务。
- 修复自动保存后的身份预检顺序，以及批量移动途中同名对象替换的校验；空错误或 Promise 拒绝不会误报成功。
- 保留 Preview/Split 任务勾选、自动保存、撤销和原始缩进/换行等 Markdown 修复。
- 开发/测试依赖的 5 项 npm 告警已修复，生产依赖记录保持不变；CI 加入依赖审计及隔离的真实废纸篓测试。

Directory/file multiselection, group drag/move/Trash, fail-stop batch progress, retained file identities and save-before-preflight safety. Includes the earlier Markdown/task-list improvements and compatible development dependency fixes. [Full changelog](https://github.com/{REPO}/blob/{TAG}/CHANGELOG.md).

### 验证与来源 / Validation and provenance

433 frontend tests; 90 standard Rust tests plus 2 explicitly executed real macOS Trash tests; 16 Chromium/WebKit interaction cases passed. Both npm audits reported zero vulnerabilities at validation time. Both DMGs passed architecture, version, signature, license, disk-image and read-only mounted-content verification; isolated Apple Silicon startup passed.

Installer build source: `{SOURCE}`. Release tag commit: `{release_sha}`. Only four release-documentation paths differ; application source, lockfiles, build configuration and bundled notices are unchanged. The published DMGs are the **same byte-for-byte verified candidates**, not rebuilt binaries. See `BUILD-PROVENANCE.json` and `VALIDATION-SUMMARY.json`.

Full native UI physical-device acceptance, Intel hardware testing and older macOS coverage have **not** been claimed. This is not a stable release, Apple notarization, or a third-party security certification.

Feature review: #3. Release documentation: #5. Promotion tracking: #4.
'''

def main():
    require(os.environ.get('GITHUB_REPOSITORY') == REPO, 'Wrong repository')
    release_sha = os.environ['RELEASE_SHA']
    require(len(release_sha) == 40 and all(c in '0123456789abcdef' for c in release_sha), 'Invalid release SHA')
    for branch in ['main', 'staging']:
        require(api(f'git/ref/heads/{branch}')['object']['sha'] == release_sha, f'{branch} moved; review before publishing')
    pr3, pr5 = api('pulls/3'), api('pulls/5')
    require(pr3['merged'] and pr3['head']['sha'] == SOURCE, 'Feature PR is not merged as reviewed')
    require(pr5['merged'] and pr5['head']['sha'] == DOCS_HEAD and pr5['merge_commit_sha'] == release_sha, 'Release docs changed or not merged')
    source_tree, release_tree, docs_tree = tree(SOURCE), tree(release_sha), tree(DOCS_HEAD)
    require(release_tree == docs_tree, 'Release merge changed reviewed docs tree')
    changed = sorted(path for path in source_tree.keys() | release_tree.keys() if source_tree.get(path) != release_tree.get(path))
    require(set(changed) == DOCS, f'Unexpected changes since the validated candidate: {changed}')
    checks = []
    for run_id, sha in [(SOURCE_CHECK_RUN, SOURCE), (BUILD_RUN, '90fe1e1fe80a2102218f08271264faf1a4876055')]:
        run = api(f'actions/runs/{run_id}')
        require(run['head_sha'] == sha and run['status'] == 'completed' and run['conclusion'] == 'success', f'Run {run_id} is not green for expected source')
        checks.append({'id': run_id, 'url': run['html_url'], 'head_sha': sha, 'conclusion': run['conclusion']})
    tag = api(f'git/ref/tags/{TAG}', optional=True)
    if tag is not None:
        require(tag['object']['type'] == 'commit' and tag['object']['sha'] == release_sha, 'Refuse to replace existing tag')
    candidates = api('releases?per_page=100')
    existing = [r for r in candidates if r['tag_name'] == TAG]
    require(len(existing) <= 1, 'Ambiguous release')
    release = existing[0] if existing else None
    if release:
        require(release['prerelease'] and release['target_commitish'] == release_sha, 'Existing release target or type mismatch')

    out = pathlib.Path('/tmp/localview-beta4-release')
    out.mkdir(exist_ok=True)
    provenance = {'version': TAG[1:], 'release_tag': TAG, 'release_commit': release_sha, 'installer_source_commit': SOURCE, 'documentation_only_changes': changed, 'unchanged_application_source_dependencies_and_build_configuration': True, 'publication': 'promote-existing-verified-artifacts-without-rebuilding', 'checks': checks, 'installers': []}
    for artifact_id, zip_sha, name, dmg_sha, architecture in ARTIFACTS:
        with archive(artifact_id, zip_sha) as z:
            info = json.loads(z.read('BUILD-INFO.json'))
            require(info['version'] == TAG[1:] and info['source_commit'] == SOURCE and info['architecture'] == architecture and info['notarized'] is False, 'Installer provenance mismatch')
            data = z.read(name)
            require(digest(data) == dmg_sha, 'Installer checksum mismatch')
            (out / name).write_bytes(data)
            provenance['installers'].append({'filename': name, 'architecture': architecture, 'artifact_id': artifact_id, 'artifact_zip_sha256': zip_sha, 'sha256': dmg_sha, 'size': len(data), 'notarized': False})
    with archive(10263535744, 'd4b9bd4324e4a599b345a78a37b977e67653e525c58c7e119432bfa8d9af00ae') as z:
        require(z.read('SOURCE_SHA.txt').decode().strip() == SOURCE, 'Evidence source mismatch')
        test = json.loads(z.read('frontend-tests.json'))
        require(test['numPassedTests'] == 433 and test['numFailedTests'] == 0 and test['numPendingTests'] == 0 and test['success'], 'Frontend evidence not clean')
        audits = {name: json.loads(z.read(name))['metadata']['vulnerabilities'] for name in ['audit-after.json', 'audit-production-after.json']}
        require(all(a['total'] == 0 for a in audits.values()), 'Audit evidence not clean')
        browser = json.loads(z.read('browser/results.json'))
        require({b['browser'] for b in browser} == {'chromium', 'webkit'} and all(b['status'] == 'passed' and not b['errors'] and len(b['cases']) == 8 for b in browser), 'Browser evidence not clean')
    with archive(10263498133, '0e2a5137f6ad3b0ca163cfc203d22bc582612fac18d5583b4476600b05262108') as z:
        require('90 passed; 0 failed' in z.read('rust-tests.log').decode(), 'Missing native test evidence')
        require('2 passed; 0 failed; 0 ignored' in z.read('trash-smoke.log').decode(), 'Missing real Trash evidence')
        require(z.read('app-launch.log').strip() == b'', 'Unexpected native launch output')
    summary = {'installer_source_commit': SOURCE, 'frontend': {'passed': 433, 'failed': 0, 'skipped': 0}, 'rust_standard': {'passed': 90, 'failed': 0}, 'rust_real_trash_separately_executed': {'passed': 2, 'failed': 0, 'ignored': 0}, 'browser': browser, 'npm_audits_at_validation': audits, 'physical_device_ui_acceptance': 'not-performed', 'intel_hardware_acceptance': 'not-performed', 'apple_notarization': False, 'source_checks': checks}
    # Main is fast-forwarded to the reviewed staging tree. Do not publish while
    # its normal post-promotion check is pending, even though the bytes are pinned.
    deadline = time.monotonic() + 480
    while True:
        runs = api('actions/runs?branch=main&event=push&per_page=30')['workflow_runs']
        matches = [r for r in runs if r['head_sha'] == release_sha and r['path'] == '.github/workflows/check.yml']
        if matches and matches[0]['status'] == 'completed':
            run = matches[0]
            require(run['conclusion'] == 'success', 'Post-promotion main check did not pass')
            checks.append({'id': run['id'], 'url': run['html_url'], 'head_sha': release_sha, 'conclusion': 'success'})
            break
        require(time.monotonic() < deadline, 'Main check still pending; nothing has been published')
        print('Publication gate: main check is not complete.', flush=True)
        time.sleep(10)
    for filename, obj in [('BUILD-PROVENANCE.json', provenance), ('VALIDATION-SUMMARY.json', summary)]:
        (out / filename).write_text(json.dumps(obj, indent=2) + '\n')
    (out / 'SHA256SUMS.txt').write_text(''.join(f'{sha}  {name}\n' for _, _, name, sha, _ in ARTIFACTS))
    names = {entry[2] for entry in ARTIFACTS} | {'SHA256SUMS.txt', 'BUILD-PROVENANCE.json', 'VALIDATION-SUMMARY.json'}
    expected = {name: {'sha256': digest((out / name).read_bytes()), 'size': (out / name).stat().st_size} for name in names}

    # Create an unpublished draft first. Existing matching assets are verified,
    # never overwritten, making interrupted uploads safe to retry.
    if release is None:
        release = api('releases', 'POST', {'tag_name': TAG, 'target_commitish': release_sha, 'name': 'LocalView 0.2.0-beta.4 — 文件夹多选 / Folder multiselection', 'body': release_notes(release_sha), 'draft': True, 'prerelease': True, 'make_latest': 'false'})
    assets = {a['name']: a for a in api(f"releases/{release['id']}/assets?per_page=100")}
    require(set(assets) <= names, 'Unexpected release assets; refusing modification')
    for name in sorted(names):
        if name not in assets:
            require(release['draft'], 'Refuse to mutate an already published release')
            gh(['release', 'upload', TAG, str(out / name), '--repo', REPO])
    assets = {a['name']: a for a in api(f"releases/{release['id']}/assets?per_page=100")}
    require(set(assets) == names, 'Incomplete release assets')
    for name, metadata in expected.items():
        asset = assets[name]
        require(asset['state'] == 'uploaded' and asset['size'] == metadata['size'] and asset['digest'] == 'sha256:' + metadata['sha256'], f'Remote asset verification failed: {name}')
    require(api('git/ref/heads/main')['object']['sha'] == release_sha, 'main moved before publication')
    if release['draft']:
        release = api(f"releases/{release['id']}", 'PATCH', {'draft': False, 'prerelease': True, 'make_latest': 'false'})
    require(not release['draft'] and release['prerelease'], 'Release was not published as prerelease')
    tag = api(f'git/ref/tags/{TAG}')
    require(tag['object']['type'] == 'commit' and tag['object']['sha'] == release_sha, 'Published tag target mismatch')
    print(json.dumps({'release_url': release['html_url'], 'release_id': release['id'], 'tag': TAG, 'release_commit': release_sha, 'assets': expected}, indent=2))
    pathlib.Path(os.environ['GITHUB_STEP_SUMMARY']).write_text(f"Published [{TAG}]({release['html_url']}) with five verified assets.\n\nInstaller source: `{SOURCE}`. Release commit: `{release_sha}`. Four documentation-only differences.\n")

if __name__ == '__main__':
    main()
