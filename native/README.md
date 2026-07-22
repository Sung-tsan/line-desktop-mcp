# native/ — local zero-token read helpers (macOS)

This LINE build **self-draws message text; it never lands in the Accessibility
tree** (AXStaticText AXValue is empty), so AX cannot read message content. It
also **drops its onscreen window ~1s after losing focus**, so background
screenshots are impossible. The working read path is therefore
**foreground screenshot + Apple Vision OCR** — no clipboard hijack, no
keystrokes, zero LLM tokens for text extraction.

Build all three helpers:

```
bash native/build.sh          # or: swiftc -O -o native/<name> native/<name>.swift
```

Compiled binaries are gitignored.

## ocr.swift → `ocr`
Apple Vision OCR. Takes a PNG, emits JSON with per-line bounding boxes.

```
ocr <image.png> [--langs zh-Hant,en]
# → {ok,width,height,lines:[{text,conf,x,y,w,h}]}
```
Coordinates are **image pixels** (retina, usually 2×). Reading order:
top→bottom, then left→right. Use the `x` column to split sidebar vs. message
area; use `y` bands to group lines into rows / message bubbles.

## winid.swift → `winid`
Prints LINE's main window id **and its logical bounds**:

```
winid
# → "<CGWindowID> <x> <y> <w> <h>"   (logical points, global top-left origin)
# → "NONE" if no suitable LINE window is onscreen
```
Picks the largest onscreen LINE window ≥ 400×300. The origin `(x,y)` is what
lets you map an OCR pixel box back to an on-screen click point:

```
scale = ocr.width / w
screenX = x + ocr_px_x / scale
screenY = y + ocr_px_y / scale
```

## input.swift → `input`  ⚠️ needs Accessibility
The ONE input helper: cursor **move**, **click**, and **scroll**. It is the only
binary that posts HID events, so it is the only one that needs the macOS
**Accessibility** grant — posting is attributed to *this* binary, not to the
`node` that spawns it (granting node is not enough; that is why `cliclick`'s
clicks were silently dropped under launchd). Positioning uses
`CGWarpMouseCursorPosition` (needs no grant). `cliclick` is used ONLY for `p`
(reading the cursor).

```
input move   <x> <y>            # warp the cursor
input click  <x> <y>            # warp, then a real left click
input scroll <x> <y> <lines>    # warp, then wheel; positive = up, negative = down
```

Grant once: **System Settings → Privacy & Security → Accessibility → add the
absolute path `<repo>/native/input`.** Keep that path stable. ⚠️ Rebuilding
(`native/build.sh`) changes the binary's code hash, so the grant must be
re-approved after each rebuild — rebuild rarely.

## Read flow (implemented in ../src/scan/scan-engine.js)
1. Bring LINE to the foreground and poll `winid` until the window is rendered.
2. `screencapture -x -o -l <id>` → PNG (needs **Screen Recording** permission).
3. `ocr` the PNG; split sidebar (left) from message area (right) by `x`.
4. To open a chat: OCR the sidebar, find the row by name, translate its box to a
   screen point, and **click it with `input click`** — AXPress / set-selected do
   nothing on these rows (LINE wires no AX action); a real click is the only
   thing that works, and it must come from the granted `input` binary.
5. Diff against the last scan (message fingerprints) so only new messages return.
6. Restore the previous frontmost app + cursor when done.

One-time permissions (two separate grants):
- **Screen Recording** — the process that runs the scan (`node` launchd spawns
  for scheduled runs; your terminal for manual runs). Needed for `screencapture`.
- **Accessibility** — the `native/input` binary (absolute path). Needed to POST
  clicks/scroll. Granting `node` does NOT cover it — TCC attributes posted events
  to `input` itself. Without this, clicks/scroll are silently dropped and every
  room reads 0 messages.
