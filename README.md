# LINE Desktop MCP

[English](#english) | [繁體中文](#繁體中文)

---

## 🍴 About this fork

This is a **fork of [dtwang/line-desktop-mcp](https://github.com/dtwang/line-desktop-mcp)**
by Geoffrey Wang, kept under the original **MIT License** (see [LICENSE.md](LICENSE.md);
copyright remains with the original author). All upstream functionality is
preserved; this fork adds a macOS reading path and an idle-aware scheduler, and
hardens a handful of automation bugs. Fork maintained by
**Sung Yeh ([@Sung-tsan](https://github.com/Sung-tsan))**.

> **Installing this fork (not the upstream npm package):** the macOS OCR/idle
> features below live in *this repository only* — they are **not** published to
> npm. `npx line-desktop-mcp@latest` pulls Geoffrey Wang's upstream package, which
> does not include them. To use this fork, **clone this repo, run
> `bash native/build.sh`, and point your MCP client at `node <path>/src/server.js`**
> (see the macOS install section).

### Why this fork

**1) Bug fixes contributed against the upstream GUI-automation path**

- **osascript calls had no timeout.** If LINE was blocked by a modal/pop-up, an
  unattended `osascript` could hang forever. Every AppleScript call now runs
  through a single `osa()` wrapper with a hard timeout (`src/automation/macos-line-automation.js`).
- **Chat selection wasn't verified.** Selecting a chat by name could silently
  open the *wrong* room. Selection now reads back the opened chat's header and
  aborts on mismatch, and the OCR path matches the sidebar row by exact name.
- **`send_message_auto` had no guard** (a prompt-injection / accidental-send
  risk for an agent-driven tool). It is now disabled by default behind the
  `LINE_MCP_ALLOW_AUTO_SEND=true` environment gate (`src/server.js`).
- **AppleScript pitfalls hardened:** identifiers must not start with an
  underscore (`set _x …` raises compile error **-2741**), and a handler that
  uses a top-level variable must declare it `global` on both sides — both are
  easy to trip over and are avoided throughout the AppleScript in this fork.

**2) New reading method — screenshot + OCR + idle-aware scheduling (macOS)**

On newer macOS LINE builds, two hard facts make the classic approaches fail:

- **Message text is self-drawn and never enters the Accessibility tree**
  (`AXStaticText` values are empty), so AX cannot read message content. Upstream
  reads by driving the clipboard (Cmd+A / Cmd+C), which steals focus, keyboard,
  and the clipboard.
- **LINE drops its onscreen window ~1 second after losing focus**, so *background*
  screenshots are not possible either.

This fork's macOS read path instead uses:

- **Foreground screenshot + Apple Vision OCR** (excellent Traditional-Chinese
  accuracy, **zero LLM tokens** for text extraction) — no clipboard hijack, no
  keystrokes. Chat switching is done with a real click (`cliclick`) because
  AXPress / set-selected do nothing on these sidebar rows.
- **Idle-aware scheduling**: a launchd agent fires a few times a day, but the
  runner *waits for you to be idle* (HID idle ≥ N minutes) before it scans, so it
  never interrupts you mid-work.
- **Cursor + focus restoration**: it snapshots the frontmost app and mouse
  position before scanning and restores them afterward (even on error).

> **Honest caveat:** this read path is **not** background or non-hijacking. To
> capture, it briefly brings LINE to the foreground and moves the mouse to click
> a chat; it just restores your app and cursor when done, and is idle-gated so it
> only runs while you are away from the keyboard.

### Limitations of the OCR/idle path

- **macOS only** (uses Apple Vision, `screencapture`, `cliclick`, launchd). The
  Windows path is unchanged from upstream.
- Requires a **one-time Screen Recording permission**. For scheduled runs, the
  `node` binary launchd spawns needs this permission *of its own* — granting it
  to your terminal is not enough.
- LINE must be **logged in**, in **expanded-chat-window** mode, with a window
  that can be opened (not minimized to the menu bar), on the **primary display**.
- **Pull-based, not real-time**: it reads on a schedule / on demand, not on push.
- Sender/time separation from OCR is **best-effort heuristic**; the raw OCR lines
  are always kept so nothing is silently lost.

### Usage (macOS OCR scan)

```bash
# 1. Build the native helpers (needs Xcode Command Line Tools)
bash native/build.sh

# 2. Grant Screen Recording permission to your terminal (and, for scheduled
#    runs, to the node binary) under System Settings > Privacy & Security.

# 3. See which chatrooms are visible, to build your blocklist (no reads):
node scripts/scan-once.js --dry

#    Put names you never want scanned into src/scan/state/blocklist.json
#    (copy from blocklist.example.json).

# 4. Run one sweep now (only scans if you've been idle >= 5 min; --force to override):
node scripts/scan-once.js --force
#    Outputs land in src/scan/state/out/  (structured JSON + a Markdown daily report).

# 5. Install the idle-aware schedule (launchd, 3x/day by default):
scripts/install-schedule.sh install     # status | uninstall
```

The three MCP read tools (`get_line_chatroom_history_*`) are rerouted to this
screenshot+OCR engine on macOS; their names and parameters are unchanged.

### 安全機制（Scanner safety — abort / watchdog / activity guard）

The scan drives your real cursor (clicks + scrolls LINE). To make sure it can
**never** hijack the mouse again, every dangerous step (screenshot / click /
scroll) passes a mandatory checkpoint. These guards run in **every** mode —
including `--force` and the launchd daemon; `--force` only skips the *startup*
idle check, never the mid-run guards.

**Abort a running scan (stop it now):**

```bash
scripts/scan-abort.sh          # touches src/scan/state/ABORT, then pkill fallback
# or by hand:
touch src/scan/state/ABORT     # scan stops at its next checkpoint (<1s), restores cursor
pkill -f scan-once.js          # last-resort hard kill
```

The sentinel file is auto-deleted when the next scan starts, so a stale `ABORT`
can't wedge the following run.

**Layered watchdog** (all overridable via env or unchanged sane defaults):

| Limit | Env var | Default |
|---|---|---|
| Whole-sweep ceiling | `SCAN_TOTAL_MS` | 600000 (10 min) |
| Sidebar-enumeration stage | `SCAN_ENUM_MS` | 90000 (90 s) |
| Single chatroom read (incl. locate) | `SCAN_CHAT_MS` | 30000 (30 s) |
| Scroll iterations per stage (hard cap) | `SCAN_SCROLL_MAX` | 60 |
| Cursor-movement tolerance | `SCAN_CURSOR_TOL_PX` | 10 px |
| Progress line every N scrolls | `SCAN_PROGRESS_EVERY` | 5 |

**Mid-run activity detection.** `cliclick`'s synthetic events reset the system
HID idle timer, so idle time is useless once a scan is running. Instead, after
every click/scroll the scanner records where it parked the cursor; before the
next step it re-reads the live cursor (`cliclick p`, read-only) and, if it moved
more than the tolerance, treats it as "the user is back" and aborts.

**On any abort** (sentinel, a watchdog trip, or detected activity) the scan
restores your cursor + frontmost app, **writes and pushes whatever it already
read** (partial success beats losing everything), logs `⚠ watchdog 中止於階段 …`,
and exits non-zero. Enumeration/total aborts stop the whole sweep; a single
chatroom's own timeout just skips that room and continues.

Fast-loop unit tests for these guards (no GUI): `node --test test/scan-control.test.js`.

### DIKW 串接（推送到 DIKW pipeline）

每次 `scripts/scan-once.js` 完成掃描、寫完 `state/out/scan-*.json` 後，會嘗試把這次
掃描結果 POST 到 DIKW ingest API（`${url}/api/ingest/line`，Bearer token 驗證）。這一步
是 best-effort：推送失敗**不會**讓掃描本身失敗，也不會遺失資料。

**設定方式**（任一即可，env 優先於檔案）：
- 複製 `src/scan/state/dikw.example.json` 為 `src/scan/state/dikw.json`，填入
  `{ "url": "...", "token": "..." }`（此檔含機密 token，已在 `.gitignore`，不會進版控）。
- 或設環境變數 `DIKW_INGEST_URL` / `DIKW_INGEST_TOKEN`（適合 launchd plist 或 CI）。
- 兩者都沒有 → 直接跳過推送，console 會印一行說明，**不算錯誤**。

**行為**：
- 本次掃描沒有新訊息（`newMessages` 全空）→ 不推送、也不進 outbox。
- 推送成功（HTTP 200）→ 印出 `received/written/deduped` 統計。
- 推送失敗但屬於「可能重試就會好」的情況（連不上網路、逾時、5xx、非預期狀態碼）
  → 該筆 scan JSON 的檔名會被記進 `src/scan/state/outbox.json`（同樣已 gitignore），
  **不複製內容**，只存參照。下次 `scan-once.js` 執行時，開頭會先重試 outbox 裡的每一筆，
  成功就移除、失敗就累計次數，滿 **10 次**還是失敗會標記 `dead: true` 並保留檔案，
  之後不再自動重試，需要人工檢查（通常代表 endpoint 設錯或長期掛掉）。
- 推送失敗且是「重試也沒用」的情況（HTTP 401 token 錯、400 payload 格式錯）
  → **不會**進 outbox（reseend 同樣的 bytes 不會變好），直接在 console 印出明顯警告，
  需要人工修設定或修 payload。

**切換到 prod**：把 `src/scan/state/dikw.json` 的 `url` 從本機測試值改成正式 Vercel
網址（例如 `https://<your-app>.vercel.app`），token 也換成正式的 `DIKW_INGEST_TOKEN`
即可，不需要重啟或改程式碼。

---

## 繁體中文

透過 MCP（Model Context Protocol），使 AI 工具能夠與 LINE Desktop 整合，並執行訊息的讀取與發送操作。

![LINE Desktop MCP Demo with Claude Desktop](doc_media/line-desktop-demo-4x.gif)

![LINE Desktop MCP Demo with n8n](doc_media/line-desktop-mcp-demo-n8n-2x.gif)

### ⚠️ 重要說明

**這個專案不是 LINE 官方的 line-bot-mcp-server**

如果你要找的是官方版本，請前往：https://github.com/line/line-bot-mcp-server

### 與官方版本的差異

- **官方 line-bot-mcp-server**：透過 LINE Messaging API 操作 LINE Bot
- **本專案 line-desktop-mcp**：透過 MCP 在 Windows 或 Mac 上直接操作 LINE Desktop 應用程式

### 重要聲明

1. **本專案與 LINE 官方無任何關聯**  
   This project is NOT officially affiliated with LINE.

2. **無需申請 LINE Developers 或使用 Channel Access Token**  
   本專案透過已經完成登入的 LINE Desktop 應用程式進行操作，不需要申請開發者帳號或 API Token。

### 關於專案

LINE Desktop MCP 是一個基於 Model Context Protocol 的整合工具，讓 AI 工具（如 Claude Desktop, n8n ），能夠直接與 LINE Desktop 應用程式互動。透過此專案，您可以：

- 📖 讀取 LINE 聊天訊息
- ✉️ 發送 LINE 訊息（手動或自動）
- 🤖 將 LINE 整合到您的 AI 工作流程中

### 功能特色

- 🤖 **AI 整合**：透過 MCP 協議與 Claude Desktop、 n8n 等 AI 工具無縫整合
- 💬 **訊息操作**：支援讀取和發送 LINE 訊息
- 🖥️ **桌面整合**：直接與 LINE Desktop 應用程式互動
- 🔄 **自動化支援**：可選擇手動確認或自動發送訊息

### 系統需求

#### 基本需求

- **LINE Desktop**：v9.10 或以上版本
- **作業系統**：
  - Windows 10 或以上版本
  - macOS Ventura 13.0 或以上版本（需要 AppleScript 支援）

#### 與 Claude Desktop 整合

- **Claude Desktop App**：最新版本
- **Claude 訂閱方案**：Pro 方案

#### 與 n8n 整合

- **n8n**：支援 MCP 的版本

### 安裝方式

#### Windows

1. **安裝 Node.js**
   - 參考微軟官方文件：https://learn.microsoft.com/zh-tw/windows/dev-environment/javascript/nodejs-on-windows

2. **安裝 AutoHotkey v2**
   - 下載並安裝：https://www.autohotkey.com/

3. **設定 Claude Desktop**
   - 開啟 Claude Desktop 設定檔
   - 在 `mcpServers` 中加入以下設定：

```json
{
  "mcpServers": {
    "line-desktop-mcp": {
      "command": "npx",
      "args": ["line-desktop-mcp@latest"]
    }
  }
}
```

#### macOS（本 fork 的 OCR／閒置排程功能）

> ⚠️ `npx line-desktop-mcp@latest` 會裝到**上游 npm 套件**，不含本 fork 的 OCR／
> 閒置排程。請改用下面的 clone + 本地路徑方式。

1. **安裝 Node.js 與 cliclick**
   - `brew install node cliclick`

2. **Clone 並建置原生工具**
   ```bash
   git clone https://github.com/Sung-tsan/line-desktop-mcp.git
   cd line-desktop-mcp && npm install && bash native/build.sh
   ```

3. **設定 Claude Desktop**（指向本地 fork，非 npx）
   - 開啟 Claude Desktop 設定檔，在 `mcpServers` 中加入：

```json
{
  "mcpServers": {
    "line-desktop-mcp": {
      "command": "node",
      "args": ["/絕對路徑/line-desktop-mcp/src/server.js"]
    }
  }
}
```

4. **授予「螢幕錄製」權限**（系統設定 › 隱私權與安全性），OCR 讀取與排程掃描皆需要。

macOS 的截圖＋OCR 掃描與閒置排程用法，見上方英文 **Usage (macOS OCR scan)** 段。

### 進階設定

#### Streamable HTTP 模式

除了預設的 stdio 模式外，本專案也支援透過 Streamable HTTP 方式運行。此模式特別適合在 **n8n** 等支援 MCP 的平台中使用。

**啟動 Streamable HTTP 模式：**

```bash
# 本機使用（僅 localhost）
npx line-desktop-mcp@latest --http-mode --port 3000

# 開放外部連線（需搭配 token）
npx line-desktop-mcp@latest --http-mode --host 0.0.0.0 --port 3000 --token YOUR_SECRET
```

**參數說明：**
- `--http-mode`：啟用 Streamable HTTP 模式，使用 HTTP streaming 而非 stdio
- `--port <port>`：指定 HTTP 伺服器的 port（預設：3000）
- `--host <host>`：指定綁定的網路介面（預設：`127.0.0.1`）
- `--token <secret>`：設定 Bearer Token 驗證密鑰。當 `--host` 設為非 loopback 位址時為必填，以確保安全性

**MCP 端點配置：**

本機連接：
```
http://127.0.0.1:3000/mcp
```

Docker 中的 n8n 連接（同一台機器）：
```
http://host.docker.internal:3000/mcp
```

**傳輸方式：**
- POST 請求：發送 JSON-RPC 訊息並透過 SSE stream 接收回應
- 支援 session 管理，每個連接會獲得唯一的 session ID

**n8n 工作流程範例：**

如果您想在 n8n 中使用 LINE Desktop MCP，可以下載我們提供的範例工作流程檔案：
- 📥 [下載 n8n 工作流程範例](doc_media/LINE-Desktop-MCP-Demo-chatbot-sample.json)

此範例展示如何在 n8n 中整合 LINE Desktop MCP 建立聊天機器人工作流程。

### 使用方式

在 Claude Desktop 的對話中，您可以使用以下方式操作 LINE：

#### 1. 讀取聊天內容

```
請幫我讀取 LINE 群組『專案討論』的訊息，並作出總結
```

#### 2. 發送訊息（手動確認）

```
請幫我撰寫一個問候，發送到 LINE 群組『專案討論』中
```

Claude 會先撰寫訊息內容，等待您確認後再發送。

#### 3. 發送訊息（自動送出）

```
請幫我撰寫一個問候，發送到 LINE 群組『專案討論』中，並自動發送
```

Claude 會撰寫訊息並自動完成發送動作。

### 使用注意事項

#### 重要提醒

1. **避免干擾自動化操作**  
   本工具透過圖形使用者介面（GUI）進行自動化操作。在自動化程式執行期間，請勿同時使用滑鼠進行其他操作，以免干擾程式運作。

2. **LINE Desktop 視窗配置要求**  
   請確保 LINE Desktop 使用「展開聊天視窗」模式。在此模式下，聊天視窗會固定顯示在聊天室清單的右側，而非以獨立視窗方式開啟。

3. **多顯示器環境配置**  
   若您使用多個顯示器,請將 LINE Desktop 應用程式放置於主要顯示器（第一個顯示器）上,以確保自動化功能正常運作。

### 授權條款

本專案採用 MIT 授權條款 - 詳見 [LICENSE.md](LICENSE.md) 檔案

### 作者

**Geoffrey Wang** — original author
- GitHub: [@dtwang](https://github.com/dtwang)
- Threads: [@geoff_spacetime](https://www.threads.com/@geoff_spacetime)

**Sung Yeh** — fork maintainer (macOS OCR / idle-scheduler)
- GitHub: [@Sung-tsan](https://github.com/Sung-tsan)

---

## English

Integrate AI tools with LINE Desktop through MCP (Model Context Protocol) to enable message reading and sending operations.

![LINE Desktop MCP Demo with Claude Desktop](doc_media/line-desktop-demo-4x.gif)

![LINE Desktop MCP Demo with n8n](doc_media/line-desktop-mcp-demo-n8n-2x.gif)

### ⚠️ Important Notice

**This project is NOT the official LINE line-bot-mcp-server**

If you're looking for the official version, please visit: https://github.com/line/line-bot-mcp-server

### Differences from Official Version

- **Official line-bot-mcp-server**: Operates LINE Bot through LINE Messaging API
- **This project line-desktop-mcp**: Directly operates LINE Desktop application on Windows or Mac through MCP

### Important Disclaimer

1. **This project is NOT officially affiliated with LINE**  
   本專案與 LINE 官方無任何關聯。

2. **No need to apply for LINE Developers or use Channel Access Token**  
   This project operates through the already logged-in LINE Desktop application, without requiring developer account registration or API tokens.

### About

LINE Desktop MCP is an integration tool based on the Model Context Protocol that allows AI tools (such as Claude Desktop, n8n ) to interact directly with the LINE Desktop application. With this project, you can:

- 📖 Read LINE chat messages
- ✉️ Send LINE messages (manual or automatic)
- 🤖 Integrate LINE into your AI workflows

### Features

- 🤖 **AI Integration**: Seamlessly integrate with AI tools like Claude Desktop, n8n through the MCP protocol
- 💬 **Message Operations**: Support for reading and sending LINE messages
- 🖥️ **Desktop Integration**: Direct interaction with the LINE Desktop application
- 🔄 **Automation Support**: Choose between manual confirmation or automatic message sending

### System Requirements

#### Basic Requirements

- **LINE Desktop**: v9.10 or above
- **Operating System**:
  - Windows 10 or above
  - macOS Ventura 13.0 or above (requires AppleScript support)

#### Integration with Claude Desktop

- **Claude Desktop App**: Latest version
- **Claude Subscription**: Pro plan

#### Integration with n8n

- **n8n**: Version with MCP support

### Installation

#### Windows

1. **Install Node.js**
   - Follow Microsoft's official guide: https://learn.microsoft.com/en-us/windows/dev-environment/javascript/nodejs-on-windows

2. **Install AutoHotkey v2**
   - Download and install: https://www.autohotkey.com/

3. **Configure Claude Desktop**
   - Open Claude Desktop configuration file
   - Add the following to `mcpServers`:

```json
{
  "mcpServers": {
    "line-desktop-mcp": {
      "command": "npx",
      "args": ["line-desktop-mcp@latest"]
    }
  }
}
```

#### macOS (this fork's OCR / idle-scheduling features)

> ⚠️ `npx line-desktop-mcp@latest` installs the **upstream npm package**, which
> does **not** include this fork's OCR / idle scheduler. Use the clone + local
> path below instead.

1. **Install Node.js and cliclick**
   - `brew install node cliclick`

2. **Clone and build the native helpers**
   ```bash
   git clone https://github.com/Sung-tsan/line-desktop-mcp.git
   cd line-desktop-mcp && npm install && bash native/build.sh
   ```

3. **Configure Claude Desktop** (point at the local fork, not npx)
   - Open the Claude Desktop config file and add to `mcpServers`:

```json
{
  "mcpServers": {
    "line-desktop-mcp": {
      "command": "node",
      "args": ["/absolute/path/line-desktop-mcp/src/server.js"]
    }
  }
}
```

4. **Grant Screen Recording permission** (System Settings › Privacy & Security) —
   required for OCR reading and scheduled scans. See **Usage (macOS OCR scan)** above.

### Advanced Configuration

#### Streamable HTTP Mode

In addition to the default stdio mode, this project also supports running via Streamable HTTP. This mode is particularly suitable for use with platforms like **n8n** that support MCP.

**Start Streamable HTTP Mode:**

```bash
# Local use (localhost only)
npx line-desktop-mcp@latest --http-mode --port 3000

# Allow external connections (token required)
npx line-desktop-mcp@latest --http-mode --host 0.0.0.0 --port 3000 --token YOUR_SECRET
```

**Parameters:**
- `--http-mode`: Enable Streamable HTTP mode, using HTTP streaming instead of stdio
- `--port <port>`: Specify the HTTP server port (default: 3000)
- `--host <host>`: Specify the network interface to bind (default: `127.0.0.1`)
- `--token <secret>`: Set Bearer Token authentication secret. Required when `--host` is set to a non-loopback address for security

**MCP Endpoint Configuration:**

Local connection:
```
http://127.0.0.1:3000/mcp
```

n8n in Docker (same machine):
```
http://host.docker.internal:3000/mcp
```

**Transport Method:**
- POST requests: Send JSON-RPC messages and receive responses via SSE stream
- Supports session management with unique session IDs for each connection

**n8n Workflow Example:**

If you want to use LINE Desktop MCP in n8n, you can download our sample workflow file:
- 📥 [Download n8n Workflow Example](doc_media/LINE-Desktop-MCP-Demo-chatbot-sample.json)

This example demonstrates how to integrate LINE Desktop MCP in n8n to create a chatbot workflow.

### Usage

In Claude Desktop conversations, you can interact with LINE in the following ways:

#### 1. Read Chat Messages

```
Please read the messages from LINE group 'Project Discussion' and summarize them
```

#### 2. Send Messages (Manual Confirmation)

```
Please write a greeting and send it to LINE group 'Project Discussion'
```

Claude will compose the message and wait for your confirmation before sending.

#### 3. Send Messages (Automatic)

```
Please write a greeting and send it to LINE group 'Project Discussion', and send it automatically
```

Claude will compose the message and automatically complete the sending action.

### Usage Precautions

#### Important Reminders

1. **Avoid Interfering with Automation**  
   This tool performs automation through the graphical user interface (GUI). During automated operations, please refrain from using the mouse for other tasks to prevent interference with the program's execution.

2. **LINE Desktop Window Configuration**  
   Please ensure that LINE Desktop is configured in "Expanded Chat Window" mode. In this mode, the chat window remains docked to the right side of the chat list, rather than opening as a separate independent window.

3. **Multi-Monitor Setup**  
   If you are using multiple monitors, please ensure that the LINE Desktop application is positioned on the primary display (first monitor) for the automation to function correctly.

### License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details

### Author

**Geoffrey Wang** — original author
- GitHub: [@dtwang](https://github.com/dtwang)
- Threads: [@geoff_spacetime](https://www.threads.com/@geoff_spacetime)

**Sung Yeh** — fork maintainer (macOS OCR / idle-scheduler)
- GitHub: [@Sung-tsan](https://github.com/Sung-tsan)
