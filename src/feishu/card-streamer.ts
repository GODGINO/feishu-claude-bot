/**
 * CardKit streaming card orchestrator.
 * Manages the lifecycle of a streaming card: create → stream updates → complete.
 * Uses Feishu CardKit v1 SDK methods for card operations.
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import {
  buildThinkingCard,
  buildStreamingCard,
  buildCompleteCard,
  STREAMING_ELEMENT_ID,
  TOOL_CALLS_ELEMENT_ID,
  type ToolCallInfo,
} from './card-builder.js';

const THROTTLE_MS = 500; // Minimum interval between card updates

export class CardStreamer {
  private cardId: string | null = null;
  private messageId: string | null = null;
  private sequence = 0;
  private lastUpdateTime = 0;
  private pendingText = '';
  private toolCalls: ToolCallInfo[] = [];
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private fallback = false;
  private startTime = 0;
  // Deferred IM message send (to detect <<THREAD>> in first text)
  private messageSent = false;
  private deferredChatId = '';
  private deferredReplyToMessageId?: string;
  private deferredExistingRootId?: string;
  private deferredUserMessageId?: string;
  // Track in-flight flush to prevent race with complete()
  private inflightFlush: Promise<void> | null = null;
  private completed = false;

  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  /** Return the current accumulated text (for graceful stop). */
  getCurrentText(): string {
    return this.pendingText;
  }

  /**
   * Create a CardKit card entity and prepare for streaming.
   * The actual IM message is deferred until the first text update (to detect <<THREAD>>).
   *
   * @param existingRootId - root_id from the incoming message (already in a thread)
   * @param userMessageId - the user's message ID (potential thread root if <<THREAD>> requested)
   */
  async start(chatId: string, replyToMessageId?: string, existingRootId?: string, userMessageId?: string): Promise<void> {
    this.startTime = Date.now();
    this.deferredChatId = chatId;
    this.deferredReplyToMessageId = replyToMessageId;
    this.deferredExistingRootId = existingRootId;
    this.deferredUserMessageId = userMessageId;

    try {
      // Step 1: Create card entity via CardKit SDK
      const thinkingCard = buildThinkingCard();
      this.logger.info({ cardJson: JSON.stringify(thinkingCard).slice(0, 500) }, 'CardKit create request');
      const createResp = await (this.client.cardkit as any).v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(thinkingCard),
        },
      });

      this.cardId = createResp?.data?.card_id;
      if (!this.cardId) {
        this.logger.warn({ createResp: JSON.stringify(createResp) }, 'CardKit create returned no card_id, falling back');
        this.fallback = true;
        return;
      }

      this.logger.info({ cardId: this.cardId }, 'CardKit card created');

      // Step 2: Enable streaming mode on the card
      this.sequence++;
      await (this.client.cardkit as any).v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: true }),
          sequence: this.sequence,
        },
      });

      this.logger.info({ cardId: this.cardId }, 'Streaming mode enabled');

      // Step 3 (IM message send) is DEFERRED to ensureMessageSent()
      // This allows us to detect <<THREAD>> in the first text before deciding reply mode.
    } catch (err: any) {
      const respData = err?.response?.data;
      this.logger.warn({
        err: err?.message,
        status: err?.response?.status,
        respData: respData ? JSON.stringify(respData) : undefined,
      }, 'CardKit start failed, falling back to normal reply');
      this.fallback = true;
    }
  }

  /**
   * Send the card as an IM message (deferred from start).
   * Detects <<THREAD>> in text to decide whether to use thread reply.
   */
  private async ensureMessageSent(text?: string): Promise<void> {
    if (this.messageSent || !this.cardId) return;
    this.messageSent = true;

    const wantsThread = text?.startsWith('<<THREAD>>') || false;
    const rootId = this.deferredExistingRootId || (wantsThread ? this.deferredUserMessageId : undefined);

    this.logger.info({
      cardId: this.cardId,
      wantsThread,
      rootId,
      existingRootId: this.deferredExistingRootId,
      userMessageId: this.deferredUserMessageId,
    }, 'Sending card IM message (deferred)');

    try {
      const content = JSON.stringify({
        type: 'card',
        data: { card_id: this.cardId },
      });

      if (rootId) {
        const resp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: this.deferredChatId,
            content,
            msg_type: 'interactive',
            root_id: rootId,
          } as any,
        });
        this.messageId = (resp as any).data?.message_id || null;
      } else if (this.deferredReplyToMessageId) {
        const resp = await this.client.im.message.reply({
          path: { message_id: this.deferredReplyToMessageId },
          data: { content, msg_type: 'interactive' },
        });
        this.messageId = (resp as any).data?.message_id || null;
      } else {
        const resp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: this.deferredChatId,
            content,
            msg_type: 'interactive',
          },
        });
        this.messageId = (resp as any).data?.message_id || null;
      }

      this.logger.info({ cardId: this.cardId, messageId: this.messageId, rootId }, 'Card message sent');
    } catch (err: any) {
      this.logger.warn({ err: err?.message, cardId: this.cardId }, 'Failed to send card IM message');
    }
  }

  get isFallback(): boolean {
    return this.fallback;
  }

  /**
   * Update the streaming text content. Throttled to avoid API rate limits.
   */
  async updateText(text: string): Promise<void> {
    if (this.fallback || !this.cardId || this.completed) return;

    this.pendingText = text;
    const now = Date.now();

    if (now - this.lastUpdateTime >= THROTTLE_MS) {
      const p = this.flushUpdate();
      this.inflightFlush = p;
      p.finally(() => { if (this.inflightFlush === p) this.inflightFlush = null; });
    } else if (!this.updateTimer) {
      const delay = THROTTLE_MS - (now - this.lastUpdateTime);
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null;
        if (this.completed) return; // Don't flush after complete
        const p = this.flushUpdate().catch(err => {
          this.logger.warn({ err }, 'Throttled card update failed');
        });
        this.inflightFlush = p;
        p.finally(() => { if (this.inflightFlush === p) this.inflightFlush = null; });
      }, delay);
    }
  }

  addToolCall(name: string, input?: string, toolUseId?: string): void {
    // When a new non-Agent tool starts, mark any running Agent calls as complete
    if (name !== 'Agent') {
      for (const tc of this.toolCalls) {
        if (tc.name === 'Agent' && tc.status === 'running') {
          tc.status = 'complete';
          tc.endTime = Date.now();
        }
      }
    }
    this.toolCalls.push({
      name,
      input: input ? (input.length > 200 ? input.slice(0, 200) + '...' : input) : undefined,
      status: 'running',
      startTime: Date.now(),
      toolUseId,
    });
    // Trigger card update to show tool activity
    this.updateText(this.pendingText);
  }

  updateToolCall(toolUseId: string, status: 'complete' | 'failed'): void {
    const tc = this.toolCalls.find(t => t.toolUseId === toolUseId);
    if (tc) {
      tc.status = status;
      tc.endTime = Date.now();
    }
    if (!tc) {
      const running = [...this.toolCalls].reverse().find(t => t.status === 'running');
      if (running) {
        running.status = status;
        running.endTime = Date.now();
      }
    }
    // Trigger card update to reflect tool status change
    this.updateText(this.pendingText);
  }

  /**
   * Finalize the card with complete content.
   */
  async complete(fullText: string): Promise<void> {
    if (this.fallback || !this.cardId) return;

    this.completed = true;

    // Ensure IM message is sent before completing
    await this.ensureMessageSent(fullText);

    // Strip <<THREAD>> tag from display text
    fullText = fullText.replace(/^<<THREAD>>\s*/, '');

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    // Wait for any in-flight flush to finish (prevents sequence race)
    if (this.inflightFlush) {
      await this.inflightFlush.catch(() => {});
      this.inflightFlush = null;
    }

    for (const tc of this.toolCalls) {
      if (tc.status === 'running') {
        tc.status = 'complete';
        tc.endTime = Date.now();
      }
    }

    // Use wall-clock time from card creation to now
    const elapsed = Date.now() - this.startTime;

    try {
      const completeCard = buildCompleteCard(
        fullText,
        this.toolCalls.length > 0 ? this.toolCalls : undefined,
        elapsed,
      );

      this.sequence++;
      const updateResp = await (this.client.cardkit as any).v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(completeCard),
          },
          sequence: this.sequence,
        },
      });
      this.logger.info({ cardId: this.cardId, updateCode: updateResp?.code, updateMsg: updateResp?.msg }, 'Card update response');

      // Disable streaming mode
      this.sequence++;
      const settingsResp = await (this.client.cardkit as any).v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: this.sequence,
        },
      });
      this.logger.info({ cardId: this.cardId, settingsCode: settingsResp?.code, settingsMsg: settingsResp?.msg }, 'Card settings response');

      this.logger.info(
        { cardId: this.cardId, toolCalls: this.toolCalls.length, elapsed },
        'Card streaming completed',
      );
    } catch (err) {
      this.logger.warn({ err, cardId: this.cardId }, 'Failed to complete card');
    }
  }

  async abort(error?: string): Promise<void> {
    if (this.fallback || !this.cardId) return;

    this.completed = true;

    // Ensure IM message is sent before aborting
    await this.ensureMessageSent();

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    // Wait for any in-flight flush
    if (this.inflightFlush) {
      await this.inflightFlush.catch(() => {});
      this.inflightFlush = null;
    }

    try {
      const errorCard = buildCompleteCard(
        error || '❌ 处理中断',
        this.toolCalls.length > 0 ? this.toolCalls : undefined,
        Date.now() - this.startTime,
        '⏹ 已中止',
      );

      this.sequence++;
      await (this.client.cardkit as any).v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(errorCard),
          },
          sequence: this.sequence,
        },
      });

      this.sequence++;
      await (this.client.cardkit as any).v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: this.sequence,
        },
      });
    } catch (err) {
      this.logger.warn({ err }, 'Failed to abort card');
    }
  }

  /**
   * Flush pending text/tool updates to the card.
   */
  private async flushUpdate(): Promise<void> {
    if (!this.cardId) return;

    // Ensure IM message is sent (uses first text to detect <<THREAD>>)
    await this.ensureMessageSent(this.pendingText);

    this.lastUpdateTime = Date.now();
    this.sequence++;

    // Strip <<THREAD>> and <<TITLE:...>> tags from display text (flexible syntax)
    const displayText = this.pendingText
      .replace(/^<<THREAD>>\s*/, '')
      .replace(/<?<<TITLE:.+?>>>?\s*\n?/g, '')
      .replace(/<TITLE:.+?>\s*\n?/g, '');

    try {
      const streamingCard = buildStreamingCard(displayText, this.toolCalls);

      await (this.client.cardkit as any).v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(streamingCard),
          },
          sequence: this.sequence,
        },
      });
    } catch (err) {
      this.logger.warn({ err, cardId: this.cardId, seq: this.sequence }, 'Card update failed');
    }
  }
}
