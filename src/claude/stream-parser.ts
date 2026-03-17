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
  toolUse?: { name: string; input?: string; toolUseId?: string };
  toolResult?: { toolUseId: string; isError?: boolean };
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
        // task_started = subagent launched (only add once, not on progress)
        if (msg.subtype === 'task_started') {
          result.toolUse = { name: 'Agent' };
        }
        return result;
      }

      // Assistant message: contains text content and/or tool_use blocks
      if (msg.type === 'assistant') {
        const text = this.extractText(msg.message?.content);
        const toolUse = this.extractToolUse(msg.message?.content);
        const toolResult = this.extractToolResult(msg.message?.content);
        const result: ParseResult = {};
        if (text) {
          this._fullText += text;
          result.text = text;
        }
        if (toolUse) {
          result.toolUse = toolUse;
        }
        if (toolResult) {
          result.toolResult = toolResult;
        }
        return result;
      }

      // User message: contains tool_result blocks (after tool execution completes)
      if (msg.type === 'user') {
        const toolResult = this.extractToolResult(msg.message?.content);
        if (toolResult) {
          return { toolResult };
        }
        return {};
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
          // Only use result text if nothing was accumulated during streaming.
          // In multi-turn (agentic) responses, _fullText has the complete output
          // while msg.result may only contain the last turn's summary.
          if (!this._fullText) {
            this._fullText = msg.result;
          }
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

  private extractToolUse(content: unknown): { name: string; input?: string; toolUseId?: string } | undefined {
    if (!Array.isArray(content)) return undefined;
    for (const block of content) {
      if (block.type === 'tool_use' && block.name) {
        let input: string | undefined;
        if (typeof block.input === 'string') {
          input = block.input;
        } else if (block.input && typeof block.input === 'object') {
          // Stringify object inputs for display (e.g. { command: "git status" } → "git status")
          const vals = Object.values(block.input as Record<string, unknown>);
          input = vals.filter(v => typeof v === 'string').join(' ').slice(0, 200);
        }
        return { name: block.name, input, toolUseId: block.id };
      }
    }
    return undefined;
  }

  private extractToolResult(content: unknown): { toolUseId: string; isError?: boolean } | undefined {
    if (!Array.isArray(content)) return undefined;
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        return { toolUseId: block.tool_use_id, isError: block.is_error };
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
