import type { IncomingMessage } from '../feishu/event-handler.js';
import type { ImageAttachment } from '../claude/runner.js';
import type { Logger } from '../utils/logger.js';

/**
 * Job — every per-session unit of outbound work that must be serialized
 * within a single sessionKey. Two families:
 *   - claude-* : spawns Claude (consumes ProcessPool slot, may run minutes)
 *   - broadcast: pure sender API call (no Claude, ~200ms)
 * Both families share the same FIFO queue and runningTasks lock so
 * messages reach the user in strict chronological order.
 */
export type Job =
  | { kind: 'claude-user-msg';   sessionKey: string; msg: IncomingMessage }
  | { kind: 'claude-button';     sessionKey: string; chatId: string; actionId: string; label: string; userName: string; operatorId: string; cardId?: string; messageId?: string }
  | { kind: 'claude-cron';       sessionKey: string; chatId: string; prompt: string; jobName: string }
  | { kind: 'claude-alert';      sessionKey: string; chatId: string; prompt: string; alertName: string }
  | { kind: 'claude-wechat';     sessionKey: string; chatId: string; prompt: string; images?: ImageAttachment[] }
  | { kind: 'claude-admin-chat'; sessionKey: string; chatId: string; text: string; echo: boolean; showSource: boolean }
  | { kind: 'broadcast';         sessionKey: string; chatId: string; text: string; subType: 'idle-email' | 'alert-msg' | 'agent-result' | 'admin-as-sigma'; replyToMessageId?: string; sessionDir?: string };

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
