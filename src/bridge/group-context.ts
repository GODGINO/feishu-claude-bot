import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

const MAX_ENTRIES = 100;
const CONTEXT_FILE = 'group-context.json';

export interface ContextEntry {
  timestamp: number;
  senderName: string;
  text: string;
  botReply?: string;
}

export class GroupContextBuffer {
  private buffers = new Map<string, ContextEntry[]>();

  constructor(private logger: Logger) {}

  /**
   * Add a message entry to the buffer. Evicts oldest entries beyond MAX_ENTRIES.
   */
  add(chatId: string, entry: ContextEntry): void {
    let entries = this.buffers.get(chatId);
    if (!entries) {
      entries = [];
      this.buffers.set(chatId, entries);
    }
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      entries.splice(0, entries.length - MAX_ENTRIES);
    }
  }

  /**
   * Format the buffer as a readable context string for prompt injection.
   */
  format(chatId: string): string {
    const entries = this.buffers.get(chatId);
    if (!entries || entries.length === 0) return '';

    const lines: string[] = ['[最近群聊消息]'];
    let lastDateStr = '';
    for (const e of entries) {
      const d = new Date(e.timestamp);
      const dateStr = d.toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        timeZone: 'Asia/Shanghai',
      });
      // Insert date header when day changes
      if (dateStr !== lastDateStr) {
        lines.push(`--- ${dateStr} ---`);
        lastDateStr = dateStr;
      }
      const time = d.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
      });
      lines.push(`[${time}] ${e.senderName}: ${e.text}`);
      if (e.botReply) {
        lines.push(`[${time}] Sigma: ${e.botReply}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Load buffer from group-context.json in the session directory.
   */
  load(sessionDir: string, chatId: string): void {
    try {
      const filePath = path.join(sessionDir, CONTEXT_FILE);
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const entries = JSON.parse(raw) as ContextEntry[];
      if (Array.isArray(entries)) {
        this.buffers.set(chatId, entries.slice(-MAX_ENTRIES));
      }
    } catch (err) {
      this.logger.warn({ err, sessionDir }, 'Failed to load group context');
    }
  }

  /**
   * Persist buffer to group-context.json in the session directory.
   */
  save(sessionDir: string, chatId: string): void {
    try {
      const entries = this.buffers.get(chatId);
      if (!entries) return;
      const filePath = path.join(sessionDir, CONTEXT_FILE);
      fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
    } catch (err) {
      this.logger.warn({ err, sessionDir }, 'Failed to save group context');
    }
  }
}
