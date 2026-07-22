#!/bin/bash
# 編譯 native macOS helpers(需 Xcode CommandLineTools)。產物 gitignore,不進版控。
# input = 統一輸入 helper(move/click/scroll,取代舊 scroll);它是唯一需要
# Accessibility 授權的二進位(見 input.swift 檔頭)。重編會改 code hash,授權需重按一次。
set -e
cd "$(dirname "$0")"
for f in ocr winid input; do swiftc -O -o "$f" "$f.swift" && echo "built native/$f"; done
