"""Publish only already-verified, exact-source LocalView Beta 6 artifacts."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

REPO = "theradengai/localview"
SOURCE = "4ae06b5678646f65b44ab1b6ecd66b36ceb82493"
NATIVE_SOURCE = "777f7ba13281ad020ab0a4401683098b4315a9c4"
TAG = "v0.2.0-beta.6"
GATES = {
    "application": (34934454978, SOURCE),
    "browser": (34934454966, SOURCE),
    "native": (34934193251, "bdb323534d0f984eafd8dcd33c6b2d646ada5915"),
    "installers": (34934521760, "36a60fbd5d82303e27ffdbb26b4d35e59eeb3981"),
}

def gh(*args):
    return subprocess.check_output(["gh", *map(str, args)], text=True)

def api(path):
    return json.loads(gh("api", f"repos/{REPO}/{path}"))

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def download(run, name, dest):
    gh("run", "download", run, "--repo", REPO, "--name", name, "--dir", dest)

for branch in ("main", "staging"):
    assert api(f"git/ref/heads/{branch}")["object"]["sha"] == SOURCE, branch
source_tree = api(f"git/commits/{SOURCE}")["tree"]["sha"]
metadata = {}
for name, (run_id, head_sha) in GATES.items():
    run = api(f"actions/runs/{run_id}")
    assert run["head_sha"] == head_sha, name
    assert run["status"] == "completed" and run["conclusion"] == "success", name
    metadata[name] = {k: run[k] for k in ("id", "head_sha", "html_url", "status", "conclusion", "updated_at")}

# Refuse to replace any previous tag or release. API errors also fail closed.
existing_tags = json.loads(gh("api", "--paginate", "--slurp", f"repos/{REPO}/tags?per_page=100"))
assert not any(t["name"] == TAG for page in existing_tags for t in page), "Tag already exists"
existing_releases = json.loads(gh("api", "--paginate", "--slurp", f"repos/{REPO}/releases?per_page=100"))
assert not any(r["tag_name"] == TAG for page in existing_releases for r in page), "Release already exists"

root = Path(os.environ["RUNNER_TEMP"]) / "beta6-publication"
root.mkdir(exist_ok=False)
release = root / "release"
release.mkdir()
builds = []
for arch, suffix in (("arm64", "aarch64"), ("x86_64", "x64")):
    dest = root / arch
    download(GATES["installers"][0], f"Beta6-{arch}", dest)
    build = json.loads((dest / f"BUILD-{arch}.json").read_text())
    name = f"LocalView_0.2.0-beta.6_{suffix}.dmg"
    assert build["sourceCommit"] == SOURCE and build["sourceTree"] == source_tree
    assert build["architecture"] == arch and build["nativeHost"] == arch
    assert build["instrumented"] is False and build["version"] == "0.2.0-beta.6"
    assert build["dmg"] == name
    assert sha256(dest / name) == build["sha256"]
    shutil.copy2(dest / name, release / name)
    builds.append(build)

# Native acceptance predates only two rustfmt-wrapped test assertions.
# Prove that every production byte is identical before reusing that evidence.
comparison = api(f"compare/{NATIVE_SOURCE}...{SOURCE}")
assert comparison["ahead_by"] == 1 and comparison["behind_by"] == 0
assert [f["filename"] for f in comparison["files"]] == ["src-tauri/src/ui_language.rs"]
def language_source(ref):
    data = api(f"contents/src-tauri/src/ui_language.rs?ref={ref}")
    assert data["encoding"] == "base64"
    return base64.b64decode(data["content"])
old_language = language_source(NATIVE_SOURCE)
new_language = language_source(SOURCE)
assert old_language.count(b"#[cfg(test)]") == new_language.count(b"#[cfg(test)]") == 1
assert old_language.split(b"#[cfg(test)]")[0] == new_language.split(b"#[cfg(test)]")[0]
assert b"".join(old_language.split()) == b"".join(new_language.split())
native = {}
for runner in ("macos-15", "macos-15-intel"):
    dest = root / runner
    download(GATES["native"][0], f"native-language-evidence-{runner}", dest)
    assert (dest / "SOURCE_SHA.txt").read_text().strip() == NATIVE_SOURCE
    report = json.loads((dest / "result.json").read_text())
    assert report["passed"] is True and report["windows"] == 3
    labels = [text for _, text in report["chineseMenu"]]
    for label in ("关于 LocalView", "隐藏 LocalView", "切换全屏", "文件", "退出 LocalView"):
        assert label in labels, label
    assert not any("About" in text or "Hide" in text or "Full Screen" in text for text in labels)
    native[runner] = report

dest = root / "browser"
download(GATES["browser"][0], "kanban-browser-evidence", dest)
# PR checkouts are merge refs; require the merge tree to equal the release source.
browser_sha = (dest / "SOURCE_SHA.txt").read_text().strip()
assert api(f"git/commits/{browser_sha}")["tree"]["sha"] == source_tree
browser = json.loads((dest / "browser/results.json").read_text())
languages = json.loads((dest / "languages/report.json").read_text())
for group in (browser, languages):
    assert {r["browser"] for r in group} == {"chromium", "webkit"}
    assert all(r["status"] == "passed" and not r["errors"] for r in group)
audit = json.loads((dest / "npm-audit.json").read_text())
assert audit["metadata"]["vulnerabilities"]["total"] == 0

(release / "BUILD-PROVENANCE.json").write_text(json.dumps({"version": "0.2.0-beta.6", "sourceCommit": SOURCE, "sourceTree": source_tree, "buildRun": metadata["installers"], "builds": builds}, indent=2) + "\n")
(release / "VALIDATION-SUMMARY.json").write_text(json.dumps({
    "version": "0.2.0-beta.6", "sourceCommit": SOURCE, "gates": metadata,
    "frontendTests": 514, "frontendTestFiles": 38, "lockedNpmVulnerabilities": 0,
    "nativeSourceCommit": NATIVE_SOURCE, "nativeProductionSourceEquivalent": True,
    "nativeToReleaseDelta": comparison["files"], "nativeAcceptance": native, "browser": browser, "languages": languages,
    "boundaries": ["Native acceptance uses an isolated test controller with production UI source; shipped DMGs do not contain it.", "Ad-hoc signed and not notarized.", "macOS 12 physical hardware, physical-device IME and system-owned dialogs are not fully covered by these automated checks."]
}, ensure_ascii=False, indent=2) + "\n")
assets = sorted(release.iterdir())
(release / "SHA256SUMS.txt").write_text("".join(f"{sha256(path)}  {path.name}\n" for path in assets))
assets = sorted(release.iterdir())
notes = Path(__file__).with_name("notes.md")
assert notes.is_file()
# Recheck promotion after downloading and validating the release bytes.
for branch in ("main", "staging"):
    assert api(f"git/ref/heads/{branch}")["object"]["sha"] == SOURCE, branch
# Reserve a new lightweight tag at the already-promoted source. Never rewrite a tag.
gh("api", f"repos/{REPO}/git/refs", "--method", "POST", "-f", f"ref=refs/tags/{TAG}", "-f", f"sha={SOURCE}")
# No public release is exposed until every upload has been verified against its bytes.
gh("release", "create", TAG, "--repo", REPO, "--verify-tag", "--title", "LocalView 0.2.0-beta.6 — 中英文界面 / Bilingual UI", "--notes-file", notes, "--draft", "--prerelease")
gh("release", "upload", TAG, *assets, "--repo", REPO)
release_data = api(f"releases/tags/{TAG}")
assert release_data["draft"] is True
assert {a["name"] for a in release_data["assets"]} == {p.name for p in assets}
for asset in release_data["assets"]:
    path = release / asset["name"]
    assert asset["state"] == "uploaded" and asset["size"] == path.stat().st_size
    assert asset["digest"] == "sha256:" + sha256(path)
assert api(f"git/ref/tags/{TAG}")["object"]["sha"] == SOURCE
gh("release", "edit", TAG, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false")
release_data = api(f"releases/tags/{TAG}")
assert release_data["draft"] is False and release_data["prerelease"] is True
assert release_data["published_at"]
(root / "published.json").write_text(json.dumps(release_data, indent=2) + "\n")
print(json.dumps({"url": release_data["html_url"], "tag": TAG, "source": SOURCE, "assets": [p.name for p in assets]}, indent=2))
