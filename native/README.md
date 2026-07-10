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

## scroll.swift → `scroll`
Posts scroll-wheel events at a screen point (to page the sidebar or message
area) without visibly parking the cursor there.

```
scroll <x> <y> <lines>     # positive lines = up, negative = down
```

## Read flow (implemented in ../src/scan/scan-engine.js)
1. Bring LINE to the foreground and poll `winid` until the window is rendered.
2. `screencapture -x -o -l <id>` → PNG (needs **Screen Recording** permission).
3. `ocr` the PNG; split sidebar (left) from message area (right) by `x`.
4. To open a chat: OCR the sidebar, find the row by name, translate its box to a
   screen point, and **click it with `cliclick`** — AXPress / set-selected do
   nothing on these rows (LINE wires no AX action); a real click is the only
   thing that works.
5. Diff against the last scan (message fingerprints) so only new messages return.
6. Restore the previous frontmost app + cursor when done.

One-time permission: System Settings › Privacy & Security › Screen Recording ›
enable the process that runs the scan (your terminal for manual runs, and the
`node` binary launchd spawns for scheduled runs — grant it separately).
