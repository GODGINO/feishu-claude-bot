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
import { CardStreamer } from '../feishu/card-streamer.js';

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
      return `[身份绑定: 当前操作者是「${author.name}」(${userId})。所有操作（编写文档、日报、创建内容等）必须以此人身份执行。飞书MCP仅限调用 mcp__feishu_${userId}__* 系列工具，严禁使用其他用户的飞书MCP工具。文档署名、作者信息必须是「${author.name}」，不得使用群内其他人的姓名。使用 feishu-tools MCP 的任务/日历/多维表格工具时，user_id 参数传 ${userId}。如果工具返回未授权错误，先调用 feishu_auth_start 引导用户完成飞书 OAuth 授权。]`;
    }
    // User exists but no MCP URL — provide binding guidance
    if (author) {
      return `[身份: 当前操作者是「${author.name}」(${userId})，但尚未绑定飞书 MCP。如果用户需要使用飞书文档/表格/日历/任务等功能，引导用户访问 https://open.feishu.cn/page/mcp 获取 MCP URL 并发送给我完成绑定。使用 feishu-tools MCP 的任务/日历/多维表格工具时，user_id 参数传 ${userId}。]`;
    }
  } catch { /* ignore */ }
  // DM sessions (no authors.json): still provide feishu-tools hint
  return `[使用 feishu-tools MCP 的任务/日历/多维表格工具时，user_id 参数传 ${userId}。如果工具返回未授权错误，先调用 feishu_auth_start 引导用户完成飞书 OAuth 授权。]`;
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
            await this.sender.sendText(msg.chatId, progressMsg, bg.messageId);
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
            senderId: msg.userId,
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

    // Load context buffer if needed (group and DM chats)
    {
      const session = this.sessionMgr.getOrCreate(sessionKey);
      if (!this.groupContext['buffers'].has(msg.chatId)) {
        this.groupContext.load(session.sessionDir, msg.chatId);
      }
    }

    // Auto-reply check: if off, buffer non-@mention messages without sending to Claude
    if (msg.chatType === 'group' && !msg.isMentioned) {
      let autoReply = 'on';
      try { autoReply = fs.readFileSync(path.join(session.sessionDir, 'auto-reply'), 'utf-8').trim(); } catch {}
      if (autoReply === 'off') {
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: msg.senderName || '未知用户',
          senderId: msg.userId,
          text: msg.text,
        });
        this.groupContext.save(session.sessionDir, msg.chatId);
        return;
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

    // Check auto-reply mode: 'always' treats all group messages as @mentioned
    let autoReplyMode = 'on';
    if (msg.chatType === 'group') {
      try { autoReplyMode = fs.readFileSync(path.join(session.sessionDir, 'auto-reply'), 'utf-8').trim(); } catch {}
    }
    const isNonMentionGroup = msg.chatType === 'group' && !msg.isMentioned && autoReplyMode !== 'always';

    // Thread reply: only use existing thread root if message is already in a thread.
    // Sigma can request new thread via <<THREAD>> tag in response.
    const existingRootId = msg.rootId;
    let threadRootId: string | undefined = existingRootId;

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

      // Group messages: the Claude subprocess is persistent and manages its own context.
      // We only inject missed messages (buffered while auto-reply=off or bot was busy).
      // @mention vs non-@mention: same flow, different hint.
      if (msg.chatType === 'group') {
        // Inject missed messages (only non-empty when auto-reply=off had buffered messages)
        const missedStr = this.groupContext.formatMissed(msg.chatId);
        if (missedStr) {
          prompt = `${missedStr}\n\n${prompt}`;
        }

        // Add behavior hint
        if (isNonMentionGroup) {
          prompt = `[群聊消息，未@你]\n${prompt}\n[如果这条消息不需要你回复（闲聊、表情、"好的/收到"等），请仅回复 NO_REPLY 两个词，不加任何其他内容。如果有人提问、讨论你擅长的话题、或提到你的名字(Sigma)，则正常回复。]`;
        } else {
          prompt = `[你被@提及，必须回复]\n${prompt}`;
        }

        // Record + mark sent (for admin dashboard + missed message tracking)
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: userName || msg.senderName || '未知用户',
          senderId: msg.userId,
          text: msg.text,
        });
        this.groupContext.markSent(msg.chatId);
      } else if (msg.chatType === 'p2p') {
        // Record DM message (for admin dashboard only)
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: userName || msg.senderName || '未知用户',
          senderId: msg.userId,
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

      // Fetch merge_forward child messages if present
      if (msg.messageType === 'merge_forward') {
        const mergeContent = await this.sender.fetchMergeForwardContent(msg.messageId);
        if (mergeContent) {
          prompt = prompt.replace('[合并转发消息]', mergeContent);
        }
      }

      // Download images if present
      let images: ImageAttachment[] | undefined;
      if (msg.images && msg.images.length > 0) {
        images = [];
        const savedPaths: string[] = [];
        for (const imgInfo of msg.images) {
          const downloaded = await this.sender.downloadImage(msg.messageId, imgInfo.imageKey);
          if (downloaded) {
            images.push({ base64: downloaded.base64, mediaType: downloaded.mediaType });
            // Save image to session directory so tools (e.g. image-gen-api) can access it
            try {
              const ext = downloaded.mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
              const imgPath = path.join(session.sessionDir, `upload-${Date.now()}-${savedPaths.length}.${ext}`);
              fs.writeFileSync(imgPath, Buffer.from(downloaded.base64, 'base64'));
              savedPaths.push(imgPath);
              this.logger.info({ imageKey: imgInfo.imageKey, imgPath }, 'Saved image to session dir');
            } catch (e) {
              this.logger.warn({ error: e }, 'Failed to save image file');
            }
          }
        }
        if (images.length === 0) images = undefined;
        if (savedPaths.length > 0) {
          prompt += `\n[用户发送的图片已保存: ${savedPaths.join(', ')}]`;
        }
      }

      // Download files if present
      if (msg.files && msg.files.length > 0) {
        const filePaths: string[] = [];
        for (const fileInfo of msg.files) {
          const filePath = await this.sender.downloadFile(msg.messageId, fileInfo.fileKey, fileInfo.fileName, session.sessionDir);
          if (filePath) {
            filePaths.push(filePath);
          }
        }
        if (filePaths.length > 0) {
          prompt += `\n[用户发送的文件已保存: ${filePaths.join(', ')}]`;
        }
      }

      // Check streaming mode
      let streamingReply = 'on';
      try { streamingReply = fs.readFileSync(path.join(session.sessionDir, 'streaming-reply'), 'utf-8').trim(); } catch {}

      this.logger.info({ sessionKey, streamingReply, isNonMentionGroup }, 'Streaming check');

      // Streaming card path: create card and stream updates in real-time
      if (streamingReply === 'on' && !isNonMentionGroup) {
        this.logger.info({ sessionKey }, 'Entering streaming card path');
        const streamer = new CardStreamer(this.sender.larkClient, this.logger);
        await streamer.start(msg.chatId, msg.messageId, existingRootId, msg.messageId);

        if (!streamer.isFallback) {
          // Register stream callbacks scoped to this session
          const onText = (key: string, text: string) => {
            if (key === sessionKey) {
              this.logger.info({ sessionKey, textLen: text.length }, 'Stream text callback fired');
              streamer.updateText(text);
            }
          };
          const onTool = (key: string, event: { type: 'start' | 'end'; toolName: string; toolInput?: string; toolUseId?: string; isError?: boolean }) => {
            if (key !== sessionKey) return;
            if (event.type === 'start') {
              streamer.addToolCall(event.toolName, event.toolInput, event.toolUseId);
            } else if (event.type === 'end' && event.toolUseId) {
              streamer.updateToolCall(event.toolUseId, event.isError ? 'failed' : 'complete');
            }
          };
          this.runner.onTextStream(sessionKey, onText);
          this.runner.onToolStream(sessionKey, onTool);

          try {
            const result = await this.runner.run({
              sessionKey,
              message: prompt + TITLE_INSTRUCTION,
              sessionDir: session.sessionDir,
              abortSignal: abortController.signal,
              images,
            });

            const rawText = result.fullText || '';
            const replyText = rawText.trim();
            // Detect <<THREAD>> for sendMentionedFiles rootId
            const streamWantsThread = rawText.startsWith('<<THREAD>>');
            const streamRootId = existingRootId || (streamWantsThread ? msg.messageId : undefined);
            if (isNonMentionGroup && replyText === 'NO_REPLY') {
              await streamer.abort('(无需回复)');
            } else {
              await streamer.complete(rawText || '(空回复)');
              const cleanText = rawText.replace(/^<<THREAD>>\s*/, '');
              await this.sendMentionedFiles(msg.chatId, cleanText, session.sessionDir, undefined, streamRootId);
            }

            // Write bot reply to context buffer
            const cleanReply = replyText.replace(/^<<THREAD>>\s*/, '');
            if ((msg.chatType === 'group' || msg.chatType === 'p2p') && cleanReply && cleanReply !== 'NO_REPLY') {
              const entries = this.groupContext['buffers'].get(msg.chatId);
              if (entries && entries.length > 0) {
                entries[entries.length - 1].botReply = cleanReply.length > 500
                  ? cleanReply.slice(0, 500) + '...' : cleanReply;
              }
              this.groupContext.save(session.sessionDir, msg.chatId);
            }
          } catch (err) {
            if (abortController.signal.aborted) {
              // /stop was used — complete with whatever content we have, not an error
              this.logger.info({ sessionKey }, 'Streaming task stopped by user');
              await streamer.complete(streamer.getCurrentText() || '⏹ 任务已中止');
            } else {
              this.logger.error({ err, sessionKey }, 'Streaming task failed');
              await streamer.abort(`❌ 出错了: ${err instanceof Error ? err.message : String(err)}`);
            }
          } finally {
            this.runner.onTextStream(sessionKey, undefined);
            this.runner.onToolStream(sessionKey, undefined);
          }
          // Skip the normal reply flow below — streaming handled everything
          return;
        }
        // If fallback, continue with normal flow below
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
        // Detect <<THREAD>> tag for thread reply
        const wantsThread = result.fullText?.startsWith('<<THREAD>>') || false;
        const effectiveRootId = existingRootId || (wantsThread ? msg.messageId : undefined);
        // Strip <<THREAD>> from result before sending
        if (wantsThread && result.fullText) {
          result.fullText = result.fullText.replace(/^<<THREAD>>\s*/, '');
        }
        this.logger.info(
          { sessionKey, hasError: !!result.error, textLength: replyText.length, mode: 'quick', isNoReply: replyText === 'NO_REPLY', wantsThread },
          'Claude subprocess finished (quick)',
        );
        if (isNonMentionGroup && (replyText === 'NO_REPLY' || replyText === '')) {
          // Silent skip — no reply needed (only for non-@mention group messages)
        } else {
          await this.sendResult(msg, sessionKey, session, result, reactionId ?? undefined, effectiveRootId);
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
            // Detect <<THREAD>> for background results
            const bgWantsThread = result.fullText?.startsWith('<<THREAD>>') || false;
            const bgRootId = existingRootId || (bgWantsThread ? msg.messageId : undefined);
            if (bgWantsThread && result.fullText) {
              result.fullText = result.fullText.replace(/^<<THREAD>>\s*/, '');
            }
            this.logger.info(
              { sessionKey, hasError: !!result.error, textLength: replyText.length, mode: 'background', isNoReply: replyText === 'NO_REPLY', bgWantsThread },
              'Claude subprocess finished (background)',
            );
            if (isNonMentionGroup && (replyText === 'NO_REPLY' || replyText === '')) {
              // Silent skip (only for non-@mention group messages)
            } else if (result.error && !result.fullText) {
              await this.sender.sendReply(msg.chatId, `❌ 出错了: ${result.error}`, undefined, undefined, bgRootId);
            } else {
              const finalText = result.fullText || '(空回复)';
              await this.sender.sendReply(msg.chatId, finalText, undefined, session.sessionDir, bgRootId);
              await this.sendMentionedFiles(msg.chatId, finalText, session.sessionDir, undefined, bgRootId);
              // Write to context buffer
              if (msg.chatType === 'group' || msg.chatType === 'p2p') {
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
              this.sender.sendReply(msg.chatId, '❌ 后台任务失败，请重试', undefined, undefined, existingRootId).catch(() => {});
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
      await this.sender.sendReply(msg.chatId, '❌ 处理消息时出错，请重试', undefined, undefined, existingRootId);
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
    threadRootId?: string,
  ): Promise<void> {
    const replyText = result.fullText || '(空回复)';
    if (result.error && !result.fullText) {
      await this.sender.sendReply(msg.chatId, `❌ 出错了: ${result.error}`, undefined, undefined, threadRootId);
    } else {
      await this.sender.sendReply(msg.chatId, replyText, undefined, session.sessionDir, threadRootId);
      await this.sendMentionedFiles(msg.chatId, replyText, session.sessionDir, undefined, threadRootId);
    }

    // Write bot reply to context buffer
    if (msg.chatType === 'group' || msg.chatType === 'p2p') {
      const entries = this.groupContext['buffers'].get(msg.chatId);
      if (entries && entries.length > 0) {
        entries[entries.length - 1].botReply = replyText.length > 500
          ? replyText.slice(0, 500) + '...' : replyText;
      }
      this.groupContext.save(session.sessionDir, msg.chatId);
    }
  }

  /**
   * Scan Claude's reply for file paths and send them via Feishu.
   * Matches paths in session directory and /tmp/.
   */
  private async sendMentionedFiles(
    chatId: string,
    replyText: string,
    sessionDir: string,
    replyToMessageId?: string,
    rootId?: string,
  ): Promise<void> {
    try {
      // Match absolute paths that look like files (with extensions)
      const escapedDir = sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const projectRoot = path.resolve(sessionDir, '..', '..');
      const escapedRoot = projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(escapedDir + '/[\\w./-]+\\.\\w+', 'g'),
        new RegExp(escapedRoot + '/[\\w./-]+\\.\\w+', 'g'),
        /\/tmp\/[\w./-]+\.\w+/g,
      ];
      const allMatches: string[] = [];
      for (const p of patterns) {
        const m = replyText.match(p);
        if (m) allMatches.push(...m);
      }
      if (allMatches.length === 0) return;
      const matches = allMatches;

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
          await this.sender.sendImage(chatId, filePath, undefined, rootId);
        } else {
          await this.sender.sendFile(chatId, filePath, undefined, rootId);
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
