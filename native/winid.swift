import CoreGraphics
import Foundation
// Pick LINE's main chat window: largest-area onscreen LINE window with real dimensions.
// Output: "<CGWindowID> <x> <y> <w> <h>"  (window origin + size in logical points,
// global display coordinates, top-left origin) — or "NONE".
// The origin (x,y) is required to translate OCR pixel coords back to on-screen
// logical coords for cliclick:  screen = origin + ocr_px / (ocr.width / w).
func num(_ v: Any?) -> Int {  // CGWindowBounds values may arrive as Int or Double
  if let i = v as? Int { return i }
  if let d = v as? Double { return Int(d.rounded()) }
  return 0
}
if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
  var best: (id: Int, area: Int, x: Int, y: Int, w: Int, h: Int)? = nil
  for w in list {
    guard (w["kCGWindowOwnerName"] as? String) == "LINE" else { continue }
    let b = w["kCGWindowBounds"] as? [String: Any] ?? [:]
    let x = num(b["X"]), y = num(b["Y"]), width = num(b["Width"]), height = num(b["Height"])
    if width < 400 || height < 300 { continue }  // skip toolbars/strips
    let area = width * height
    if best == nil || area > best!.area { best = (w["kCGWindowNumber"] as? Int ?? -1, area, x, y, width, height) }
  }
  if let b = best { print("\(b.id) \(b.x) \(b.y) \(b.w) \(b.h)") } else { print("NONE") }
}
