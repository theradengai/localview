"""Resume the known, fully uploaded draft without rewriting tags or assets."""
from pathlib import Path

path = Path(__file__).with_name('publish.py')
source = path.read_text()

def replace_once(old: str, new: str) -> None:
    global source
    assert source.count(old) == 1, old
    source = source.replace(old, new, 1)

replace_once(
    'assert not any(t["name"] == TAG for page in existing_tags for t in page), "Tag already exists"',
    'assert sum(t["name"] == TAG for page in existing_tags for t in page) == 1, "Expected existing Beta 6 tag"')
replace_once(
    'assert not any(r["tag_name"] == TAG for page in existing_releases for r in page), "Release already exists"',
    'matching = [r for page in existing_releases for r in page if r["tag_name"] == TAG]\nassert len(matching) == 1 and matching[0]["id"] == 388901598 and matching[0]["draft"] is True, "Unexpected release state"')
start = source.index('# Reserve a new lightweight tag')
end = source.index('assert release_data["draft"] is True', start)
source = source[:start] + '''# Drafts must be addressed by ID, not the published-release-by-tag endpoint.
assert api(f"git/ref/tags/{TAG}")["object"]["sha"] == SOURCE
release_data = api("releases/388901598")
assert release_data["id"] == 388901598 and release_data["tag_name"] == TAG
assert release_data["prerelease"] is True and release_data["immutable"] is False
''' + source[end:]
replace_once(
    'gh("release", "edit", TAG, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false")',
    'gh("api", f"repos/{REPO}/releases/388901598", "--method", "PATCH", "-F", "draft=false", "-F", "prerelease=true", "-f", "make_latest=false")')
replace_once('release_data = api(f"releases/tags/{TAG}")', 'release_data = api("releases/388901598")')
# The original source/evidence/hash validations remain intact. No uploads or tag writes.
assert '"--method", "POST"' not in source
assert '"release", "upload"' not in source
exec(compile(source, str(path), 'exec'), {'__file__': str(path), '__name__': '__main__'})
