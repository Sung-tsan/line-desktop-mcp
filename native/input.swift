// input <verb> ...  — the ONE native input helper for the LINE scanner (macOS).
//
//   move   <x> <y>            reposition the cursor (CGWarpMouseCursorPosition)
//   click  <x> <y>            warp, then post a real left click at (x,y)
//   scroll <x> <y> <lines>    warp, then post wheel events (negative lines = down)
//
// ── WHY THIS BINARY EXISTS (read before "simplifying" it away) ───────────────
// Posting synthetic HID events (mouse-button clicks, scroll-wheel) requires the
// **posting executable itself** to hold the Accessibility (AXIsProcessTrusted)
// grant. macOS/TCC attributes a posted event to THIS binary — NOT to the `node`
// process that spawned it. That is why, on 2026-07-22, granting node Accessibility
// was not enough: `cliclick`'s clicks were silently dropped in the launchd context
// (its own binary was never granted), so every "open chatroom" click did nothing
// and the scanner re-screenshotted the sidebar 7× in a row. Cursor *positioning*
// via CGWarpMouseCursorPosition needs no grant, which is exactly why moves worked
// while clicks/wheel did not.
//
// The fix is to funnel EVERY event-posting action through this single binary and
// grant Accessibility to it alone:
//   System Settings → Privacy & Security → Accessibility → add:
//     <repo>/native/input      (absolute path — keep it stable)
// `cliclick` is kept ONLY for `p` (reading the cursor, which needs no grant).
//
// ⚠ TCC keys on this binary's code hash: REBUILDING it (native/build.sh) changes
//   the hash, so the Accessibility grant must be re-approved after every rebuild.
//   Rebuild rarely; the path stays fixed so re-approval is one click.
import CoreGraphics
import Foundation

func warp(_ x: Double, _ y: Double) {
  CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
  CGAssociateMouseAndMouseCursorPosition(1) // re-couple HW mouse + cursor after the warp
}

func die(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(64)
}

let a = CommandLine.arguments
guard a.count >= 2 else { die("usage: input move|click|scroll <x> <y> [lines]") }

switch a[1] {
case "move":
  guard a.count >= 4, let x = Double(a[2]), let y = Double(a[3]) else { die("usage: input move <x> <y>") }
  warp(x, y)

case "click":
  guard a.count >= 4, let x = Double(a[2]), let y = Double(a[3]) else { die("usage: input click <x> <y>") }
  warp(x, y)
  usleep(60_000) // let the cursor settle at the target before pressing
  let p = CGPoint(x: x, y: y)
  let src = CGEventSource(stateID: .hidSystemState)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?
    .post(tap: .cghidEventTap)
  usleep(40_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?
    .post(tap: .cghidEventTap)

case "scroll":
  guard a.count >= 5, let x = Double(a[2]), let y = Double(a[3]), let n = Int32(a[4]) else { die("usage: input scroll <x> <y> <lines>") }
  warp(x, y)
  usleep(80_000) // let the WindowServer register the new cursor location before scrolling
  let src = CGEventSource(stateID: .hidSystemState)
  for _ in 0..<abs(n) {
    CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 1, wheel1: (n < 0 ? -3 : 3), wheel2: 0, wheel3: 0)?
      .post(tap: .cghidEventTap)
    usleep(30_000)
  }

default:
  die("unknown verb: \(a[1])  (move|click|scroll)")
}
