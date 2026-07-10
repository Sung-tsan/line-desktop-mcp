import fs from 'fs';
import path from 'path';
import { MacOSLineAutomation } from './macos-line-automation.js';
import { WindowsLineAutomation } from './windows-line-automation.js';

export class LineAutomation {
  constructor() {
    this.platform = process.platform;

    if (this.platform === 'darwin') {
      this.automation = new MacOSLineAutomation();
    } else if (this.platform === 'win32') {
      this.automation = new WindowsLineAutomation();
    } else {
      throw new Error(`Unsupported platform: ${this.platform}`);
    }
  }

  async switchToEnglish() {
    return await this.automation.switchToEnglish();
  }

  async selectChat(chatName) {
    // Back-compat boolean wrapper over the AX-first selector.
    const r = await this.automation.selectChatAX(chatName);
    return !!r.matched;
  }

  async isLineRunning() {
    return await this.automation.isLineRunning();
  }

  async activateLine() {
    return await this.automation.activateLine();
  }

  /**
   * P2/P4 read path — NON-HIJACKING and structured.
   * Never activates LINE, never uses cliclick / keystroke / clipboard.
   * Returns a structured object (not a clipboard blob).
   *
   * @param {string} chatName
   * @param {string} date
   * @param {number} messageLimit  max messages to return
   * @param {number} scanDepth     how many AX scroll-up rounds to lazily load older messages
   */
  async getChatHistory(chatName, date, messageLimit = 100, scanDepth = 0) {
    if (this.platform !== 'darwin') {
      // Windows path unchanged; delegate to its own implementation if present.
      return await this.automation.getChatHistory(chatName, date, messageLimit, scanDepth);
    }

    // 1) Cold-start / readiness: poll process + window (distinct errors), no activate.
    await this.automation.ensureReady(15000);

    // 2) Select the target chat via AX (throws with a helpful "seen list" when absent).
    const sel = await this.automation.selectChatAX(chatName);
    if (!sel.matched) {
      const seen = sel.seen && sel.seen.length ? sel.seen.slice(0, 10).join(', ') : '（無法讀取任何列表項）';
      throw new Error(
        `聊天室「${chatName}」不在列表中。目前列表可見的前 10 項：${seen}。` +
          `請確認名稱完全正確，或該聊天室是否已捲動到可見範圍。`
      );
    }
    if (sel.verified === 'mismatch') {
      throw new Error(
        `選取驗證失敗：點開後的聊天室標題為「${sel.header}」，與要求的「${chatName}」不符，中止以免讀到錯誤內容。`
      );
    }

    // 3) Read messages structurally.
    const result = await this.automation.readMessagesAX({ limit: messageLimit, maxScrollUp: scanDepth });

    const payload = {
      chatName,
      date,
      order: result.order,
      verified: sel.verified, // 'match' | 'unknown'
      matchedVia: sel.which,
      messageAreaVia: result.which,
      messageCount: result.messages.length,
      messages: result.messages,
    };

    if (process.env.CHAT_LOG_ON === 'true') {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeChatName = chatName.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_');
        const fileName = `${safeChatName}_${timestamp}.json`;
        const logDir = process.env.CHAT_LOG_PATH || path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logFilePath = path.join(logDir, fileName);
        fs.writeFileSync(logFilePath, JSON.stringify(payload, null, 2));
        console.error(`Chat history saved to ${logFilePath}`);
      } catch (error) {
        console.error('Failed to write chat history to log file:', error);
      }
    }

    return payload;
  }

  /**
   * SEND path. Hijacking is acceptable here (the user is actively asking to
   * send), but selection is done via AX and the clipboard is restored after paste.
   */
  async sendChatMessage(chatName, message, autoSend = false) {
    if (this.platform !== 'darwin') {
      await this.automation.switchToEnglish();
      await this.automation.activateLine();
      const ok = await this.automation.selectChat(chatName);
      if (!ok) throw new Error(`Chat "${chatName}" not found`);
      return await this.automation.sendMessage(chatName, message, autoSend);
    }

    // Readiness + non-hijacking AX select first, so we fail cleanly before touching input.
    await this.automation.ensureReady(15000);
    const sel = await this.automation.selectChatAX(chatName);
    if (!sel.matched) {
      const seen = sel.seen && sel.seen.length ? sel.seen.slice(0, 10).join(', ') : '（無法讀取任何列表項）';
      throw new Error(`聊天室「${chatName}」不在列表中，無法發送。列表可見前 10 項：${seen}`);
    }
    if (sel.verified === 'mismatch') {
      throw new Error(`發送中止：目前開啟的聊天室「${sel.header}」與目標「${chatName}」不符。`);
    }

    // Now hijack to type: bring LINE forward, normalize input method, paste.
    await this.automation.switchToEnglish();
    const act = await this.automation.activateLine();
    if (!act.success) {
      throw new Error(`無法將 LINE 置於前景以發送訊息：${act.error}`);
    }
    return await this.automation.sendMessage(chatName, message, autoSend);
  }

  async getChatList(includeGroups = true, includeIndividual = true) {
    return await this.automation.getChatList(includeGroups, includeIndividual);
  }
}
