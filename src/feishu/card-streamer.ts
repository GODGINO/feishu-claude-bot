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
  extractButtons,
  STREAMING_ELEMENT_ID,
  type ToolCallInfo,
  type ButtonInfo,
  type UsageInfo,
} from './card-builder.js';

const THROTTLE_MS = 500; // Minimum interval between card updates
const CARD_TEXT_LIMIT = 28000; // Feishu card markdown content limit

export class CardStreamer {
  private cardId: string | null = null;
  private messageId: string | null = null;
  private sequence = 0;
  private lastUpdateTime = 0;
  private pendingText = '';
  private toolCalls: ToolCallInfo[] = [];
  private taskIdToToolUseId = new Map<string, string>(); // taskId → toolUseId (for subagent step routing)
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private fallback = false;
  startPromise: Promise<void> | null = null; // Track pending start() for lazy mode
  private startTime = 0;
  // Deferred IM message send (to detect <<THREAD>> in first text)
  private messageSent = false;
  private deferredChatId = '';
  private deferredReplyToMessageId?: string;
  private deferredExistingRootId?: string;
  private deferredUserMessageId?: string;
  // Track in-flight flush to prevent race with complete()
  private inflightFlush: Promise<void> | null = null;
  // For button rendering — set by caller before complete()
  sessionKey?: string;
  chatId?: string;
  // Shared cache for button card state (set by caller)
  buttonCardCache?: Map<string, { cardJson: object; sequence: number; expiresAt: number }>;
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

    const wantsThread = false; // Thread creation disabled — only follow existing threads via existingRootId

    this.logger.info({
      cardId: this.cardId,
      wantsThread,
      userMessageId: this.deferredReplyToMessageId,
    }, 'Sending card IM message (deferred)');

    try {
      const content = JSON.stringify({
        type: 'card',
        data: { card_id: this.cardId },
      });

      if (this.deferredReplyToMessageId) {
        const resp = await this.client.im.message.reply({
          path: { message_id: this.deferredReplyToMessageId },
          data: {
            content,
            msg_type: 'interactive',
            ...(wantsThread ? { reply_in_thread: true } : {}),
          } as any,
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

      this.logger.info({ cardId: this.cardId, messageId: this.messageId, wantsThread }, 'Card message sent');
    } catch (err: any) {
      this.logger.warn({ err: err?.message, cardId: this.cardId }, 'Failed to send card IM message');
    }
  }

  get isFallback(): boolean {
    return this.fallback;
  }

  /** Return the IM message ID of the card (available after ensureMessageSent). */
  getMessageId(): string | null {
    return this.messageId;
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
    let displayName = name;
    if (name === 'Agent') {
      const agentCount = this.toolCalls.filter(t => t.name.startsWith('Agent')).length + 1;
      if (agentCount > 1 || this.toolCalls.some(t => t.name.startsWith('Agent'))) {
        // Relabel all existing Agent entries with #N if not already labeled
        let idx = 1;
        for (const tc of this.toolCalls) {
          if (tc.name === 'Agent') {
            tc.name = `Agent #${idx}`;
            idx++;
          } else if (tc.name.startsWith('Agent #')) {
            idx++;
          }
        }
        displayName = `Agent #${idx}`;
      }
    }
    this.toolCalls.push({
      name: displayName,
      input: input ? (input.length > 200 ? input.slice(0, 200) + '...' : input) : undefined,
      status: 'running',
      startTime: Date.now(),
      toolUseId,
    });
    // Start heartbeat when tool calls are folded (>5), so "总用时" updates every second
    this.startHeartbeatIfNeeded();

    // Trigger card update to show tool activity
    this.updateText(this.pendingText);
  }

  updateToolCall(toolUseId: string, status: 'complete' | 'failed'): void {
    const tc = this.toolCalls.find(t => t.toolUseId === toolUseId);
    if (tc) {
      tc.status = status;
      tc.endTime = Date.now();
      // Cascade: when an Agent finishes, also mark any still-running children as complete.
      // Guards against races where completeSubagentSteps missed children.
      if (tc.children && tc.children.length > 0) {
        for (const child of tc.children) {
          if (child.status === 'running') {
            child.status = 'complete';
            child.endTime = Date.now();
          }
        }
      }
    }
    if (!tc) {
      const running = [...this.toolCalls].reverse().find(t => t.status === 'running');
      if (running) {
        running.status = status;
        running.endTime = Date.now();
        if (running.children && running.children.length > 0) {
          for (const child of running.children) {
            if (child.status === 'running') {
              child.status = 'complete';
              child.endTime = Date.now();
            }
          }
        }
      }
    }
    // Trigger card update to reflect tool status change
    this.updateText(this.pendingText);
  }


  /**
   * Finalize the card with complete content.
   */
  async complete(fullText: string, usage?: UsageInfo): Promise<void> {
    // Wait for lazy start() to finish before completing
    if (this.startPromise) {
      await this.startPromise;
      this.startPromise = null;
    }
    if (this.fallback || !this.cardId) return;

    this.completed = true;
    this.stopHeartbeat();

    // Use streaming-accumulated text if it's longer than result text.
    // The result event often contains a short summary that would overwrite
    // the full content shown during streaming.
    if (this.pendingText && this.pendingText.length > fullText.length) {
      this.logger.info(
        { pendingLen: this.pendingText.length, resultLen: fullText.length },
        'Using streaming text (longer than result text)',
      );
      fullText = this.pendingText;
    }

    // Ensure IM message is sent before completing
    await this.ensureMessageSent(fullText);

    // Strip <<THREAD>> and <<REACT:...>> tags from display text
    fullText = fullText.replace(/<<THREAD>>\s*/g, '').replace(/<<REACT:\w+>>\s*/g, '');

    // Extract <<BUTTON:...>> tags
    const { cleanText: textWithoutButtons, buttons } = extractButtons(fullText);
    fullText = textWithoutButtons;

    // Truncate to avoid Feishu card size limit
    if (fullText.length > CARD_TEXT_LIMIT) {
      this.logger.warn({ len: fullText.length, limit: CARD_TEXT_LIMIT }, 'Complete card text truncated');
      fullText = fullText.slice(0, CARD_TEXT_LIMIT) + '\n\n...(内容过长，已截断显示)';
    }

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
        undefined,
        buttons.length > 0 ? buttons : undefined,
        this.sessionKey,
        this.chatId,
        this.cardId || undefined,
        this.messageId || undefined,
        usage,
      );

      // Cache card state for button click updates
      if (buttons.length > 0 && this.cardId) {
        if (this.buttonCardCache) {
          this.buttonCardCache.set(this.cardId, {
            cardJson: completeCard,
            sequence: this.sequence + 2, // account for the update + settings calls below
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          this.logger.info({ cardId: this.cardId, buttonCount: buttons.length, cacheSize: this.buttonCardCache.size }, 'Cached button card for click updates');
        } else {
          this.logger.warn({ cardId: this.cardId }, 'buttonCardCache not set on streamer, cannot cache');
        }
      }

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

  /** Map taskId to the Agent's toolUseId for subagent step routing. */
  registerSubagent(taskId: string, toolUseId: string): void {
    this.taskIdToToolUseId.set(taskId, toolUseId);
    this.logger.info({ taskId, toolUseId, mapSize: this.taskIdToToolUseId.size }, 'Registered subagent mapping');
  }

  /**
   * Add a subagent step as a child of the corresponding Agent tool call.
   * Previous running child is auto-completed.
   */
  addSubagentStep(taskId: string, toolName: string, description?: string): void {
    const agentToolUseId = this.taskIdToToolUseId.get(taskId);
    const agent = agentToolUseId
      ? this.toolCalls.find(t => t.toolUseId === agentToolUseId)
      : [...this.toolCalls].reverse().find(t => t.name === 'Agent' && t.status === 'running');
    if (!agent) {
      this.logger.warn({ taskId, agentToolUseId, toolCallCount: this.toolCalls.length }, 'addSubagentStep: no matching Agent found');
      return;
    }

    if (!agent.children) agent.children = [];

    // Mark previous running children as complete
    for (const child of agent.children) {
      if (child.status === 'running') {
        child.status = 'complete';
        child.endTime = Date.now();
      }
    }

    agent.children.push({
      name: toolName,
      input: description ? (description.length > 200 ? description.slice(0, 200) + '...' : description) : undefined,
      status: 'running',
      startTime: Date.now(),
    });

    this.updateText(this.pendingText);
  }

  /** Mark all running children of a subagent as complete. */
  completeSubagentSteps(taskId: string): void {
    const agentToolUseId = this.taskIdToToolUseId.get(taskId);
    const agent = agentToolUseId
      ? this.toolCalls.find(t => t.toolUseId === agentToolUseId)
      : undefined;
    if (!agent?.children) return;

    for (const child of agent.children) {
      if (child.status === 'running') {
        child.status = 'complete';
        child.endTime = Date.now();
      }
    }
    this.taskIdToToolUseId.delete(taskId);
    this.updateText(this.pendingText);
  }

  private waitingForAgents = false;

  /**
   * Mark text as final but keep card in streaming mode for agent updates.
   * Call this when the main turn is done but subagents are still running.
   */
  completeTextOnly(fullText: string): void {
    fullText = fullText.replace(/<<THREAD>>\s*/g, '');
    this.pendingText = fullText;
    this.waitingForAgents = true;
    // Ensure IM message is sent
    this.ensureMessageSent(fullText).catch(() => {});
    // Flush current state to card
    this.updateText(fullText);
  }

  /** Whether the card is waiting for subagents to complete. */
  isWaitingForAgents(): boolean {
    return this.waitingForAgents;
  }

  /** Finalize the card after all subagents have completed. */
  async finalizeAfterAgents(): Promise<void> {
    this.waitingForAgents = false;
    await this.complete(this.pendingText || '');
  }

  async abort(error?: string): Promise<void> {
    if (this.fallback || !this.cardId) return;

    this.completed = true;
    this.stopHeartbeat();

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
   * Silently delete the card message (for REACT-only / NO_REPLY responses).
   */
  async deleteCard(): Promise<void> {
    this.completed = true;
    this.stopHeartbeat();
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.inflightFlush) {
      await this.inflightFlush.catch(() => {});
      this.inflightFlush = null;
    }
    // Delete the IM message if it was sent
    if (this.messageId) {
      try {
        await this.client.im.message.delete({ path: { message_id: this.messageId } });
        this.logger.info({ messageId: this.messageId }, 'Deleted card message (REACT/NO_REPLY)');
      } catch (err) {
        this.logger.debug({ err, messageId: this.messageId }, 'Failed to delete card message');
      }
    }
  }

  /** Start a 1s heartbeat to keep "总用时" ticking when tool calls are folded. */
  private startHeartbeatIfNeeded(): void {
    if (this.heartbeatTimer || this.completed) return;
    if (this.toolCalls.length === 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (this.completed || !this.cardId) {
        this.stopHeartbeat();
        return;
      }
      // Force a card refresh so the elapsed time updates
      this.flushUpdate().catch(err => {
        this.logger.warn({ err }, 'Heartbeat card update failed');
      });
    }, 1000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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

    // Strip <<THREAD>>, <<REACT:...>>, <<BUTTON:...>> and <<TITLE:...>> tags from display text
    const displayText = this.pendingText
      .replace(/<<THREAD>>\s*/g, '')
      .replace(/<<REACT:\w+>>\s*/g, '')
      .replace(/<<BUTTON:[^>]+>>\s*/g, '')
      .replace(/<?<<TITLE:.+?>>>?\s*\n?/g, '')
      .replace(/<TITLE:.+?>\s*\n?/g, '');

    // Truncate to avoid Feishu card size limit (card gets silently dropped if too long)
    const truncatedText = displayText.length > CARD_TEXT_LIMIT
      ? displayText.slice(0, CARD_TEXT_LIMIT) + '\n\n...(内容过长，已截断显示)'
      : displayText;

    try {
      const streamingCard = buildStreamingCard(truncatedText, this.toolCalls, this.startTime);

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
