#!/bin/bash
# 編譯 native macOS helpers(需 Xcode CommandLineTools)。產物 gitignore,不進版控。
set -e
cd "$(dirname "$0")"
for f in ocr winid scroll; do swiftc -O -o "$f" "$f.swift" && echo "built native/$f"; done
