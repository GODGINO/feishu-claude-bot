import type { Logger } from '../utils/logger.js';
import type { Config } from '../config.js';
import { ProcessPool, type SendOptions, type UnsolicitedResultCallback, type ProgressCallback } from './process-pool.js';

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

      return result;
    } catch (err: any) {
      // "busy" means another message is already being processed — do NOT reset (would kill it)
      if (err.message?.includes('is busy')) {
        this.logger.warn({ sessionKey: opts.sessionKey }, 'Process busy, not retrying');
        return { fullText: '', error: err.message };
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
