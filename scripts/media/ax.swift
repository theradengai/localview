import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
func fail(_ text: String) -> Never { fputs(text+"\n",stderr); exit(1) }
guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else { fail("Disposable runner only") }
let a=CommandLine.arguments
guard a.count >= 3, let pid=Int32(a[1]), let app=NSRunningApplication(processIdentifier:pid) else { fail("Expected owned PID and action") }
guard ["ai.theradeng.localview","com.apple.finder"].contains(app.bundleIdentifier ?? "") else { fail("Unapproved application") }
func attr(_ e: AXUIElement,_ n:String)->CFTypeRef? { var v:CFTypeRef?; AXUIElementCopyAttributeValue(e,n as CFString,&v); return v }
func text(_ e:AXUIElement,_ n:String)->String { (attr(e,n) as? String) ?? "" }
func frame(_ e:AXUIElement)->[Double] {var p=CGPoint.zero,s=CGSize.zero; if let v=attr(e,"AXPosition"),CFGetTypeID(v)==AXValueGetTypeID(){AXValueGetValue(v as! AXValue,.cgPoint,&p)};if let v=attr(e,"AXSize"),CFGetTypeID(v)==AXValueGetTypeID(){AXValueGetValue(v as! AXValue,.cgSize,&s)};return [p.x,p.y,s.width,s.height]}
var nodes:[AXUIElement]=[]
func walk(_ e:AXUIElement,_ d:Int){ if d>30 || nodes.count>9000{return};nodes.append(e);for c in (attr(e,"AXChildren") as? [AXUIElement]) ?? [] {walk(c,d+1)} }
let root=AXUIElementCreateApplication(pid)
walk(root,0)
func matches(_ e:AXUIElement,_ name:String)->Bool { ["AXTitle","AXDescription","AXValue"].contains{ text(e,$0)==name } }
func find(_ name:String,_ role:String="")->AXUIElement? { nodes.filter{matches($0,name)&&(role.isEmpty||text($0,"AXRole")==role)}.sorted{frame($0)[1]<frame($1)[1]}.first }
func mouse(_ x:Double,_ y:Double,_ right:Bool=false){let p=CGPoint(x:x,y:y);CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:p,mouseButton:.left)?.post(tap:.cghidEventTap);usleep(140000); CGEvent(mouseEventSource:nil,mouseType:right ? .rightMouseDown:.leftMouseDown,mouseCursorPosition:p,mouseButton:right ? .right:.left)?.post(tap:.cghidEventTap);usleep(80000);CGEvent(mouseEventSource:nil,mouseType:right ? .rightMouseUp:.leftMouseUp,mouseCursorPosition:p,mouseButton:right ? .right:.left)?.post(tap:.cghidEventTap)}
func key(_ code:CGKeyCode,_ flags:CGEventFlags=[]){let d=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:true),u=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false);d?.flags=flags;u?.flags=flags;d?.post(tap:.cghidEventTap);usleep(60000);u?.post(tap:.cghidEventTap)}
switch a[2] {
case "dump":
 let out=nodes.map{["role":text($0,"AXRole"),"title":text($0,"AXTitle"),"description":text($0,"AXDescription"),"value":String(text($0,"AXValue").prefix(500)),"frame":frame($0)] as [String:Any]};print(String(data:try JSONSerialization.data(withJSONObject:out,options:[.prettyPrinted]),encoding:.utf8)!)
case "click","right","press","showmenu":
 guard a.count>3,let e=find(a[3],a.count>4 ? a[4]:"") else {fail("Element not found: \(a.dropFirst(3))")}
 if a[2]=="press"||a[2]=="showmenu" {let result=AXUIElementPerformAction(e,(a[2]=="press" ? "AXPress":"AXShowMenu") as CFString);guard result == .success else {fail("AX action failed: \(result)")}}
 else {let f=frame(e);guard f[2]>0 && f[3]>0 else{fail("Empty frame")};mouse(f[0]+f[2]/2,f[1]+f[3]/2,a[2]=="right")}
case "key":
 guard a.count>3,let code=UInt16(a[3]) else {fail("Missing key code")};let fs=a.count>4 ? a[4]:"";var flags:CGEventFlags=[];if fs.contains("cmd"){flags.insert(.maskCommand)};if fs.contains("shift"){flags.insert(.maskShift)};if fs.contains("alt"){flags.insert(.maskAlternate)};key(code,flags)
case "paste":
 let s=String(data:FileHandle.standardInput.readDataToEndOfFile(),encoding:.utf8) ?? "";NSPasteboard.general.clearContents();NSPasteboard.general.setString(s,forType:.string);key(9,.maskCommand)
case "xy":
 guard a.count>=5,let x=Double(a[3]),let y=Double(a[4])else{fail("Missing point")};mouse(x,y,a.count>5 && a[5]=="right")
case "resize":
 if let ws=attr(root,"AXWindows") as? [AXUIElement],let w=ws.first {var p=CGPoint(x:20,y:50),s=CGSize(width:980,height:650);AXUIElementSetAttributeValue(w,"AXPosition" as CFString,AXValueCreate(.cgPoint,&p)!);AXUIElementSetAttributeValue(w,"AXSize" as CFString,AXValueCreate(.cgSize,&s)!)}
default:fail("Unknown action")
}
