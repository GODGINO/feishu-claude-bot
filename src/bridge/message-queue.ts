import type { IncomingMessage } from '../feishu/event-handler.js';
import type { ImageAttachment } from '../claude/runner.js';
import type { Logger } from '../utils/logger.js';

/**
 * Job — a per-session unit of work that spawns Claude (or otherwise
 * holds the ProcessPool slot). Routed through the FIFO queue so two
 * Claude tasks for the same session never run concurrently.
 *
 * Pure broadcasts (IDLE email push, Alert message_only, agent
 * unsolicited results, admin-as-sigma) are intentionally NOT modeled
 * as Jobs — they are <200ms sender API calls and must reach the user
 * immediately, so they bypass the queue.
 */
export type Job =
  | { kind: 'claude-user-msg';   sessionKey: string; msg: IncomingMessage }
  | { kind: 'claude-button';     sessionKey: string; chatId: string; actionId: string; label: string; userName: string; operatorId: string; cardId?: string; messageId?: string }
  | { kind: 'claude-cron';       sessionKey: string; chatId: string; prompt: string; jobName: string }
  | { kind: 'claude-alert';      sessionKey: string; chatId: string; prompt: string; alertName: string }
  | { kind: 'claude-wechat';     sessionKey: string; chatId: string; prompt: string; images?: ImageAttachment[] }
  | { kind: 'claude-admin-chat'; sessionKey: string; chatId: string; text: string; echo: boolean; showSource: boolean };

/**
 * Per-session FIFO Job queue with capacity limit.
 */
export class MessageQueue {
  private queues = new Map<string, Job[]>();

  constructor(
    private maxQueuePerSession: number,
    private logger: Logger,
  ) {}

  /**
   * Try to enqueue a job. Returns false if queue is full.
   */
  enqueue(sessionKey: string, job: Job): boolean {
    let queue = this.queues.get(sessionKey);
    if (!queue) {
      queue = [];
      this.queues.set(sessionKey, queue);
    }

    if (queue.length >= this.maxQueuePerSession) {
      this.logger.warn({ sessionKey, queueSize: queue.length, kind: job.kind }, 'Job queue full');
      return false;
    }

    queue.push(job);
    this.logger.debug({ sessionKey, queueSize: queue.length, kind: job.kind }, 'Job queued');
    return true;
  }

  /**
   * Dequeue the next job for a session.
   */
  dequeue(sessionKey: string): Job | undefined {
    const queue = this.queues.get(sessionKey);
    if (!queue || queue.length === 0) return undefined;

    const job = queue.shift()!;
    if (queue.length === 0) {
      this.queues.delete(sessionKey);
    }
    return job;
  }

  hasQueued(sessionKey: string): boolean {
    const queue = this.queues.get(sessionKey);
    return !!queue && queue.length > 0;
  }

  queueSize(sessionKey: string): number {
    return this.queues.get(sessionKey)?.length || 0;
  }

  clear(sessionKey: string): void {
    this.queues.delete(sessionKey);
  }
}
