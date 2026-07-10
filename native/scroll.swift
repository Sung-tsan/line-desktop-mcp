// scroll <x> <y> <lines(neg=down)>  — post scroll-wheel events at screen point without moving cursor visibly
import CoreGraphics
import Foundation
let a = CommandLine.arguments
guard a.count >= 4, let x = Double(a[1]), let y = Double(a[2]), let n = Int32(a[3]) else { exit(64) }
// move cursor to point (needed so scroll targets that window), then scroll
let warp = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x:x,y:y), mouseButton: .left)
warp?.post(tap: .cghidEventTap)
usleep(80_000)
for _ in 0..<abs(n) {
  let ev = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: (n<0 ? -3 : 3), wheel2: 0, wheel3: 0)
  ev?.post(tap: .cghidEventTap)
  usleep(30_000)
}
