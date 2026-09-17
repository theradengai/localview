from pathlib import Path

source = Path('.github/windows-publication/publish.py').read_text(encoding='utf-8')
assert "TAG = 'v0.2.0-beta.7'" in source
source = source.replace('0.2.0-beta.7', '0.2.0-beta.8')

def change(before: str, after: str) -> None:
    global source
    assert source.count(before) == 1, before
    source = source.replace(before, after)

change("mac_before = immutable_mac_assets()", "mac_before = immutable_mac_assets()\nprevious_windows = {a['name']: [a['id'], a['digest'], a['size']] for a in request('releases/tags/v0.2.0-beta.7')['assets']}")
change("native = read_json(CACHE/'evidence/native-ui.json')", "native = read_json(CACHE/'evidence/native-ui.json')\nshell = read_json(CACHE/'evidence/shell-menu.json')\nlifecycle = read_json(CACHE/'evidence/shell-lifecycle.json')")
change("assert native['status'] == 'passed' and native['errors'] == []", "assert native['status'] == 'passed' and native['errors'] == []\nassert shell['status'] == 'passed' and len(shell['cases']) >= 3\nassert lifecycle['status'] == 'passed' and len(lifecycle['cases']) >= 4\nassert len(shell['registry']) == 2")
change("for name in ['windows-chinese.png', 'windows-english.png', 'windows-kanban.png', 'windows-pdf.png']:", "for name in ['windows-chinese.png', 'windows-english.png', 'windows-kanban.png', 'windows-pdf.png', 'windows-explorer-open.png']:")
change("    'dependencyAuditVulnerabilities': 0,", "    'dependencyAuditVulnerabilities': 0,\n    'explorerShellMenu': shell,\n    'explorerMenuLifecycle': lifecycle,")
change("        'macOS Beta 6 installers and release are unchanged.',", "        'macOS Beta 6 and Windows Beta 7 installers and releases are unchanged.',\n        'Windows 11 compact-menu placement is not certified; classic Show more options may be required.',\n        'Shell menu language follows installer language. Background acceptance executes its registered command; folder acceptance invokes the registered Shell verb.',")
start = source.index("notes = f'''")
end = source.index('\nexisting = ', start)
source = source[:start] + "notes = Path('.github/windows-beta8-publication/release-notes.md').read_text(encoding='utf-8')\n" + source[end:]
change("'name': 'LocalView 0.2.0-beta.8 — Windows x64'", "'name': 'LocalView 0.2.0-beta.8 — Windows 文件夹右键 / Explorer menus'")
change("assert immutable_mac_assets() == mac_before, 'Unexpected change to existing macOS release'", "assert immutable_mac_assets() == mac_before, 'Unexpected change to existing macOS release'\nassert {a['name']: [a['id'], a['digest'], a['size']] for a in request('releases/tags/v0.2.0-beta.7')['assets']} == previous_windows, 'Unexpected change to previous Windows release'")
Path('/tmp/publish-beta8.py').write_text(source, encoding='utf-8')
compile(source, '/tmp/publish-beta8.py', 'exec')
