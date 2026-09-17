from pathlib import Path
p=Path('scripts/media/capture.py');s=p.read_text();old="def cmd(pid,op,*args,**kw):return run([ax,pid,op,*args],**kw)";assert s.count(old)==1
s=s.replace(old,"""def cmd(pid,op,*args,**kw):
 for attempt in range(45):
  try:return run([ax,pid,op,*args],**kw)
  except subprocess.CalledProcessError as e:
   if 'Element not found' not in (e.stderr or '') or op not in ['click','press','right','showmenu'] or attempt==44:raise
   time.sleep(.3)
""")
p.write_text(s)
p=Path('scripts/media/ax.swift');s=p.read_text();a=s.index('func mouse(');b=s.index('func key(',a)
s=s[:a]+'''func mouse(_ x:Double,_ y:Double,_ right:Bool=false){
 let p=CGPoint(x:x,y:y)
 func post(_ type:CGEventType,_ button:CGMouseButton){let e=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:p,mouseButton:button);e?.flags=[];e?.post(tap:.cghidEventTap)}
 post(.mouseMoved,.left);usleep(140000);post(right ? .rightMouseDown:.leftMouseDown,right ? .right:.left);usleep(80000);post(right ? .rightMouseUp:.leftMouseUp,right ? .right:.left)
}
'''+s[b:];p.write_text(s)
