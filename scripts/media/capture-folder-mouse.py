"""Record app launch and a mouse-only native folder picker on a disposable Mac."""
from pathlib import Path
setup = Path('scripts/media/capture.py').read_text().split('# Optional Quick Action,')[0]
exec(compile(setup, 'scripts/media/capture.py:setup', 'exec'), globals())

# A visible sample folder on Desktop, not an entered path or preset dialog URL.
visible_folder = Path.home() / 'Desktop' / 'Project files'
assert not visible_folder.exists()
shutil.move(str(folder), str(visible_folder))
folder = visible_folder
originals = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.iterdir() if p.is_file()}
recorder = Path(os.environ['RUNNER_TEMP']) / 'localview-media-recorder'
report = {'status': 'running', 'appVersion': '0.2.0-beta.6', 'fixtureOnly': True,
          'entryPoint': 'Launch > Open folder > Desktop > select Project files > Open',
          'dmgSHA256': hashlib.sha256(dmg.read_bytes()).hexdigest(),
          'securitySettingsModified': False, 'optionalFinderQuickAction': False,
          'pickerInput': 'mouse only', 'pathTypedOrPasted': False, 'goToFolderShortcutUsed': False}
timeline = []
start = time.monotonic()
rec = None
pid = None
fpid = None

def nodes_for(target):
    return json.loads(cmd(target, 'dump'))

def named(node, name):
    return any(node.get(k) == name for k in ['title', 'description', 'value'])

def wait_for(target, predicate, seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        found = next((n for n in nodes_for(target) if predicate(n)), None)
        if found:
            return found
        time.sleep(.2)
    raise RuntimeError('Required native UI element did not appear')

try:
    osa('tell application "Finder"\nactivate\nreveal POSIX file "/Applications/LocalView.app"\nset bounds of front Finder window to {30, 55, 995, 705}\nset current view of front Finder window to list view\nend tell')
    fpid = int(osa('tell application "System Events" to get unix id of process "Finder"'))
    time.sleep(.8)
    dump(fpid, 'finder-launch-state')
    rec = subprocess.Popen([str(recorder), str(out)], stdout=open(out/'recorder.log','w'), stderr=subprocess.STDOUT)
    start = time.monotonic()
    report['epochStart'] = time.time()
    time.sleep(1)
    shot('00-launch')
    mark('launch')
    # Launch the already selected app. All subsequent picker actions use the mouse.
    cmd(fpid, 'key', '31', 'cmd')
    pid = wait_pid()
    wait_for(pid, lambda n: named(n, 'Open folder') and n.get('role') == 'AXButton', 25)
    cmd(pid, 'resize')
    time.sleep(.6)
    shot('01-app-start')
    mark('open-folder-click')
    cmd(pid, 'click', 'Open folder', 'AXButton')
    desktop = wait_for(pid, lambda n: named(n, 'Desktop') and n.get('frame', [0,0,0,0])[2] > 0)
    dump(pid, 'picker-initial')
    shot('02-system-picker')
    time.sleep(.7)
    mark('desktop-click')
    cmd(pid, 'click', 'Desktop', desktop['role'])
    item = wait_for(pid, lambda n: named(n, 'Project files') and n.get('frame', [0,0,0,0])[2] > 0)
    time.sleep(.7)
    shot('03-desktop-folder-list')
    mark('folder-mouse-select')
    cmd(pid, 'click', 'Project files', item['role'])
    time.sleep(.8)
    dump(pid, 'picker-folder-selected')
    shot('04-folder-selected')
    button = wait_for(pid, lambda n: n.get('role') == 'AXButton' and (named(n, 'Open') or named(n, 'Choose') or named(n, 'Select')) and n.get('frame', [0,0,0,0])[2] > 0)
    button_name = next(button[k] for k in ['title','description','value'] if button.get(k) in ['Open','Choose','Select'])
    report['pickerConfirmationLabel'] = button_name
    mark('open-button-click')
    cmd(pid, 'click', button_name, 'AXButton')
    wait_for(pid, lambda n: named(n, '01-Project.md'), 20)
    mark('folder-opened')
    time.sleep(1)
    dump(pid, 'folder-opened')
    shot('05-folder-opened')
    after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.iterdir() if p.is_file()}
    assert after == originals, 'Opening must not import or rewrite the sample files'
    report['originalFilesUnchanged'] = True
    report['originalFileSHA256'] = originals
    report['status'] = 'passed'
    time.sleep(1.8)
except Exception as error:
    report['status'] = 'failed'
    report['error'] = str(error)
    (out/'exception.txt').write_text(traceback.format_exc())
    try:
        shot('failure')
        if pid:
            dump(pid, 'app-failure')
    except Exception:
        pass
finally:
    mark('end')
    (out/'STOP').touch()
    if rec:
        try:
            rec.wait(timeout=15)
        except subprocess.TimeoutExpired:
            rec.terminate()
    report['timeline'] = timeline
    if (out/'frames.jsonl').exists():
        report['recordedFrames'] = len((out/'frames.jsonl').read_text().splitlines())
    (out/'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
if report['status'] != 'passed':
    raise SystemExit(1)
