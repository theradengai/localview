"""Capture only a disposable Finder file-open flow; never change the product."""
from pathlib import Path
# Reuse the reviewed installer/fixture setup, stopping before optional services.
setup = Path('scripts/media/capture.py').read_text().split('# Optional Quick Action,')[0]
exec(compile(setup, 'scripts/media/capture.py:setup', 'exec'), globals())

file = folder / '01-Project.md'
original = file.read_bytes()
recorder = Path(os.environ['RUNNER_TEMP']) / 'localview-media-recorder'
report = {'status': 'running', 'appVersion': '0.2.0-beta.6', 'fixtureOnly': True,
          'optionalFinderQuickAction': False, 'entryPoint': 'Finder file > Open With > LocalView',
          'dmgSHA256': hashlib.sha256(dmg.read_bytes()).hexdigest(),
          'securitySettingsModified': False}
timeline = []
start = time.monotonic()
rec = None
pid = None

def nodes_for(target):
    return json.loads(cmd(target, 'dump'))

def label(node):
    return ' '.join(str(node.get(key, '')) for key in ['title', 'description', 'value'])

def wait_for(target, predicate, seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        found = next((n for n in nodes_for(target) if predicate(n)), None)
        if found:
            return found
        time.sleep(.2)
    raise RuntimeError('Required native UI element did not appear')

try:
    osa('tell application "Finder"\nactivate\nreveal POSIX file ' + json.dumps(str(file)) + '\nset bounds of front Finder window to {30, 55, 995, 705}\nset current view of front Finder window to list view\nend tell')
    fpid = int(osa('tell application "System Events" to get unix id of process "Finder"'))
    time.sleep(1)
    wait_for(fpid, lambda n: any(n.get(k) == file.name for k in ['title','description','value']))
    dump(fpid, 'finder-file-start')
    rec = subprocess.Popen([str(recorder), str(out)], stdout=open(out/'recorder.log','w'), stderr=subprocess.STDOUT)
    start = time.monotonic()
    report['epochStart'] = time.time()
    time.sleep(1.2)
    shot('00-file-in-finder')
    mark('file-right-click')
    cmd(fpid, 'right', file.name)
    time.sleep(.8)
    dump(fpid, 'file-context-menu')
    shot('01-file-context-menu')
    wait_for(fpid, lambda n: n.get('role') == 'AXMenuItem' and n.get('title') == 'Open With')
    mark('open-with-submenu')
    cmd(fpid, 'hover', 'Open With', 'AXMenuItem')
    item = wait_for(fpid, lambda n: n.get('role') == 'AXMenuItem' and n.get('title','').startswith('LocalView'))
    cmd(fpid, 'hover', item['title'], 'AXMenuItem')
    time.sleep(.8)
    dump(fpid, 'file-open-with-menu')
    shot('02-file-open-with-localview')
    mark('choose-localview')
    cmd(fpid, 'click', item['title'], 'AXMenuItem')
    pid = wait_pid()
    heading = wait_for(pid, lambda n: n.get('role') == 'AXHeading' and 'Project notes' in label(n), 25)
    mark('file-preview-visible')
    time.sleep(1)
    cmd(pid, 'resize')
    time.sleep(.5)
    dump(pid, 'file-preview')
    shot('03-file-preview')
    assert file.read_bytes() == original, 'Reading must not rewrite the source'
    assert not any(n.get('role') == 'AXTextArea' for n in nodes_for(pid)), 'Expected reading preview, not an active source editor'
    report['originalFileUnchanged'] = True
    report['previewHeading'] = 'Project notes'
    report['noSourceEditorActive'] = True
    report['fileAssociationMenuLabel'] = item['title']
    report['fileSHA256'] = hashlib.sha256(original).hexdigest()
    report['status'] = 'passed'
    time.sleep(2.3)
except Exception as error:
    report['status'] = 'failed'
    report['error'] = str(error)
    (out/'exception.txt').write_text(traceback.format_exc())
    try:
        shot('failure')
        dump(fpid, 'finder-failure')
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
    shutil.copy2(file, out/file.name)
    print(json.dumps(report, indent=2))
if report['status'] != 'passed':
    raise SystemExit(1)
