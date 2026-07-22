// scroll <x> <y> <lines(neg=down)>  — position the cursor at a screen point, then
// post scroll-wheel events so they hit the window under it.
//
// Cursor positioning uses CGWarpMouseCursorPosition — the same reliable,
// permission-free primitive cliclick's `m:` uses. The previous approach (posting
// a synthetic .mouseMoved event via .cghidEventTap) was SILENTLY DROPPED in the
// launchd/daemon context: the cursor never moved, so the wheel events hit the
// wrong window (nothing scrolled) AND the activity guard saw the cursor far from
// where we thought we parked it. cliclick's clicks worked in the exact same
// context precisely because they warp via this API, not a posted move event.
// CGWarp needs no Accessibility grant and repositions the cursor deterministically.
import CoreGraphics
import Foundation
let a = CommandLine.arguments
guard a.count >= 4, let x = Double(a[1]), let y = Double(a[2]), let n = Int32(a[3]) else { exit(64) }
CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
// Re-couple the hardware mouse with the (just-warped) cursor; CGWarp leaves them
// associated by default, but this is explicit and harmless.
CGAssociateMouseAndMouseCursorPosition(1)
usleep(80_000) // let the WindowServer register the new cursor location before scrolling
for _ in 0..<abs(n) {
  let ev = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: (n<0 ? -3 : 3), wheel2: 0, wheel3: 0)
  ev?.post(tap: .cghidEventTap)
  usleep(30_000)
}
