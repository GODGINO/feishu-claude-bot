import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage } from '../feishu/event-handler.js';
import type { MessageSender } from '../feishu/message-sender.js';
import type { TypingIndicator } from '../feishu/typing.js';
import type { ClaudeRunner, ImageAttachment } from '../claude/runner.js';
import { ProcessPool } from '../claude/process-pool.js';
import { SessionManager } from '../claude/session-manager.js';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { CommandHandler } from './command-handler.js';
import { MessageQueue } from './message-queue.js';
import { GroupContextBuffer } from './group-context.js';
import { EmailSetup } from './email-setup.js';
import type { IdleMonitor } from '../email/idle-monitor.js';

const TITLE_INSTRUCTION = '\n\n[当你的回复包含 markdown 格式（表格、列表、代码块、加粗、链接、分隔线等）时，必须在第一行写 <<TITLE:简短标题>>，然后空一行写正文。标题10字以内，概括主题。纯文字短回复（打招呼、一两句话确认）不要写标题。]';

/**
 * Get feishu MCP tool restriction hint for a specific user in group chat.
 * Returns empty string for DM or if user has no feishu MCP configured.
 */
function getFeishuMcpHint(sessionDir: string, userId: string): string {
  try {
    const authorsFile = path.join(sessionDir, 'authors.json');
    if (!fs.existsSync(authorsFile)) return '';
    const data = JSON.parse(fs.readFileSync(authorsFile, 'utf-8'));
    const author = data.authors?.[userId];
    if (author?.feishuMcpUrl) {
      return `[飞书文档工具限制: 此消息发送者的飞书MCP为 feishu_${userId}，操作飞书文档时仅限调用 mcp__feishu_${userId}__* 系列工具，严禁使用其他用户的飞书MCP工具]`;
    }
  } catch { /* ignore */ }
  return '';
}

export class MessageBridge {
  private runningTasks = new Set<string>();
  private abortControllers = new Map<string, AbortController>();
  // Track background tasks for progress reporting (user can ask about status)
  private backgroundSessions = new Map<string, { chatId: string; messageId: string; startedAt: number; recentTools: { desc: string; time: number }[] }>();
  private commandHandler: CommandHandler;
  private queue: MessageQueue;
  private groupContext: GroupContextBuffer;
  private emailSetup: EmailSetup;
  // Dedup: Feishu WebSocket can re-deliver events on reconnect, bypassing event-handler dedup
  private recentMessageIds = new Set<string>();


  constructor(
    private sender: MessageSender,
    private typing: TypingIndicator,
    private runner: ClaudeRunner,
    private sessionMgr: SessionManager,
    private config: Config,
    private logger: Logger,
  ) {
    this.queue = new MessageQueue(config.maxQueuePerSession, logger);
    this.groupContext = new GroupContextBuffer(logger);
    this.emailSetup = new EmailSetup(sender, sessionMgr, logger);
    this.commandHandler = new CommandHandler(
      sender,
      sessionMgr,
      runner,
      this.runningTasks,
      this.abortControllers,
      logger,
    );
    this.commandHandler.setEmailSetup(this.emailSetup);

    // Accumulate progress events for background tasks (user can query status)
    this.runner.onProgress((sessionKey, toolName) => {
      const bg = this.backgroundSessions.get(sessionKey);
      if (!bg) return;
      const desc = ProcessPool.describeToolUse(toolName);
      bg.recentTools.push({ desc, time: Date.now() });
      // Keep only last 20 events to avoid unbounded growth
      if (bg.recentTools.length > 20) bg.recentTools.shift();
    });

    // Handle unsolicited output from background agents
    this.runner.onUnsolicitedResult(async (sessionKey, result) => {
      if (!result.fullText) return;
      try {
        const session = this.sessionMgr.getOrCreate(sessionKey);
        // Read chatId from file (saved when message was first received)
        const chatIdFile = path.join(session.sessionDir, 'chat-id');
        const chatId = fs.readFileSync(chatIdFile, 'utf-8').trim();
        if (!chatId) return;

        this.logger.info(
          { sessionKey, textLen: result.fullText.length },
          'Sending unsolicited result (background agent completion)',
        );
        await this.sender.sendReply(chatId, result.fullText, undefined, session.sessionDir);
        await this.sendMentionedFiles(chatId, result.fullText, session.sessionDir);
      } catch (err) {
        this.logger.warn({ err, sessionKey }, 'Failed to send unsolicited result');
      }
    });

  }

  /**
   * Set the IDLE monitor reference (for email add/remove notifications).
   */
  setIdleMonitor(monitor: IdleMonitor): void {
    this.emailSetup.setIdleMonitor(monitor);
    this.commandHandler.setIdleMonitor(monitor);
  }

  /**
   * Main entry point for incoming messages.
   */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    // Dedup guard: reject duplicate messageIds (Feishu WebSocket may re-deliver on reconnect)
    if (this.recentMessageIds.has(msg.messageId)) {
      this.logger.warn({ messageId: msg.messageId }, 'Duplicate message in bridge, ignoring');
      return;
    }
    this.recentMessageIds.add(msg.messageId);
    setTimeout(() => this.recentMessageIds.delete(msg.messageId), 600_000);

    const sessionKey = SessionManager.getSessionKey(msg.chatType, msg.userId, msg.chatId);

    // Persist chatId mapping for cron job delivery (DM sessionKey can't derive chatId)
    const session = this.sessionMgr.getOrCreate(sessionKey);
    try {
      fs.writeFileSync(path.join(session.sessionDir, 'chat-id'), msg.chatId);
    } catch { /* ignore */ }

    // Check for slash commands
    const isCommand = await this.commandHandler.handle(msg.text, {
      chatId: msg.chatId,
      messageId: msg.messageId,
      sessionKey,
      userId: msg.userId,
      senderName: msg.senderName,
    });
    if (isCommand) return;

    // Check if email setup flow is active — route messages there instead of Claude
    if (this.emailSetup.isActive(sessionKey)) {
      const handled = await this.emailSetup.handleMessage(
        sessionKey, msg.chatId, msg.messageId, msg.text,
      );
      if (handled) return;
    }

    // Check if session is busy — queue message and optionally reply with progress
    if (this.runningTasks.has(sessionKey)) {
      const queued = this.queue.enqueue(sessionKey, msg);
      if (queued) {
        this.logger.info(
          { sessionKey, isMentioned: msg.isMentioned, queueSize: this.queue.queueSize(sessionKey) },
          'Message queued (session busy)',
        );
        // Reply with progress status if background task is tracked
        if (msg.isMentioned || msg.chatType === 'p2p') {
          const bg = this.backgroundSessions.get(sessionKey);
          if (bg) {
            const elapsed = Math.round((Date.now() - bg.startedAt) / 1000);
            const progressMsg = this.formatProgress(bg.recentTools, elapsed);
            this.logger.info({ sessionKey, elapsed, toolCount: bg.recentTools.length }, 'Sending progress reply');
            await this.sender.sendText(msg.chatId, progressMsg);
          }
        }
      } else {
        // Queue full — still record non-@mention in context buffer
        if (!msg.isMentioned && msg.chatType === 'group') {
          const session = this.sessionMgr.getOrCreate(sessionKey);
          if (!this.groupContext['buffers'].has(msg.chatId)) {
            this.groupContext.load(session.sessionDir, msg.chatId);
          }
          this.groupContext.add(msg.chatId, {
            timestamp: Date.now(),
            senderName: msg.senderName || '未知用户',
            text: msg.text,
          });
          this.groupContext.save(session.sessionDir, msg.chatId);
        }
      }

      return;
    }

    // Check global concurrent limit
    if (this.runner.activeCount >= this.config.maxConcurrent) {
      if (msg.isMentioned) {
        await this.sender.sendText(msg.chatId, '⏳ 系统繁忙，请稍后重试', msg.messageId);
      }
      return;
    }

    // Load group context buffer if needed (group chats only)
    if (msg.chatType === 'group') {
      const session = this.sessionMgr.getOrCreate(sessionKey);
      if (!this.groupContext['buffers'].has(msg.chatId)) {
        this.groupContext.load(session.sessionDir, msg.chatId);
      }
    }

    // Unified: all messages go through executeMessage
    await this.executeMessage(msg, sessionKey);
  }

  private async executeMessage(msg: IncomingMessage, sessionKey: string): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    this.runningTasks.add(sessionKey);

    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    const isNonMentionGroup = !msg.isMentioned && msg.chatType === 'group';

    // Start typing indicator (THINKING emoji for non-@mention, normal for @mention)
    const reactionId = await this.typing.start(msg.messageId, isNonMentionGroup ? 'THINKING' : undefined);
    let backgroundMode = false; // true = cleanup handled by .finally() on the promise, skip try/finally

    try {
      // Resolve user name: try API first, fall back to event sender name
      const userName = await this.sender.resolveUserName(msg.userId) || msg.senderName || null;

      // Build prompt with context
      let prompt = msg.text;

      // Add user identity prefix (for group chats or general context)
      if (userName) {
        const mcpHint = getFeishuMcpHint(session.sessionDir, msg.userId);
        prompt = `[发送者: ${userName} | id: ${msg.userId}]${mcpHint ? ' ' + mcpHint : ''} ${prompt}`;
      }

      // For group messages, inject rolling context and appropriate tag
      if (msg.chatType === 'group') {
        const contextStr = this.groupContext.format(msg.chatId);
        if (isNonMentionGroup) {
          const tag = '[群聊消息，未@你]';
          const noReplyHint = '\n[如果这条消息不需要你回复（闲聊、表情、"好的/收到"等），请仅回复 NO_REPLY 两个词，不加任何其他内容。如果有人提问、讨论你擅长的话题、或提到你的名字(Sigma)，则正常回复。]';
          prompt = contextStr
            ? `${contextStr}\n\n${tag}\n${prompt}${noReplyHint}`
            : `${tag}\n${prompt}${noReplyHint}`;
        } else {
          const tag = '[你被@提及，必须回复]';
          prompt = contextStr ? `${contextStr}\n\n${tag}\n${prompt}` : `${tag}\n${prompt}`;
        }

        // Write user message to group context buffer
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: userName || msg.senderName || '未知用户',
          text: msg.text,
        });
      }

      // Add quoted message context if present
      if (msg.parentId) {
        const quotedText = await this.sender.fetchMessageText(msg.parentId);
        if (quotedText) {
          prompt = `[用户引用了一条消息]\n引用内容: "${quotedText}"\n\n${prompt}`;
        }
      }

      // Download images if present
      let images: ImageAttachment[] | undefined;
      if (msg.images && msg.images.length > 0) {
        images = [];
        for (const imgInfo of msg.images) {
          const downloaded = await this.sender.downloadImage(msg.messageId, imgInfo.imageKey);
          if (downloaded) {
            images.push({ base64: downloaded.base64, mediaType: downloaded.mediaType });
          }
        }
        if (images.length === 0) images = undefined;
      }

      // Start Claude processing (non-blocking race with timeout)
      const resultPromise = this.runner.run({
        sessionKey,
        message: prompt + TITLE_INSTRUCTION,
        sessionDir: session.sessionDir,
        abortSignal: abortController.signal,
        images,
      });

      // Race: wait up to 15 seconds for a quick response.
      // If Claude responds in time → send reply normally.
      // If not → release the lock so new messages can be processed,
      //          and handle the result in the background when it arrives.
      const QUICK_TIMEOUT_MS = 15_000;
      const quickResult = await Promise.race([
        resultPromise.then(r => ({ type: 'result' as const, result: r })),
        new Promise<{ type: 'timeout' }>(resolve =>
          setTimeout(() => resolve({ type: 'timeout' }), QUICK_TIMEOUT_MS),
        ),
      ]);

      if (quickResult.type === 'result') {
        // Claude responded quickly — check for NO_REPLY before sending
        const result = quickResult.result;
        const replyText = result.fullText?.trim() || '';
        this.logger.info(
          { sessionKey, hasError: !!result.error, textLength: replyText.length, mode: 'quick', isNoReply: replyText === 'NO_REPLY' },
          'Claude subprocess finished (quick)',
        );
        if (replyText === 'NO_REPLY' || (isNonMentionGroup && replyText === '')) {
          // Silent skip — no reply needed
        } else {
          await this.sendResult(msg, sessionKey, session, result, reactionId ?? undefined);
        }
      } else {
        // Claude is still processing — keep typing indicator and lock
        this.logger.info({ sessionKey }, 'Quick timeout — continuing in background, keeping lock');
        backgroundMode = true;

        // Track for progress reporting
        this.backgroundSessions.set(sessionKey, {
          chatId: msg.chatId,
          messageId: msg.messageId,
          startedAt: Date.now(),
          recentTools: [],
        });

        // Activity-based timeout: check every 60s, abort if no activity for 5min (@mention) or 3min (non-@mention)
        const IDLE_LIMIT_MS = isNonMentionGroup ? 180_000 : 300_000;
        const bgStartTime = Date.now();
        const activityCheck = setInterval(() => {
          const lastActivity = this.runner.getLastActivity(sessionKey);
          // Use bgStartTime as fallback if process has no activity yet
          const reference = lastActivity > 0 ? lastActivity : bgStartTime;
          const idleMs = Date.now() - reference;
          if (idleMs > IDLE_LIMIT_MS) {
            this.logger.warn({ sessionKey, idleMs, idleLimitMs: IDLE_LIMIT_MS }, 'Activity timeout — aborting');
            abortController.abort();
            clearInterval(activityCheck);
          }
        }, 60_000);

        // Handle result when it eventually arrives
        resultPromise
          .then(async (result) => {
            clearInterval(activityCheck);
            const replyText = result.fullText?.trim() || '';
            this.logger.info(
              { sessionKey, hasError: !!result.error, textLength: replyText.length, mode: 'background', isNoReply: replyText === 'NO_REPLY' },
              'Claude subprocess finished (background)',
            );
            if (replyText === 'NO_REPLY' || (isNonMentionGroup && replyText === '')) {
              // Silent skip
            } else if (result.error && !result.fullText) {
              await this.sender.sendReply(msg.chatId, `❌ 出错了: ${result.error}`, msg.messageId);
            } else {
              const finalText = result.fullText || '(空回复)';
              await this.sender.sendReply(msg.chatId, finalText, msg.messageId, session.sessionDir);
              await this.sendMentionedFiles(msg.chatId, finalText, session.sessionDir, msg.messageId);
              // Write to group context
              if (msg.chatType === 'group') {
                const entries = this.groupContext['buffers'].get(msg.chatId);
                if (entries && entries.length > 0) {
                  entries[entries.length - 1].botReply = finalText.length > 500
                    ? finalText.slice(0, 500) + '...' : finalText;
                }
                this.groupContext.save(session.sessionDir, msg.chatId);
              }
            }
          })
          .catch((err) => {
            clearInterval(activityCheck);
            this.logger.error({ err, sessionKey }, 'Background task failed');
            if (!isNonMentionGroup) {
              this.sender.sendReply(msg.chatId, '❌ 后台任务失败，请重试', msg.messageId).catch(() => {});
            }
          })
          .finally(() => {
            // Clean up background session tracking, release lock, stop typing
            this.backgroundSessions.delete(sessionKey);
            this.typing.stop(msg.messageId, reactionId).catch(() => {});
            this.runningTasks.delete(sessionKey);
            this.abortControllers.delete(sessionKey);
            this.processQueue(sessionKey);
          });

        return; // Don't run finally cleanup — backgroundMode flag prevents it
      }

    } catch (err) {
      this.logger.error({ err, sessionKey }, 'Failed to process message');
      await this.sender.sendReply(msg.chatId, '❌ 处理消息时出错，请重试', msg.messageId);
    } finally {
      if (!backgroundMode) {
        // Stop typing indicator and release lock
        await this.typing.stop(msg.messageId, reactionId);
        this.runningTasks.delete(sessionKey);
        this.abortControllers.delete(sessionKey);

        // Process next queued message
        await this.processQueue(sessionKey);
      }
      // backgroundMode: cleanup is handled by the promise .finally() above
    }
  }

  /**
   * Send the Claude result as a reply (shared by quick and background paths).
   */
  private async sendResult(
    msg: IncomingMessage,
    sessionKey: string,
    session: { sessionDir: string },
    result: { fullText: string; error?: string; sessionId?: string },
    reactionId: string | undefined,
  ): Promise<void> {
    const replyText = result.fullText || '(空回复)';
    if (result.error && !result.fullText) {
      await this.sender.sendReply(msg.chatId, `❌ 出错了: ${result.error}`, msg.messageId);
    } else {
      await this.sender.sendReply(msg.chatId, replyText, msg.messageId, session.sessionDir);
      await this.sendMentionedFiles(msg.chatId, replyText, session.sessionDir, msg.messageId);
    }

    // Write bot reply to group context buffer
    if (msg.chatType === 'group') {
      const entries = this.groupContext['buffers'].get(msg.chatId);
      if (entries && entries.length > 0) {
        entries[entries.length - 1].botReply = replyText.length > 500
          ? replyText.slice(0, 500) + '...' : replyText;
      }
      this.groupContext.save(session.sessionDir, msg.chatId);
    }
  }

  /**
   * Scan Claude's reply for file paths in the session directory and send them via Feishu.
   */
  private async sendMentionedFiles(
    chatId: string,
    replyText: string,
    sessionDir: string,
    replyToMessageId?: string,
  ): Promise<void> {
    try {
      // Match absolute paths that look like files (with extensions)
      const pathPattern = new RegExp(
        sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[\\w./-]+\\.\\w+',
        'g',
      );
      const matches = replyText.match(pathPattern);
      if (!matches) return;

      // Deduplicate
      const uniquePaths = [...new Set(matches)];
      const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

      for (const filePath of uniquePaths) {
        if (!fs.existsSync(filePath)) continue;

        // Skip very large files (> 30MB)
        const stat = fs.statSync(filePath);
        if (stat.size > 30 * 1024 * 1024) {
          this.logger.warn({ filePath, sizeMB: Math.round(stat.size / 1024 / 1024) }, 'File too large to send');
          continue;
        }

        const ext = path.extname(filePath).toLowerCase();
        if (imageExts.has(ext)) {
          await this.sender.sendImage(chatId, filePath);
        } else {
          await this.sender.sendFile(chatId, filePath);
        }

        this.logger.info({ filePath }, 'Sent file to Feishu');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to send mentioned files');
    }
  }

  /**
   * Format progress info for user query about background task status.
   */
  private formatProgress(recentTools: { desc: string; time: number }[], elapsedSec: number): string {
    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;

    if (recentTools.length === 0) {
      return `⏳ 任务正在处理中（已运行 ${timeStr}），完成后会自动回复你。你的新消息已排队，会在当前任务完成后处理。`;
    }

    // Deduplicate consecutive same descriptions
    const steps: string[] = [];
    let lastDesc = '';
    for (const t of recentTools) {
      if (t.desc !== lastDesc) {
        steps.push(t.desc);
        lastDesc = t.desc;
      }
    }

    const latestDesc = steps[steps.length - 1];
    const stepsStr = steps.length > 1 ? `已完成: ${steps.slice(0, -1).join(' → ')}\n当前: ${latestDesc}` : `当前: ${latestDesc}`;

    return `⏳ 任务正在处理中（已运行 ${timeStr}）\n${stepsStr}\n\n完成后会自动回复。你的新消息已排队。`;
  }

  private async processQueue(sessionKey: string): Promise<void> {
    const next = this.queue.dequeue(sessionKey);
    if (next) {
      this.logger.info({ sessionKey, isMentioned: next.msg.isMentioned }, 'Processing queued message');
      await this.executeMessage(next.msg, next.sessionKey);
    }
  }
}
