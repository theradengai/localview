from pathlib import Path
p=Path('scripts/media/capture.py');s=p.read_text()
def patch(old,new):
 global s
 assert s.count(old)==1,(old,s.count(old));s=s.replace(old,new)
patch("start=time.monotonic();time.sleep(1.3);mark('launch')", "start=time.monotonic();report['epochStart']=time.time();time.sleep(1.3);mark('launch')")
patch("['/usr/sbin/screencapture','-v','-V','120','-C',str(out/'native-raw.mov')]", "[str(Path(os.environ['RUNNER_TEMP'])/'localview-media-recorder'),str(out)]")
patch("  rec.send_signal(signal.SIGINT)","  (out/'STOP').touch()")
patch("dump(pid,'editing-state');shot('08-edit')", """nodes=dump(pid,'editing-state');shot('08-edit')
 mark('typing');area=next(n for n in nodes if n['role']=='AXTextArea' and n['frame'][2]>0);f=area['frame'];cmd(pid,'xy',str(f[0]+60),str(f[1]+60));cmd(pid,'key','0','cmd');updated=(folder/'01-Project.md').read_text().replace('Write a clear introduction.','Write a clear introduction. Then ship it.');cmd(pid,'paste',input=updated);time.sleep(1.4);assert (folder/'01-Project.md').read_text()==updated;shot('08-saved');mark('saved')
 try:
  cmd(pid,'click','05-Board.md');time.sleep(.7);nodes=dump(pid,'board-controls');mark('board-drag')
  grip=next(n for n in nodes if 'Drag card Polish the draft' in [n['title'],n['description']] and n['frame'][2]>0);col=next(n for n in nodes if 'In progress' in [n['title'],n['description'],n['value']] and n['frame'][2]>0)
  f=grip['frame'];g=col['frame'];cmd(pid,'drag',str(f[0]+f[2]/2),str(f[1]+f[3]/2),str(g[0]+70),str(g[1]+130));time.sleep(1.5);board=(folder/'05-Board.md').read_text();assert board.index('Polish the draft')>board.index('## In progress');shot('07-board-moved');cmd(pid,'click','Split','AXButton');time.sleep(.8);shot('07-board-split-after');mark('board-updated');report['boardMove']='passed'
 except Exception as e:report['boardMove']=str(e)
""")
patch("for submenu in ['Quick Actions','Services']:", "for submenu in ['', 'Services','Quick Actions']:")
patch("try:cmd(fpid,'press',submenu,'AXMenuItem');time.sleep(.6)", "try:\n   if submenu:cmd(fpid,'press',submenu,'AXMenuItem');time.sleep(.6)")
patch("try:cmd(fpid,'press','Open with LocalView','AXMenuItem');break", "try:cmd(fpid,'click','Open with LocalView','AXMenuItem');break")
patch("time.sleep(1.5);shot('11-finder-opened');mark('finder-opened');report['finderFlow']='passed'", """time.sleep(5);nodes=dump(pid,'after-finder-open');windows=[n for n in nodes if n['role']=='AXWindow'];report['windowsAfterFinder']=len(windows)
 if len(windows)<2:raise RuntimeError('Finder Quick Action did not create another workspace window')
 shot('11-finder-opened');mark('finder-opened');report['finderFlow']='passed'
 cmd(pid,'resize');cmd(pid,'click','01-Project.md');time.sleep(.6);mark('language-switch');cmd(pid,'click','Interface language','AXPopUpButton');time.sleep(.3);cmd(pid,'key','125');cmd(pid,'key','36');time.sleep(.8);shot('12-chinese');dump(pid,'chinese-interface');mark('language-switched')""")
patch("shutil.copytree(folder,out/'Project files',dirs_exist_ok=True)","report['recordedFrames']=sum(1 for _ in open(out/'frames.jsonl')) if (out/'frames.jsonl').exists() else 0\n (out/'report.json').write_text(json.dumps(report,indent=2));shutil.copytree(folder,out/'Project files',dirs_exist_ok=True)")
p.write_text(s)
a=Path('scripts/media/ax.swift');t=a.read_text();anchor='case "resize":';assert t.count(anchor)==1
t=t.replace(anchor,'''case "drag":
 guard a.count>=7,let sx=Double(a[3]),let sy=Double(a[4]),let tx=Double(a[5]),let ty=Double(a[6]) else {fail("Missing drag points")}
 let p=CGPoint(x:sx,y:sy);CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:p,mouseButton:.left)?.post(tap:.cghidEventTap);usleep(150000);CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:p,mouseButton:.left)?.post(tap:.cghidEventTap);usleep(150000)
 for i in 1...24 { let q=CGPoint(x:sx+(tx-sx)*Double(i)/24,y:sy+(ty-sy)*Double(i)/24);CGEvent(mouseEventSource:nil,mouseType:.leftMouseDragged,mouseCursorPosition:q,mouseButton:.left)?.post(tap:.cghidEventTap);usleep(50000) }
 CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:CGPoint(x:tx,y:ty),mouseButton:.left)?.post(tap:.cghidEventTap)
case "resize":''');a.write_text(t)
