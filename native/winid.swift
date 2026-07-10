import CoreGraphics
import Foundation
// Pick LINE's main chat window: largest-area onscreen LINE window with real dimensions.
if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
  var best: (id: Int, area: Int, w: Int, h: Int)? = nil
  for w in list {
    guard (w["kCGWindowOwnerName"] as? String) == "LINE" else { continue }
    let b = w["kCGWindowBounds"] as? [String: Any] ?? [:]
    let width = (b["Width"] as? Int) ?? 0, height = (b["Height"] as? Int) ?? 0
    if width < 400 || height < 300 { continue }  // skip toolbars/strips
    let area = width * height
    if best == nil || area > best!.area { best = (w["kCGWindowNumber"] as? Int ?? -1, area, width, height) }
  }
  if let b = best { print("\(b.id) \(b.w)x\(b.h)") } else { print("NONE") }
}
