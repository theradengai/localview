import hashlib,json,os,plistlib,shutil,signal,subprocess,time,traceback,urllib.request,uuid
from pathlib import Path
assert os.environ.get('GITHUB_ACTIONS')=='true'
root=Path(os.environ['RUNNER_TEMP'])/'localview-launch-media';root.mkdir(exist_ok=True)
out=root/'output';out.mkdir(exist_ok=True)
ax=Path(os.environ['RUNNER_TEMP'])/'localview-media-ax'
repo=Path.cwd()
def run(args,**kw): return subprocess.run([str(x) for x in args],check=True,timeout=kw.pop('timeout',30),capture_output=True,text=True,**kw).stdout.strip()
def osa(script):return run(['osascript','-e',script])
def cmd(pid,op,*args,**kw):return run([ax,pid,op,*args],**kw)
def shot(name):run(['/usr/sbin/screencapture','-x',out/(name+'.png')])
def dump(pid,name):
 s=cmd(pid,'dump');(out/(name+'.json')).write_text(s);return json.loads(s)
def mark(name):timeline.append({'step':name,'seconds':round(time.monotonic()-start,3)})
def wait_pid():
 for _ in range(50):
  p=subprocess.run(['pgrep','-x','localview'],capture_output=True,text=True)
  if p.returncode==0:return int(p.stdout.strip().splitlines()[0])
  time.sleep(.2)
 raise RuntimeError('App PID missing')
app=Path('/Applications/LocalView.app');assert not app.exists(),'Refuse existing app'
dmg=root/'LocalView.dmg';urllib.request.urlretrieve('https://github.com/theradengai/localview/releases/download/v0.2.0-beta.6/LocalView_0.2.0-beta.6_aarch64.dmg',dmg)
assert hashlib.sha256(dmg.read_bytes()).hexdigest()=='6d8db5e8425179f43ee6152af1b5aa883ae48e4a68241a9a74b5c165770320a9'
mount=root/'mount';mount.mkdir();run(['hdiutil','attach','-nobrowse','-mountpoint',mount,dmg]);run(['ditto',mount/'LocalView.app',app]);run(['hdiutil','detach',mount])
run(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister','-f',app])
folder=Path.home()/'Desktop'/'LocalView Demo'/'Project files';folder.mkdir(parents=True)
(folder/'01-Project.md').write_text('# Project notes\n\nEverything for this project lives in one folder.\n\n## Today\n\n- [ ] Review the draft\n- [x] Gather reference files\n\n## Next step\n\nWrite a clear introduction.\n')
(folder/'02-Prototype.html').write_text('''<!doctype html><html><meta charset="utf-8"><style>body{font-family:-apple-system,sans-serif;background:#f4f3ee;color:#202020;margin:0;padding:48px}small{letter-spacing:3px}h1{font-size:48px;line-height:1.1}button{background:#222;color:white;padding:16px 28px;border:0;border-radius:8px;cursor:pointer}article{background:white;padding:30px;border-radius:12px}p{line-height:1.7}</style><small>PROJECT STUDIO</small><h1>A local prototype.<br>A working preview.</h1><article><p>Local HTML, styles and interactions.<br>All in the same workspace.</p><button onclick="this.textContent='Added to your plan';document.getElementById('result').textContent='The interaction runs locally.'">Add to plan</button><p id="result"></p></article></html>''')
(folder/'03-Budget.csv').write_text('Item,Status,Estimate\nWriting,In progress,4\nPrototype,Ready,2\nReview,Planned,1\n')
shutil.copy2(repo/'src-tauri/icons/icon.png',folder/'04-Reference.png')
(folder/'05-Board.md').write_text('---\nlocalview: kanban\n---\n\n# Project board\n\n## To do\n\n- [ ] Polish the draft\n  Keep it simple and clear.\n\n- [ ] Prepare the demo\n  Record only sample documents.\n\n## In progress\n\n- [ ] Build the prototype\n  - [x] Create the page\n  - [ ] Review the copy\n\n## Done\n\n- [x] Collect references\n')
# Optional Quick Action, not bundled in the installed Beta 6.
service=Path.home()/'Library/Services/Open with LocalView.workflow';(service/'Contents').mkdir(parents=True)
action={'AMAccepts':{'Container':'List','Optional':False,'Types':['com.apple.cocoa.path']},'AMProvides':{'Container':'List','Types':['com.apple.cocoa.path']},'AMActionVersion':'1.1.1','ActionBundlePath':'/System/Library/Automator/Open Finder Items.action','ActionName':'Open Finder Items','ActionParameters':{'appPath':str(app)},'BundleIdentifier':'com.apple.Automator.OpenFinderItems','CFBundleVersion':'1.1.1','Class Name':'AMOpenFinderItems','UUID':str(uuid.uuid4()),'InputUUID':str(uuid.uuid4()),'OutputUUID':str(uuid.uuid4())}
meta={'applicationBundleID':'com.apple.finder','applicationBundleIDsByPath':{'/System/Library/CoreServices/Finder.app':'com.apple.finder'},'applicationPath':'/System/Library/CoreServices/Finder.app','applicationPaths':['/System/Library/CoreServices/Finder.app'],'inputTypeIdentifier':'com.apple.Automator.fileSystemObject','outputTypeIdentifier':'com.apple.Automator.nothing','serviceInputTypeIdentifier':'com.apple.Automator.fileSystemObject','serviceOutputTypeIdentifier':'com.apple.Automator.nothing','serviceProcessesInput':0,'workflowTypeIdentifier':'com.apple.Automator.servicesMenu'}
plistlib.dump({'AMApplicationBuild':'520','AMApplicationVersion':'2.10','AMDocumentVersion':'2','actions':[{'action':action}],'connectors':{},'workflowMetaData':meta},open(service/'Contents/document.wflow','wb'))
plistlib.dump({'NSServices':[{'NSMenuItem':{'default':'Open with LocalView'},'NSMessage':'runWorkflowAsService','NSRequiredContext':{'NSApplicationIdentifier':'com.apple.finder'},'NSSendFileTypes':['public.folder']}]},open(service/'Contents/Info.plist','wb'))
subprocess.run(['/System/Library/CoreServices/pbs','-update'],capture_output=True,timeout=20)
shutil.copytree(service,out/'Open with LocalView.workflow')
report={'status':'running','appVersion':'0.2.0-beta.6','fixtureOnly':True,'optionalFinderQuickAction':True,'dmgSHA256':hashlib.sha256(dmg.read_bytes()).hexdigest()}
timeline=[];start=time.monotonic();rec=None;pid=None
try:
 osa('tell application "Finder"\n activate\n reveal POSIX file "/Applications/LocalView.app"\nend tell')
 fpid=int(osa('tell application "System Events" to get unix id of process "Finder"'))
 rec=subprocess.Popen(['/usr/sbin/screencapture','-v','-V','120','-C',str(out/'native-raw.mov')],stdout=open(out/'recording.log','w'),stderr=subprocess.STDOUT)
 start=time.monotonic();time.sleep(1.3);mark('launch')
 cmd(fpid,'key','31','cmd');pid=wait_pid();time.sleep(1.4);cmd(pid,'resize');dump(pid,'app-start');shot('01-start');mark('open-folder-click')
 cmd(pid,'click','Open folder','AXButton');time.sleep(.6);cmd(pid,'key','5','cmdshift');time.sleep(.5);cmd(pid,'paste',input=str(folder));cmd(pid,'key','36');time.sleep(.8);cmd(pid,'key','36');time.sleep(1.2);dump(pid,'folder-open');shot('02-folder-open');mark('folder-opened')
 for name,label in [('01-Project.md','03-markdown'),('02-Prototype.html','04-html'),('03-Budget.csv','05-spreadsheet'),('04-Reference.png','06-image'),('05-Board.md','07-board')]:
  mark(label);cmd(pid,'click',name);time.sleep(1);shot(label)
  if 'Prototype' in name:
   cmd(pid,'click','Add to plan');time.sleep(.8);shot('04-html-interaction')
  if 'Board' in name:
   cmd(pid,'click','Split','AXButton');time.sleep(.7);shot('07-board-split')
 mark('edit-markdown');cmd(pid,'click','01-Project.md');time.sleep(.5);cmd(pid,'click','Split','AXButton');time.sleep(.5);dump(pid,'editing-state');shot('08-edit')
 report['appFlow']='passed'
 mark('finder');osa('tell application "Finder"\n activate\n reveal POSIX file '+json.dumps(str(folder))+'\nend tell');time.sleep(.8)
 nodes=dump(fpid,'finder-before-menu');shot('09-finder')
 found=next((n for n in nodes if n['value']=='Project files' or n['title']=='Project files' or n['description']=='Project files'),None)
 if not found:raise RuntimeError('Folder accessibility target missing')
 f=found['frame'];cmd(fpid,'xy',str(f[0]+f[2]/2),str(f[1]+f[3]/2),'right');time.sleep(.8);nodes=dump(fpid,'finder-menu');shot('10-finder-menu')
 for submenu in ['Quick Actions','Services']:
  try:cmd(fpid,'press',submenu,'AXMenuItem');time.sleep(.6)
  except Exception:pass
  try:cmd(fpid,'press','Open with LocalView','AXMenuItem');break
  except Exception:continue
 else:raise RuntimeError('Optional Finder action not found in real context menu')
 time.sleep(1.5);shot('11-finder-opened');mark('finder-opened');report['finderFlow']='passed'
 report['status']='passed'
except Exception as e:
 report['status']='partial';report['error']=str(e);(out/'exception.txt').write_text(traceback.format_exc());shot('failure')
 if pid:
  try:dump(pid,'app-final')
  except Exception:pass
finally:
 time.sleep(1);mark('end')
 if rec:
  rec.send_signal(signal.SIGINT)
  try:rec.wait(timeout=12)
  except subprocess.TimeoutExpired:rec.terminate()
 report['timeline']=timeline;(out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
 shutil.copytree(folder,out/'Project files',dirs_exist_ok=True)
