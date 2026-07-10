// macos-line-automation.js
//
// AX-first LINE Desktop automation for macOS.
//
// Design contract (see ax-first branch patches P1–P5):
//  - READ path (preflight / selectChatAX / readMessagesAX) is NON-HIJACKING:
//    it never activates LINE, never moves the mouse (cliclick), never sends
//    keystrokes, and never touches the clipboard. It only reads / presses the
//    Accessibility (AX) tree, so the user can keep working while it runs.
//  - SEND path (sendMessage) is allowed to hijack (it must, to type into LINE),
//    but it snapshots and restores the clipboard around any paste.
//  - All osascript calls go through osa() which enforces a hard timeout so an
//    unattended run can never hang forever on a modal dialog.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const execFileP = promisify(execFile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run an AppleScript via `osascript -e` with a hard timeout.
 * Exported standalone so tooling (scripts/probe-ax.js) can reuse it.
 * @param {string} script AppleScript source
 * @param {{timeoutMs?: number}} opts
 * @returns {Promise<string>} trimmed stdout
 */
export async function osa(script, { timeoutMs = 15000 } = {}) {
  try {
    const { stdout } = await execFileP('osascript', ['-e', script], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    return (typeof stdout === 'string' ? stdout : '').trim();
  } catch (err) {
    // execFile marks timeouts with .killed === true (and signal SIGKILL).
    if (err && (err.killed || err.signal === 'SIGKILL')) {
      throw new Error(
        `osascript timeout after ${timeoutMs}ms — LINE 可能被對話框或彈窗擋住，` +
          `或畫面卡住。請確認 LINE 主視窗可正常操作後再試。`
      );
    }
    // Surface stderr (AppleScript error text) when present.
    const stderr = (err && err.stderr ? String(err.stderr) : '').trim();
    const msg = stderr || (err && err.message) || String(err);
    throw new Error(msg);
  }
}

function resolveCliclickPath() {
  const envPath = process.env.CLICLICK_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  const pathEnv = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`;
  try {
    const p = execSync('which cliclick', {
      encoding: 'utf8',
      env: { ...process.env, PATH: pathEnv },
    })
      .trim()
      .split('\n')[0];
    if (p && fs.existsSync(p)) return p;
  } catch {
    // fall through
  }
  for (const c of ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick']) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    'cliclick not found. Install with: brew install cliclick, or set CLICLICK_PATH to the binary.'
  );
}

// Unit / record / group separators used to marshal AppleScript output back to JS.
const US = String.fromCharCode(31); // between text fragments of one cell
const RS = String.fromCharCode(30); // between cells
const GS = String.fromCharCode(29); // between the "which candidate" header and the payload

/**
 * AX candidate paths. We cannot see the real LINE AX tree without an open
 * window + granted permission, so every locate step tries a small ordered list
 * of plausible element paths and uses the first that exists. The winning label
 * is reported back so calibration (via scripts/probe-ax.js) only needs to edit
 * these lists — never the control flow.
 *
 * All expressions are relative to `window 1` inside `tell process "LINE"`.
 */
const CHATLIST_CANDIDATES = [
  { label: 'list/split', expr: 'list 1 of splitter group 1 of window 1' },
  { label: 'outline/scroll/split', expr: 'outline 1 of scroll area 1 of splitter group 1 of window 1' },
  { label: 'table/scroll/split', expr: 'table 1 of scroll area 1 of splitter group 1 of window 1' },
  { label: 'list/group/split', expr: 'list 1 of group 1 of splitter group 1 of window 1' },
];

const MSGAREA_CANDIDATES = [
  { label: 'list/split/split', expr: 'list 1 of splitter group 1 of splitter group 1 of window 1' },
  { label: 'scroll/split/split', expr: 'scroll area 1 of splitter group 1 of splitter group 1 of window 1' },
  { label: 'table/scroll/split/split', expr: 'table 1 of scroll area 1 of splitter group 1 of splitter group 1 of window 1' },
  { label: 'list/split2', expr: 'list 1 of splitter group 2 of window 1' },
];

const HEADER_CANDIDATES = [
  { label: 'statictext/split/split', expr: 'value of static text 1 of splitter group 1 of splitter group 1 of window 1' },
  { label: 'statictext/group/split/split', expr: 'value of static text 1 of group 1 of splitter group 1 of splitter group 1 of window 1' },
  { label: 'wintitle', expr: 'title of window 1' },
];

/** Emit an AppleScript cascade that sets `varName` to the first candidate whose
 * `testTemplate(expr)` evaluates without error, recording the label in `whichVar`. */
function cascadeAS(varName, whichVar, candidates, testTemplate) {
  let s = `set ${varName} to missing value\nset ${whichVar} to ""\n`;
  for (const c of candidates) {
    const test = testTemplate(c.expr);
    s += `if ${varName} is missing value then\n`;
    s += `  try\n`;
    s += `    set probeVal to (${test})\n`;
    s += `    set ${varName} to (${c.expr})\n`;
    s += `    set ${whichVar} to "${c.label}"\n`;
    s += `  end try\n`;
    s += `end if\n`;
  }
  return s;
}

// AppleScript handler: recursively collect static-text values + descriptions of
// a UI element, depth-bounded. Defined at script top level; call via `my`.
const COLLECT_TEXTS_HANDLER = `
on collectTexts(el, depthLeft)
  set outList to {}
  if depthLeft is less than or equal to 0 then return outList
  tell application "System Events"
    try
      set v to value of el
      if v is not missing value then
        set vt to (v as text)
        if vt is not "" then set end of outList to vt
      end if
    end try
    try
      set d to description of el
      if d is not missing value then
        set dt to (d as text)
        if dt is not "" then set end of outList to dt
      end if
    end try
    try
      set kids to UI elements of el
    on error
      set kids to {}
    end try
  end tell
  repeat with k in kids
    set outList to outList & (my collectTexts(k, depthLeft - 1))
  end repeat
  return outList
end collectTexts
`;

export class MacOSLineAutomation {
  constructor() {
    this.lineAppName = 'LINE';
    this.lineProcessName = 'LINE';
    this.delayShort = 0.15; // 秒
    this.delayMid = 0.35;
    this.delayLong = 3;
    // cliclick only needed on the SEND path; resolve lazily so read-only /
    // scheduled read use never requires it to be installed.
    this._cliclickPath = null;
  }

  get cliclickPath() {
    if (!this._cliclickPath) this._cliclickPath = resolveCliclickPath();
    return this._cliclickPath;
  }

  /** AppleScript：以 quoted form 安全呼叫 cliclick（cxVar/cyVar 為 AppleScript 變數名） */
  cliclickShellClick(cxVar, cyVar) {
    return `do shell script (quoted form of "${this.appleEsc(this.cliclickPath)}") & " c:" & ${cxVar} & "," & ${cyVar}`;
  }

  // -------- 小工具 --------
  appleEsc(s = '') {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  async osa(script, opts) {
    return osa(script, opts);
  }

  async hasAccessibilityPermission() {
    const script = `
      tell application "System Events"
        return UI elements enabled
      end tell
    `;
    try {
      const r = await osa(script, { timeoutMs: 5000 });
      return String(r) === 'true';
    } catch {
      return false;
    }
  }

  // -------- 基礎控制 --------
  async isLineRunning() {
    try {
      const script = `
        tell application "System Events"
          return (name of processes) contains "${this.appleEsc(this.lineProcessName)}"
        end tell
      `;
      const result = await osa(script, { timeoutMs: 5000 });
      return result === 'true';
    } catch {
      return false;
    }
  }

  /**
   * P2 preflight (read path). Non-hijacking. Distinguishes:
   *  - LINE process not running
   *  - LINE running but no window (minimized / closed to menu bar)
   * Throws a specific, actionable error; returns {ok:true} otherwise.
   */
  async preflight() {
    const script = `
      tell application "System Events"
        if not ((name of processes) contains "${this.appleEsc(this.lineProcessName)}") then
          return "NOPROC"
        end if
        tell process "${this.appleEsc(this.lineProcessName)}"
          if (count of windows) is 0 then return "NOWIN"
        end tell
      end tell
      return "READY"
    `;
    const r = await osa(script, { timeoutMs: 8000 });
    if (r === 'NOPROC') {
      throw new Error('LINE 未啟動：請先開啟 LINE Desktop 應用程式再重試。');
    }
    if (r === 'NOWIN') {
      throw new Error(
        'LINE 視窗不存在（可能被最小化或關到選單列）：AX 讀取需要一個開啟的 LINE 主視窗。' +
          '排程無人值守讀取時，請保持 LINE 主視窗開啟（可放到背景，不需在最前景）。'
      );
    }
    if (r !== 'READY') {
      throw new Error(`LINE preflight 非預期結果：${r}`);
    }
    return { ok: true };
  }

  /**
   * P4 cold-start readiness poll. Waits for LINE process + window up to
   * timeoutMs, polling instead of a fixed sleep. Throws a distinct message per
   * failure mode.
   */
  async ensureReady(timeoutMs = 15000) {
    const start = Date.now();
    let last = '';
    // Fast path first, then poll.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.preflight();
        return { ok: true };
      } catch (e) {
        last = e?.message || String(e);
      }
      if (Date.now() - start >= timeoutMs) break;
      await sleep(500);
    }
    throw new Error(`LINE 未就緒（等待 ${timeoutMs}ms 後仍失敗）：${last}`);
  }

  // -------- 啟動 LINE（僅 SEND 路徑使用；READ 路徑禁止 activate）--------
  async activateLine() {
    const script = `
      tell application "${this.appleEsc(this.lineAppName)}"
        activate
      end tell
      tell application "System Events"
          repeat with i from 1 to 6
              if frontmost of process "${this.appleEsc(this.lineAppName)}" is true then
                  exit repeat
              else
                  delay 0.5
                  tell application "${this.appleEsc(this.lineAppName)}" to activate
              end if
          end repeat
          if frontmost of process "${this.appleEsc(this.lineAppName)}" is false then
              error "無法將 LINE 置於前景。"
          end if
      end tell
    `;
    try {
      await osa(script, { timeoutMs: 12000 });
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  // -------- P2 選聊天室（AX-first, 非 hijacking）--------
  /**
   * Select a chat by name using only the AX tree:
   *  - locate the chat list (candidate cascade),
   *  - enumerate rows, match chatName against each row's texts,
   *  - AXPress the matching row (System Events `perform action "AXPress"` /
   *    `set selected`, none of which move the cursor),
   *  - scroll (AXScrollToVisible) up to maxScroll rounds to reveal more rows,
   *  - verify the opened chat's header relates to chatName.
   * @returns {Promise<{matched:boolean, which:string, verified:('match'|'mismatch'|'unknown'), matchedText:string, header:string, seen:string[]}>}
   */
  async selectChatAX(chatName, { maxScroll = 20 } = {}) {
    const name = this.appleEsc(chatName);
    const listCascade = cascadeAS('chatList', 'whichList', CHATLIST_CANDIDATES, (e) => `count of rows of (${e})`);
    const headerCascade = cascadeAS('hdr', 'whichHeader', HEADER_CANDIDATES, (e) => e);

    const script = `
${COLLECT_TEXTS_HANDLER}
set US to (character id 31)
set RS to (character id 30)
set GS to (character id 29)
set targetName to "${name}"
tell application "System Events"
  if not ((name of processes) contains "${this.appleEsc(this.lineProcessName)}") then error "NOPROC"
  tell process "${this.appleEsc(this.lineProcessName)}"
    if (count of windows) is 0 then error "NOWIN"
    ${listCascade}
    if chatList is missing value then error "CHATLIST_NOT_FOUND"

    set matched to false
    set matchedText to ""
    set seenList to {}
    set prevSig to ""
    set roundN to 0
    repeat while (roundN is less than ${maxScroll}) and (matched is false)
      set roundN to roundN + 1
      set theRows to rows of chatList
      set sig to (count of theRows) as text
      repeat with r in theRows
        set frags to my collectTexts(r, 4)
        set rowText to ""
        repeat with f in frags
          set rowText to rowText & (f as text) & " "
        end repeat
        set sig to sig & "|" & rowText
        if rowText contains targetName then
          -- non-hijacking press: try AX actions in order
          set didPress to false
          try
            perform action "AXPress" of r
            set didPress to true
          end try
          if didPress is false then
            try
              set selected of r to true
              set didPress to true
            end try
          end if
          if didPress is false then
            try
              perform action "AXOpen" of r
              set didPress to true
            end try
          end if
          set matched to true
          set matchedText to rowText
          exit repeat
        else
          if (count of seenList) is less than 10 then
            set nm to ""
            if (count of frags) is greater than 0 then set nm to (item 1 of frags) as text
            if nm is not "" then set end of seenList to nm
          end if
        end if
      end repeat
      if matched is false then
        -- reached the end if the visible set didn't change after scrolling
        if sig is prevSig then exit repeat
        set prevSig to sig
        try
          set lastRow to last item of theRows
          perform action "AXScrollToVisible" of lastRow
        end try
        delay ${this.delayShort}
      end if
    end repeat

    -- verification: read the opened chat header
    set hdr to missing value
    set whichHeader to ""
    ${headerCascade}
    set headerText to ""
    if hdr is not missing value then set headerText to (hdr as text)

    set seenStr to ""
    repeat with s in seenList
      set seenStr to seenStr & (s as text) & US
    end repeat

    return (matched as text) & GS & whichList & GS & matchedText & GS & headerText & GS & whichHeader & GS & seenStr
  end tell
end tell
`;

    let raw;
    try {
      raw = await osa(script, { timeoutMs: 30000 });
    } catch (e) {
      const m = e?.message || String(e);
      if (m.includes('NOPROC')) throw new Error('LINE 未啟動：請先開啟 LINE Desktop。');
      if (m.includes('NOWIN')) throw new Error('LINE 視窗不存在（可能最小化）：請開啟 LINE 主視窗。');
      if (m.includes('CHATLIST_NOT_FOUND')) {
        throw new Error('找不到聊天列表（AX 候選路徑皆未命中）：可能 LINE 版面改版，請跑 scripts/probe-ax.js 重新校準候選路徑。');
      }
      throw e;
    }

    const [matchedStr = 'false', whichList = '', matchedText = '', headerText = '', whichHeader = '', seenStr = ''] =
      raw.split(GS);
    const matched = matchedStr === 'true';
    const seen = seenStr.split(US).map((s) => s.trim()).filter(Boolean);

    let verified = 'unknown';
    if (matched && headerText) {
      if (headerText.includes(chatName) || chatName.includes(headerText)) verified = 'match';
      else verified = 'mismatch';
    }

    return {
      matched,
      which: whichList,
      verified,
      matchedText: matchedText.trim(),
      header: headerText.trim(),
      whichHeader,
      seen,
    };
  }

  // -------- P2 讀訊息（AX-first, 非 hijacking, 結構化）--------
  /**
   * Read the currently-open chat's messages from the AX tree.
   * @param {{limit?:number, maxScrollUp?:number}} opts
   * @returns {Promise<{order:string, which:string, messages:Array<{sender:string|null,time:string|null,text:string,raw:string[]}>}>}
   */
  async readMessagesAX({ limit = 100, maxScrollUp = 0 } = {}) {
    const areaCascade = cascadeAS('msgArea', 'whichArea', MSGAREA_CANDIDATES, (e) => `(${e})`);

    const script = `
${COLLECT_TEXTS_HANDLER}
set US to (character id 31)
set RS to (character id 30)
set GS to (character id 29)
tell application "System Events"
  if not ((name of processes) contains "${this.appleEsc(this.lineProcessName)}") then error "NOPROC"
  tell process "${this.appleEsc(this.lineProcessName)}"
    if (count of windows) is 0 then error "NOWIN"
    ${areaCascade}
    if msgArea is missing value then error "MSGAREA_NOT_FOUND"

    -- optionally scroll up to lazily load older messages (AX action, no keystroke)
    repeat ${Math.max(0, Math.floor(maxScrollUp))} times
      try
        set cellsTmp to rows of msgArea
        if (count of cellsTmp) is 0 then set cellsTmp to UI elements of msgArea
        if (count of cellsTmp) is greater than 0 then
          perform action "AXScrollToVisible" of (item 1 of cellsTmp)
        end if
      end try
      delay ${this.delayShort}
    end repeat

    set cells to {}
    try
      set cells to rows of msgArea
    end try
    if (count of cells) is 0 then
      try
        set cells to UI elements of msgArea
      end try
    end if

    set n to (count of cells)
    set startIdx to 1
    if n is greater than ${Math.max(1, Math.floor(limit))} then set startIdx to n - ${Math.max(1, Math.floor(limit))} + 1

    set outStr to ""
    repeat with i from startIdx to n
      set c to item i of cells
      set frags to my collectTexts(c, 6)
      set lineStr to ""
      repeat with f in frags
        set lineStr to lineStr & (f as text) & US
      end repeat
      if lineStr is not "" then set outStr to outStr & lineStr & RS
    end repeat
    return whichArea & GS & outStr
  end tell
end tell
`;

    let raw;
    try {
      raw = await osa(script, { timeoutMs: 40000 });
    } catch (e) {
      const m = e?.message || String(e);
      if (m.includes('NOPROC')) throw new Error('LINE 未啟動：請先開啟 LINE Desktop。');
      if (m.includes('NOWIN')) throw new Error('LINE 視窗不存在（可能最小化）：請開啟 LINE 主視窗。');
      if (m.includes('MSGAREA_NOT_FOUND')) {
        throw new Error('找不到訊息區（AX 候選路徑皆未命中）：可能 LINE 版面改版，請跑 scripts/probe-ax.js --messages 重新校準。');
      }
      throw e;
    }

    const gsIdx = raw.indexOf(GS);
    const whichArea = gsIdx >= 0 ? raw.slice(0, gsIdx) : '';
    const payload = gsIdx >= 0 ? raw.slice(gsIdx + 1) : raw;

    const messages = payload
      .split(RS)
      .map((cell) => cell.split(US).map((s) => s.trim()).filter(Boolean))
      .filter((frags) => frags.length > 0)
      .map((frags) => parseMessageFrags(frags));

    return {
      order: 'top-to-bottom (oldest first)',
      which: whichArea,
      messages,
    };
  }

  // -------- 切換輸入法到英文（SEND 路徑輔助）--------
  async switchToEnglish() {
    const script = `
      tell application "System Events"
        tell application process "TextInputMenuAgent"
          set inputMenu to menu bar item 1 of menu bar 2
          click inputMenu
          tell menu 1 of inputMenu
            if exists menu item "ABC" then
              click menu item "ABC"
            else if exists menu item "美國" then
              click menu item "美國"
            else if exists menu item "英文" then
              click menu item "英文"
            end if
          end tell
        end tell
      end tell
    `;
    try {
      await osa(script, { timeoutMs: 8000 });
    } catch {
      // input-method switching is best-effort; never fail the send on it.
    }
  }

  // -------- P5 發送訊息（SEND 路徑；允許 hijack；貼上前後保存/還原剪貼簿）--------
  async sendMessage(chatName, message, autoSend = false) {
    // Snapshot clipboard so we can restore it after paste-based sending.
    let savedClipboard = null;
    try {
      savedClipboard = await osa('return (the clipboard as text)', { timeoutMs: 5000 });
    } catch {
      savedClipboard = null;
    }

    try {
      // Split the message by @mentions pattern (excludes /@)
      const messageParts = [];
      let currentPart = '';
      const parts = message.split(/((?<!\/)@\S+\s)/g);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.match(/^(?<!\/)@\S+\s$/)) {
          if (currentPart) {
            messageParts.push(currentPart);
            currentPart = '';
          }
          messageParts.push(part);
        } else {
          currentPart += part;
        }
      }
      if (currentPart) messageParts.push(currentPart);

      let result = await this._sendSingleMessageInit(chatName);

      for (const part of messageParts) {
        if (part.match(/^@\S+\s$/)) {
          result = await this._sendSingleMessage(chatName, ' ');
          result = await this._sendSingleMessage(chatName, part.trim() + 'k');
          result = await this._sendSingleMessageBackspace();
          result = await this._sendSingleMessageClickMention();
        } else {
          result = await this._sendSingleMessage(chatName, part);
        }
      }

      if (autoSend) {
        result = await this._sendSingleMessageEnter();
      }

      if (result.success) return { success: true, error: null };
      return { success: false, error: result.error };
    } finally {
      if (savedClipboard !== null) {
        try {
          await osa(`set the clipboard to "${this.appleEsc(savedClipboard)}"`, { timeoutMs: 5000 });
        } catch {
          // best-effort restore
        }
      }
    }
  }

  async _sendSingleMessageInit(chatName) {
    const script = `
      tell application "System Events"
        tell process "${this.appleEsc(this.lineProcessName)}"
          set theRow to text area 1 of splitter group 1 of splitter group 1 of window 1
          set {xPosition, yPosition} to position of theRow
          set {xSize, ySize} to size of theRow
          set cx to xPosition + (xSize div 2)
          set cy to yPosition + (ySize div 2)
          ${this.cliclickShellClick('cx', 'cy')}
          delay ${this.delayShort}
          key down command
          keystroke "a"
          key up command
          delay ${this.delayShort}
        end tell
      end tell
      return true
    `;
    try {
      const r = await osa(script, { timeoutMs: 12000 });
      return { success: r === 'true', error: r === 'true' ? null : 'Failed to send message' };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  async _sendSingleMessage(chatName, message) {
    const script = `
      tell application "System Events"
        tell process "${this.appleEsc(this.lineProcessName)}"
          set the clipboard to "${this.appleEsc(message)}"
          key down command
          keystroke "v"
          key up command
          delay ${this.delayMid}
        end tell
      end tell
      return true
    `;
    try {
      const r = await osa(script, { timeoutMs: 12000 });
      return { success: r === 'true', error: r === 'true' ? null : 'Failed to send message' };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  async _sendSingleMessageEnter() {
    const script = `
      tell application "System Events"
        tell process "${this.appleEsc(this.lineProcessName)}"
          key down return
          delay ${this.delayShort}
          key up return
        end tell
      end tell
      return true
    `;
    try {
      const r = await osa(script, { timeoutMs: 8000 });
      return { success: r === 'true', error: r === 'true' ? null : 'Failed to send message' };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  async _sendSingleMessageBackspace() {
    const script = `
      tell application "System Events"
        tell process "${this.appleEsc(this.lineProcessName)}"
          key code 51
          delay ${this.delayMid}
        end tell
      end tell
      return true
    `;
    try {
      const r = await osa(script, { timeoutMs: 8000 });
      return { success: r === 'true', error: r === 'true' ? null : 'Failed to send message' };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  async _sendSingleMessageClickMention() {
    const script = `
      tell application "System Events"
        tell process "${this.appleEsc(this.lineProcessName)}"
          set theRow to text area 1 of splitter group 1 of splitter group 1 of window 1
          set {xPosition, yPosition} to position of theRow
          set {xSize, ySize} to size of theRow
          set cx to xPosition + (xSize div 4)
          set cy to yPosition - 10
          ${this.cliclickShellClick('cx', 'cy')}
          delay ${this.delayShort}
        end tell
      end tell
      return true
    `;
    try {
      const r = await osa(script, { timeoutMs: 8000 });
      return { success: r === 'true', error: r === 'true' ? null : 'Failed to send message' };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  // -------- P3 校準用：dump AX 子樹（供 scripts/probe-ax.js 使用）--------
  /**
   * Dump the LINE AX tree as indented text lines. If `messagesOnly`, dump only
   * the message-area subtree of the currently open chat.
   * @param {{maxDepth?:number, maxLines?:number, messagesOnly?:boolean}} opts
   * @returns {Promise<string>}
   */
  async dumpAXTree({ maxDepth = 8, maxLines = 500, messagesOnly = false } = {}) {
    const rootExpr = messagesOnly
      ? MSGAREA_CANDIDATES.map((c) => c.expr)
      : ['window 1'];

    // Build a root cascade so --messages can also fall back across candidates.
    const rootCands = rootExpr.map((expr, i) => ({ label: `root${i}`, expr }));
    const rootCascade = cascadeAS('rootEl', 'whichRoot', rootCands, (e) => `(${e})`);

    const script = `
global gLines, gMax, gOut, LF
set US to (character id 31)
set LF to (character id 10)
set gLines to 0
set gMax to ${Math.max(10, Math.floor(maxLines))}
set gOut to ""

on trunc(t)
  set s to ""
  try
    set s to (t as text)
  end try
  if (count of s) > 40 then set s to (text 1 thru 40 of s) & "…"
  return s
end trunc

on dumpEl(el, depth, maxDepth)
  global gLines, gMax, gOut, LF
  if gLines is greater than or equal to gMax then return
  set pad to ""
  repeat depth times
    set pad to pad & "  "
  end repeat
  set roleStr to "?"
  set nameStr to ""
  set valStr to ""
  set kids to {}
  tell application "System Events"
    try
      set roleStr to (role of el) as text
    end try
    try
      if (name of el) is not missing value then set nameStr to (name of el) as text
    end try
    if nameStr is "" then
      try
        if (description of el) is not missing value then set nameStr to (description of el) as text
      end try
    end if
    try
      if (value of el) is not missing value then set valStr to my trunc(value of el)
    end try
    if depth is less than maxDepth then
      try
        set kids to UI elements of el
      end try
    end if
  end tell
  set gOut to gOut & pad & roleStr & " | " & nameStr & " | " & valStr & LF
  set gLines to gLines + 1
  repeat with k in kids
    my dumpEl(k, depth + 1, maxDepth)
  end repeat
end dumpEl

tell application "System Events"
  if not ((name of processes) contains "LINE") then error "NOPROC"
  tell process "LINE"
    if (count of windows) is 0 then error "NOWIN"
    ${rootCascade}
    if rootEl is missing value then error "ROOT_NOT_FOUND"
    my dumpEl(rootEl, 0, ${Math.max(1, Math.floor(maxDepth))})
  end tell
end tell
return gOut
`;
    return osa(script, { timeoutMs: 45000 });
  }
}

/**
 * Best-effort structured parse of one message cell's text fragments.
 * Without a real AX sample we always keep `raw`; sender/time are heuristic.
 */
export function parseMessageFrags(frags) {
  const timeRe = /(上午|下午|AM|PM)?\s*\d{1,2}:\d{2}/;
  let time = null;
  let sender = null;
  const rest = [];

  for (const f of frags) {
    if (!time && timeRe.test(f) && f.length <= 12) {
      time = f;
    } else {
      rest.push(f);
    }
  }

  // Heuristic: with multiple non-time fragments, the first short one is the sender.
  if (rest.length >= 2 && rest[0].length <= 40) {
    sender = rest[0];
    const text = rest.slice(1).join('\n');
    return { sender, time, text, raw: frags };
  }

  return { sender: null, time, text: rest.join('\n'), raw: frags };
}
