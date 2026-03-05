/**
 * Parses stream-json output from `claude -p --output-format stream-json`.
 * Each line is a JSON object with a `type` field.
 */

export interface ParseResult {
  text?: string;
  sessionId?: string;
  done?: boolean;
  costUsd?: number;
  durationMs?: number;
  error?: string;
  toolUse?: { name: string; input?: string };
}

export class StreamParser {
  private _sessionId: string | undefined;
  private _fullText = '';

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get fullText(): string {
    return this._fullText;
  }

  /**
   * Reset parser state for a new conversation turn (persistent process reuse).
   */
  reset(): void {
    this._fullText = '';
    // Keep _sessionId — it stays the same for the lifetime of the process
  }

  parseLine(line: string): ParseResult {
    if (!line.trim()) return {};

    try {
      const msg = JSON.parse(line);

      // System message: extract session_id and detect subagent progress
      if (msg.type === 'system') {
        const result: ParseResult = {};
        if (msg.session_id && !this._sessionId) {
          this._sessionId = msg.session_id;
          result.sessionId = msg.session_id;
        }
        // task_started/task_progress = subagent is running
        if (msg.subtype === 'task_started' || msg.subtype === 'task_progress') {
          result.toolUse = { name: 'Agent' };
        }
        return result;
      }

      // Assistant message: contains text content and/or tool_use blocks
      if (msg.type === 'assistant') {
        const text = this.extractText(msg.message?.content);
        const toolUse = this.extractToolUse(msg.message?.content);
        const result: ParseResult = {};
        if (text) {
          this._fullText += text;
          result.text = text;
        }
        if (toolUse) {
          result.toolUse = toolUse;
        }
        return result;
      }

      // Result message: final output
      if (msg.type === 'result') {
        const result: ParseResult = { done: true };
        if (msg.session_id && !this._sessionId) {
          this._sessionId = msg.session_id;
          result.sessionId = msg.session_id;
        }
        if (msg.result) {
          result.text = msg.result;
          this._fullText = msg.result; // result contains the complete text
        }
        if (msg.total_cost_usd != null) result.costUsd = msg.total_cost_usd;
        if (msg.duration_ms != null) result.durationMs = msg.duration_ms;
        if (msg.is_error) result.error = msg.result || 'Unknown error';
        return result;
      }

      return {};
    } catch {
      // Non-JSON line, ignore
      return {};
    }
  }

  private extractToolUse(content: unknown): { name: string; input?: string } | undefined {
    if (!Array.isArray(content)) return undefined;
    for (const block of content) {
      if (block.type === 'tool_use' && block.name) {
        return { name: block.name, input: typeof block.input === 'string' ? block.input : undefined };
      }
    }
    return undefined;
  }

  private extractText(content: unknown): string {
    if (!content) return '';

    // content can be a string or array of content blocks
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        }
      }
      return parts.join('');
    }

    return '';
  }
}
