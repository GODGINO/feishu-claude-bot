import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { Config } from '../config.js';
import { ProcessPool, type SendOptions, type UnsolicitedResultCallback, type ProgressCallback, type TextStreamCallback, type ToolStreamCallback } from './process-pool.js';

export interface ImageAttachment {
  base64: string;
  mediaType: string;
}

export interface RunOptions {
  sessionKey: string;
  message: string;
  sessionDir: string;
  sessionId?: string;           // Ignored — ProcessPool manages sessionIds internally
  systemPrompt?: string;        // Ignored — system prompt set once at process spawn
  abortSignal?: AbortSignal;
  images?: ImageAttachment[];
}

export interface RunResult {
  fullText: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  error?: string;
}

export class ClaudeRunner {
  private pool: ProcessPool;

  constructor(
    private config: Config,
    private logger: Logger,
    sessionsDir: string,
  ) {
    this.pool = new ProcessPool(config, sessionsDir, logger);
  }

  /**
   * Send a message to the persistent Claude Code process for a session.
   * The process is spawned on first call and reused for subsequent calls.
   */
  async run(opts: RunOptions): Promise<RunResult> {
    this.logger.info(
      { sessionKey: opts.sessionKey, sessionDir: opts.sessionDir, hasImages: !!opts.images?.length },
      'Sending message to Claude process',
    );

    try {
      const result = await this.pool.send({
        sessionKey: opts.sessionKey,
        sessionDir: opts.sessionDir,
        message: opts.message,
        images: opts.images,
        abortSignal: opts.abortSignal,
      });

      // MCP config changed during the run (e.g. start-chrome.sh added chrome-devtools).
      // Respawn the process (which happens automatically in next send()) and send a
      // continuation message so Claude can use the newly available tools immediately.
      const mcpSignal = path.join(opts.sessionDir, '.mcp-changed');
      if (!result.error && fs.existsSync(mcpSignal)) {
        this.logger.info({ sessionKey: opts.sessionKey }, 'MCP config changed during run, auto-continuing');
        try {
          const continueResult = await this.pool.send({
            sessionKey: opts.sessionKey,
            sessionDir: opts.sessionDir,
            message: '工具已加载，请继续执行之前的操作。',
            abortSignal: opts.abortSignal,
          });
          // Merge: use the continuation's text as the final response
          return continueResult;
        } catch (err: any) {
          this.logger.warn({ err, sessionKey: opts.sessionKey }, 'MCP auto-continue failed');
          // Fall through to return original result
        }
      }

      // "Prompt is too long" — context window full. Compact context and retry.
      if (result.error && /prompt is too long/i.test(result.error)) {
        this.logger.warn({ sessionKey: opts.sessionKey }, 'Prompt too long, compacting context and retrying');
        try {
          // Send /compact to trigger Claude Code's built-in context compression.
          // The process is still alive — /compact is a slash command recognized in stream-json.
          const compactResult = await this.pool.send({
            sessionKey: opts.sessionKey,
            sessionDir: opts.sessionDir,
            message: '/compact',
          });

          // Check if compaction itself failed
          if (compactResult.error) {
            throw new Error(`Compact returned error: ${compactResult.error}`);
          }

          this.logger.info({ sessionKey: opts.sessionKey }, 'Context compacted, retrying original message');
          // Retry original message with compacted context
          const retryResult = await this.pool.send({
            sessionKey: opts.sessionKey,
            sessionDir: opts.sessionDir,
            message: opts.message,
            images: opts.images,
            abortSignal: opts.abortSignal,
          });
          return retryResult;
        } catch (compactErr: any) {
          this.logger.error({ err: compactErr, sessionKey: opts.sessionKey }, 'Compact failed, resetting session');
          // Compaction failed — fall back to full reset (loses context)
          this.pool.reset(opts.sessionKey);
          try {
            const retryResult = await this.pool.send({
              sessionKey: opts.sessionKey,
              sessionDir: opts.sessionDir,
              message: opts.message,
              images: opts.images,
              abortSignal: opts.abortSignal,
            });
            return retryResult;
          } catch (resetErr: any) {
            return { fullText: '', error: resetErr.message || 'Claude process failed after reset' };
          }
        }
      }

      return result;
    } catch (err: any) {
      // "busy" means another message is already being processed — do NOT reset (would kill it)
      if (err.message?.includes('is busy')) {
        this.logger.warn({ sessionKey: opts.sessionKey }, 'Process busy, not retrying');
        return { fullText: '', error: err.message };
      }

      // If aborted via /stop, don't retry — just propagate the error
      if (opts.abortSignal?.aborted) {
        this.logger.info({ sessionKey: opts.sessionKey }, 'Task was aborted, not retrying');
        throw err;
      }

      this.logger.error({ err, sessionKey: opts.sessionKey }, 'Claude process error, retrying with fresh process');

      // On error (process crashed), retry once with a clean start (no --resume)
      this.pool.reset(opts.sessionKey);
      try {
        const result = await this.pool.send({
          sessionKey: opts.sessionKey,
          sessionDir: opts.sessionDir,
          message: opts.message,
          images: opts.images,
          abortSignal: opts.abortSignal,
        });
        return result;
      } catch (retryErr: any) {
        return {
          fullText: '',
          error: retryErr.message || 'Claude process failed',
        };
      }
    }
  }

  /**
   * Abort a specific session's process (/stop command).
   */
  abort(sessionKey: string): void {
    this.pool.abort(sessionKey);
  }

  /**
   * Reset a session (/new command) — kill process and clear sessionId.
   * Next message spawns fresh without --resume = clean context.
   */
  reset(sessionKey: string): void {
    this.pool.reset(sessionKey);
  }

  /**
   * Kill all processes (shutdown).
   */
  killAll(): void {
    this.pool.killAll();
  }

  /**
   * Register callback for unsolicited results (background agent completion).
   * Called when Claude emits output without a pending send() request.
   */
  onUnsolicitedResult(callback: UnsolicitedResultCallback): void {
    this.pool.onUnsolicitedResult(callback);
  }

  /**
   * Register callback for progress events (tool_use in stream).
   */
  onProgress(callback: ProgressCallback): void {
    this.pool.onProgress(callback);
  }

  /**
   * Register/unregister callback for text streaming events (per-session).
   */
  onTextStream(sessionKey: string, callback: TextStreamCallback | undefined): void {
    this.pool.onTextStream(sessionKey, callback);
  }

  /**
   * Register/unregister callback for tool call stream events (per-session).
   */
  onToolStream(sessionKey: string, callback: ToolStreamCallback | undefined): void {
    this.pool.onToolStream(sessionKey, callback);
  }

  /**
   * Get the timestamp of the last stdout activity for a session.
   */
  getLastActivity(sessionKey: string): number {
    return this.pool.getLastActivity(sessionKey);
  }

  /**
   * Number of currently busy processes.
   */
  get activeCount(): number {
    return this.pool.activeCount;
  }
}
