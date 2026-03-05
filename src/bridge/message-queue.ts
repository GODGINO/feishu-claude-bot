import type { IncomingMessage } from '../feishu/event-handler.js';
import type { Logger } from '../utils/logger.js';

export interface QueuedMessage {
  msg: IncomingMessage;
  sessionKey: string;
}

/**
 * Per-session message queue with global concurrency control.
 */
export class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();

  constructor(
    private maxQueuePerSession: number,
    private logger: Logger,
  ) {}

  /**
   * Try to enqueue a message. Returns false if queue is full.
   */
  enqueue(sessionKey: string, msg: IncomingMessage): boolean {
    let queue = this.queues.get(sessionKey);
    if (!queue) {
      queue = [];
      this.queues.set(sessionKey, queue);
    }

    if (queue.length >= this.maxQueuePerSession) {
      this.logger.warn({ sessionKey, queueSize: queue.length }, 'Message queue full');
      return false;
    }

    queue.push({ msg, sessionKey });
    this.logger.debug({ sessionKey, queueSize: queue.length }, 'Message queued');
    return true;
  }

  /**
   * Dequeue the next message for a session.
   */
  dequeue(sessionKey: string): QueuedMessage | undefined {
    const queue = this.queues.get(sessionKey);
    if (!queue || queue.length === 0) return undefined;

    const item = queue.shift()!;
    if (queue.length === 0) {
      this.queues.delete(sessionKey);
    }
    return item;
  }

  /**
   * Check if there are queued messages for a session.
   */
  hasQueued(sessionKey: string): boolean {
    const queue = this.queues.get(sessionKey);
    return !!queue && queue.length > 0;
  }

  /**
   * Get queue size for a session.
   */
  queueSize(sessionKey: string): number {
    return this.queues.get(sessionKey)?.length || 0;
  }

  /**
   * Clear queue for a session (e.g., on /stop).
   */
  clear(sessionKey: string): void {
    this.queues.delete(sessionKey);
  }
}
