from pathlib import Path
p=Path('scripts/media/ax.swift');s=p.read_text();assert 'u?.flags=flags;' in s;s=s.replace('u?.flags=flags;','u?.flags=[];');p.write_text(s)
p=Path('scripts/media/capture.py');s=p.read_text()
def replace(old,new):
 global s
 assert s.count(old)==1,(old,s.count(old));s=s.replace(old,new)
replace("# Optional Quick Action, not bundled in the installed Beta 6.","""import base64
(folder/'06-Overview.pdf').write_bytes(base64.b64decode((repo/'scripts/media/overview.b64').read_text()))
# Optional Quick Action, not bundled in the installed Beta 6.""")
replace("('04-Reference.png','06-image'),('05-Board.md','07-board')", "('04-Reference.png','06-image'),('06-Overview.pdf','06-pdf'),('05-Board.md','07-board')")
replace("mark(label);cmd(pid,'click',name);time.sleep(1);shot(label)","mark(label);cmd(pid,'click',name);time.sleep(2.2);shot(label)")
replace("cmd(pid,'click','Add to plan');time.sleep(.8);shot('04-html-interaction')", "cmd(pid,'click','Add to plan');time.sleep(1.8);shot('04-html-interaction')")
replace("cmd(pid,'click','05-Board.md');time.sleep(.7);nodes=dump(pid,'board-controls');mark('board-drag')", "cmd(pid,'click','05-Board.md');time.sleep(1);cmd(pid,'click','Preview','AXButton');time.sleep(.7);nodes=dump(pid,'board-controls');mark('board-drag')")
replace("except Exception as e:report['boardMove']=str(e)","except Exception as e:report['boardMove']=repr(e);dump(pid,'board-move-failure')")
replace("time.sleep(.8);nodes=dump(fpid,'finder-menu');shot('10-finder-menu')", "time.sleep(1.8);nodes=dump(fpid,'finder-menu');shot('10-finder-menu')")
replace("time.sleep(.8);shot('12-chinese');dump(pid,'chinese-interface');mark('language-switched')", "time.sleep(2);shot('12-chinese');nodes=dump(pid,'chinese-interface');assert any(n['title']=='界面语言' for n in nodes);mark('language-switched');time.sleep(2)")
p.write_text(s)
