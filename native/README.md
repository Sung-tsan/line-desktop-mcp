# native/ — 本機零 token 讀取工具（macOS）

LINE 這版把訊息文字自繪，**不進 Accessibility 層**（AXStaticText 的 AXValue 全空），
所以 AX 讀不到訊息內容。改走「背景截圖 + Apple Vision OCR」，全程不搶焦點、抽字零 LLM token。

## ocr.swift
Vision framework OCR，吃 PNG 吐 JSON（含每行 bbox，用 x 座標分 sender/時間/訊息欄）。

編譯：
```
swiftc -O -o native/ocr native/ocr.swift
```
用法：
```
screencapture -x -o -l <CGWindowID> shot.png   # 背景截圖,需「螢幕錄製」權限
native/ocr shot.png                             # → {ok,width,height,lines:[{text,conf,x,y,w,h}]}
```

## 讀訊息完整流程（規劃）
1. AXPress 目標聊天室的 row（切房,不動游標）
2. 取 LINE 主視窗 CGWindowID → screencapture -l 背景截圖
3. ocr → 依 bbox 分欄解析成 {sender,time,text}[]
4. 用「上次讀到的最後一則」做游標,只回新訊息

需一次性權限：系統設定 › 隱私權與安全性 › 螢幕錄製 › 勾 Claude/終端機。
