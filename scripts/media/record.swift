import Foundation
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true", CommandLine.arguments.count == 2 else { exit(2) }
let out=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
Task {
 do {
  let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
  guard let display=content.displays.first else {throw NSError(domain:"No display",code:1)}
  let filter=SCContentFilter(display:display,excludingApplications:[],exceptingWindows:[])
  let config=SCStreamConfiguration();config.width=display.width;config.height=display.height;config.showsCursor=true
  let dir=out.appendingPathComponent("frames");try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
  FileManager.default.createFile(atPath:out.appendingPathComponent("frames.jsonl").path,contents:nil)
  let log=try FileHandle(forWritingTo:out.appendingPathComponent("frames.jsonl"))
  let start=Date().timeIntervalSince1970;var n=0
  while !FileManager.default.fileExists(atPath:out.appendingPathComponent("STOP").path) && Date().timeIntervalSince1970-start<150 {
   let before=Date().timeIntervalSince1970
   let img=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
   let name=String(format:"frame-%05d.jpg",n)
   if let dest=CGImageDestinationCreateWithURL(dir.appendingPathComponent(name) as CFURL,UTType.jpeg.identifier as CFString,1,nil){CGImageDestinationAddImage(dest,img,[kCGImageDestinationLossyCompressionQuality:0.9] as CFDictionary);guard CGImageDestinationFinalize(dest) else {throw NSError(domain:"Frame save",code:2)}}
   let item:[String:Any]=["file":"frames/"+name,"epoch":before,"capturedEpoch":Date().timeIntervalSince1970]
   log.write(try JSONSerialization.data(withJSONObject:item));log.write(Data([10]));n+=1
   let delay=max(0,0.1-(Date().timeIntervalSince1970-before));try await Task.sleep(nanoseconds:UInt64(delay*1_000_000_000))
  }
  try log.close();print("Recorded \(n) real desktop frames");exit(0)
 } catch {fputs("\(error)\n",stderr);exit(1)}
}
dispatchMain()
