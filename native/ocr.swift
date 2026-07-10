// ocr <image.png> [--langs zh-Hant,en]
// OCR an image with Apple Vision. Output JSON {ok,width,height,lines:[{text,conf,x,y,w,h}]}.
// Local, zero LLM tokens. Reading order: top→bottom, left→right.
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: ocr <image> [--langs zh-Hant,en]\n".data(using: .utf8)!); exit(64)
}
let path = args[1]
var langs = ["zh-Hant", "en"]
var i = 2
while i < args.count { if args[i] == "--langs", i+1 < args.count { langs = args[i+1].split(separator: ",").map(String.init); i += 2 } else { i += 1 } }

guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("BAD_IMAGE: cannot load \(path)\n".data(using: .utf8)!); exit(2)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
req.recognitionLanguages = langs
do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) } catch {
  FileHandle.standardError.write("OCR_FAILED: \(error)\n".data(using: .utf8)!); exit(5)
}
let H = Double(cg.height), W = Double(cg.width)
var out: [[String: Any]] = []
for obs in (req.results ?? []) {
  guard let t = obs.topCandidates(1).first else { continue }
  let bb = obs.boundingBox
  out.append(["text": t.string, "conf": t.confidence,
    "x": Int(bb.minX*W), "y": Int((1-bb.maxY)*H), "w": Int(bb.width*W), "h": Int(bb.height*H)])
}
out.sort { a, b in let ay=a["y"] as! Int, by=b["y"] as! Int; if abs(ay-by)>8 { return ay<by }; return (a["x"] as! Int)<(b["x"] as! Int) }
let data = try JSONSerialization.data(withJSONObject: ["ok": true, "width": cg.width, "height": cg.height, "lines": out])
FileHandle.standardOutput.write(data); FileHandle.standardOutput.write("\n".data(using: .utf8)!)
