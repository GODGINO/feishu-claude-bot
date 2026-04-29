import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage } from '../feishu/event-handler.js';
import type { MessageSender } from '../feishu/message-sender.js';
import type { TypingIndicator } from '../feishu/typing.js';
import type { ClaudeRunner, ImageAttachment } from '../claude/runner.js';
import type { LiveUsage } from '../claude/stream-parser.js';
import { SessionManager } from '../claude/session-manager.js';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { isNoReply } from '../feishu/card-builder.js';
import { CommandHandler } from './command-handler.js';
import { MessageQueue, type Job } from './message-queue.js';
import { GroupContextBuffer } from './group-context.js';
import { EmailSetup } from './email-setup.js';
import type { IdleMonitor } from '../email/idle-monitor.js';
import type { EmailProcessor, RawEmail } from '../email/email-processor.js';
import { formatPushNotification } from '../email/email-processor.js';
import type { EmailAccount } from '../email/account-store.js';
import { CardStreamer } from '../feishu/card-streamer.js';
import type { MemberManager } from '../members/member-manager.js';
import type { WechatBridge } from '../wechat/wechat-bridge.js';

const TITLE_INSTRUCTION = '\n\n[当你的回复包含 markdown 格式（表格、列表、代码块、加粗、链接、分隔线等）时，必须在第一行写 <<TITLE:简短标题|颜色>>，然后空一行写正文。颜色可选：blue（默认/信息）/ green（成功/完成）/ red（失败/紧急）/ orange（警告）/ yellow（提醒/亮点）/ wathet（次级信息/数据播报）/ turquoise（进展中）/ carmine（严重警告）/ violet/purple/indigo（特殊场景）/ grey（中立/不活跃）。不指定颜色时省略 |颜色 即可（默认 blue）。示例：<<TITLE:部署成功|green>>、<<TITLE:沪指 -1.5%|orange>>、<<TITLE:回复内容>>。标题10字以内，概括主题。纯文字短回复（打招呼、一两句话确认）不要写标题。]';

/**
 * Get feishu MCP tool restriction hint for a specific user in group chat.
 * Returns empty string for DM or if user has no feishu MCP configured.
 */
function getFeishuMcpHint(sessionDir: string, userId: string): string {
  try {
    // Read from members/{userId}/profile.json (via symlink)
    const profilePath = path.join(sessionDir, 'members', userId, 'profile.json');
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
      if (profile.feishuMcpUrl) {
        return `[身份绑定: 当前操作者是「${profile.name}」(${userId})。所有操作（编写文档、日报、创建内容等）必须以此人身份执行。飞书MCP仅限调用 mcp__feishu_${userId}__* 系列工具，严禁使用其他用户的飞书MCP工具。文档署名、作者信息必须是「${profile.name}」，不得使用群内其他人的姓名。使用 feishu-tools MCP 的任务/日历/多维表格工具时，user_id 参数传 ${userId}。如果工具返回未授权错误，先调用 feishu_auth_start 引导用户完成飞书 OAuth 授权。]`;
      }
      return `[身份: 当前操作者是「${profile.name}」(${userId})，但尚未绑定飞书 MCP。如果用户需要使用飞书文档/表格/日历/任务等功能，引导用户访问 https://open.feishu.cn/page/mcp 获取 MCP URL 并发送给我完成绑定。使用 feishu-tools MCP 的任务/日历/多维表格工具时，user_id 参数传 ${userId}。]`;
    }
  } catch { /* ignore */ }
  return `[使用 feishu-tools MCP 的任务/日历/多维表格工具时，user_id 参数传 ${userId}。如果工具返回未授权错误，先调用 feishu_auth_start 引导用户完成飞书 OAuth 授权。]`;
}

export class MessageBridge {
  private runningTasks = new Set<string>();
  private abortControllers = new Map<string, AbortController>();
  // Cache finalized card state for button click updates (cardId → card data)
  private buttonCardCache = new Map<string, { cardJson: object; sequence: number; expiresAt: number }>();
  private commandHandler: CommandHandler;
  private queue: MessageQueue;
  private groupContext: GroupContextBuffer;
  private emailSetup: EmailSetup;
  // Dedup: Feishu WebSocket can re-deliver events on reconnect, bypassing event-handler dedup
  private recentMessageIds = new Set<string>();
  private memberMgr?: MemberManager;
  private wechatBridge?: WechatBridge;
  private adminChat?: import('../admin/admin-chat.js').AdminChatServer;
  private emailProcessor?: EmailProcessor;
  // Track original text per session for cross-channel echo
  private wechatPendingEcho = new Map<string, string>();
  private feishuPendingEcho = new Map<string, string>();
  // Track active card streamers per session — used to finalize stale agent cards on new turn
  private activeStreamers = new Map<string, import('../feishu/card-streamer.js').CardStreamer>();
  private adminChatPendingEcho = new Map<string, { text: string; echo: boolean; showSource: boolean }>();


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

    // Periodically clean up expired button card cache entries
    setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.buttonCardCache) {
        if (entry.expiresAt < now) this.buttonCardCache.delete(id);
      }
    }, 60 * 60 * 1000).unref();

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
        await this.sendMentionedFiles(chatId, result.fullText, session.sessionDir, undefined, undefined, sessionKey);
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

  /** Set the EmailProcessor reference (used by enqueueEmailProcess). */
  setEmailProcessor(processor: EmailProcessor): void {
    this.emailProcessor = processor;
  }

  /**
   * Public entry called by IdleMonitor when new emails arrive. Routes the
   * spam-classification + push-notification through the user session's
   * unified queue so it cannot run concurrently with the user's own
   * Claude tasks. Classification itself still uses the isolated
   * `_email_processor` session inside emailProcessor.process so the
   * user's transcript stays clean.
   */
  enqueueEmailProcess(sessionKey: string, chatId: string, emails: RawEmail[], account: EmailAccount, sessionDir: string): void {
    if (emails.length === 0) return;
    void this.enqueueOrRunJob({ kind: 'claude-email-process', sessionKey, chatId, emails, account, sessionDir });
  }

  /**
   * Run a queued email-process Job. Holds the user sessionKey lock so
   * the LLM-based spam filter does not contend with the user's own
   * Claude tasks for the same session.
   */
  private async runEmailProcessJob(job: Extract<Job, { kind: 'claude-email-process' }>): Promise<void> {
    const { sessionKey, chatId, emails, account, sessionDir } = job;
    if (!this.emailProcessor) {
      this.logger.error({ sessionKey, accountId: account.id }, 'emailProcessor not set — dropping job');
      return;
    }

    this.runningTasks.add(sessionKey);
    try {
      const processed = await this.emailProcessor.process(emails, account, sessionDir);
      const toNotify = processed.filter(e => !e.isSpam);
      if (toNotify.length > 0) {
        const text = formatPushNotification(toNotify);
        await this.sender.sendReply(chatId, text);
      }
      const spamCount = processed.length - toNotify.length;
      if (spamCount > 0) {
        this.logger.debug({ sessionKey, accountId: account.id, spamCount }, 'Filtered spam emails');
      }
    } catch (err) {
      this.logger.error({ err, sessionKey, accountId: account.id }, 'Email process job failed');
    } finally {
      this.runningTasks.delete(sessionKey);
      await this.processQueue(sessionKey);
    }
  }

  /** Set the MemberManager for per-user profile tracking. */
  setMemberManager(mgr: MemberManager): void {
    this.memberMgr = mgr;
  }

  /** Set the WeChat bridge for dual-send and message routing. */
  setWechatBridge(bridge: WechatBridge): void {
    this.wechatBridge = bridge;
    this.commandHandler.setWechatBridge(bridge);
    // Register callback for WeChat → Claude message routing
    bridge.onWechatMessage(async (sessionKey, text, wechatUserId, attachments) => {
      await this.handleWechatMessage(sessionKey, text, wechatUserId, attachments);
    });
  }

  /** Set the Admin Chat server for three-way echo and message routing. */
  setAdminChat(adminChat: import('../admin/admin-chat.js').AdminChatServer): void {
    this.adminChat = adminChat;
    adminChat.onMessage = async (sessionKey: string, text: string, echo: boolean, showSource: boolean) => {
      await this.handleAdminChatMessage(sessionKey, text, echo, showSource);
    };
    adminChat.onSendAsSigma = async (sessionKey: string, text: string, addToContext: boolean) => {
      await this.handleSendAsSigma(sessionKey, text, addToContext);
    };
  }

  /** Send a message directly as Sigma bot — no Claude processing, no queueing (admin manual action). */
  private async handleSendAsSigma(sessionKey: string, text: string, addToContext: boolean): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const chatIdFile = path.join(session.sessionDir, 'chat-id');
    let chatId = '';
    try { chatId = fs.readFileSync(chatIdFile, 'utf-8').trim(); } catch { /* ignore */ }
    if (!chatId) {
      this.logger.warn({ sessionKey }, 'No chat-id for Send as Sigma');
      return;
    }

    this.logger.info({ sessionKey, textLen: text.length, addToContext }, 'Send as Sigma');

    // Send to Feishu as Sigma bot
    await this.sender.sendReply(chatId, text, undefined, session.sessionDir);

    // Send to WeChat if bound
    if (this.wechatBridge?.isActive(sessionKey)) {
      this.wechatBridge.sendToWechat(sessionKey, text).catch(err => {
        this.logger.warn({ err, sessionKey }, 'Failed to send Sigma message to WeChat');
      });
    }

    // Optionally add to context (as bot message, not user message)
    if (addToContext) {
      if (!this.groupContext['buffers'].has(chatId)) {
        this.groupContext.load(session.sessionDir, chatId);
      }
      this.groupContext.add(chatId, {
        timestamp: Date.now(),
        senderName: 'Sigma',
        senderId: 'bot',
        text: '(Send as Sigma)',
        botReply: text.length > 500 ? text.slice(0, 500) + '...' : text,
      });
      this.groupContext.save(session.sessionDir, chatId);
    }
  }

  /** Handle a message from Admin Chat — route through unified queue. */
  private async handleAdminChatMessage(sessionKey: string, text: string, echo: boolean, showSource: boolean): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const chatIdFile = path.join(session.sessionDir, 'chat-id');
    let chatId = '';
    try { chatId = fs.readFileSync(chatIdFile, 'utf-8').trim(); } catch { /* ignore */ }
    if (!chatId) {
      this.logger.warn({ sessionKey }, 'No chat-id for admin chat routing');
      this.adminChat?.sendError(sessionKey, 'No chat-id found for this session');
      return;
    }
    await this.enqueueOrRunJob({ kind: 'claude-admin-chat', sessionKey, chatId, text, echo, showSource });
  }

  /** Handle a message from WeChat — route through unified queue. */
  private async handleWechatMessage(sessionKey: string, text: string, wechatUserId: string, attachments?: import('../wechat/wechat-bridge.js').WechatAttachment[]): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const chatIdFile = path.join(session.sessionDir, 'chat-id');
    let chatId = '';
    try { chatId = fs.readFileSync(chatIdFile, 'utf-8').trim(); } catch { /* ignore */ }
    if (!chatId) {
      this.logger.warn({ sessionKey }, 'No chat-id for WeChat message routing');
      return;
    }

    // Build prompt with sender context
    const userId = sessionKey.replace('dm_', '');
    const senderName = this.resolveSenderName(undefined, userId);
    const mcpHint = getFeishuMcpHint(session.sessionDir, userId);
    const safeName = senderName.replace(/[\n\r\]]/g, ' ');
    const safeId = userId.replace(/[\n\r\]]/g, '');
    const prompt = `[发送者: ${safeName} | id: ${safeId}]${mcpHint}\n${text}`;

    // Build image attachments for Claude (vision)
    let images: ImageAttachment[] | undefined;
    if (attachments) {
      const imgAtts = attachments.filter(a => a.base64 && a.mediaType.startsWith('image/'));
      if (imgAtts.length > 0) {
        images = imgAtts.map(a => ({ base64: a.base64!, mediaType: a.mediaType }));
      }
    }

    await this.enqueueOrRunJob({ kind: 'claude-wechat', sessionKey, chatId, prompt, images });
    // Echo + group context recording happen inside runWechatJob just before Claude runs,
    // so they are correctly ordered with respect to other jobs in the queue.
    // Capture the original wechat text so it can be picked up at run time.
    this.wechatPendingEcho.set(sessionKey, text);
  }

  /** Resolve a display name: event name → member profile name → fallback. */
  private resolveSenderName(eventName: string | undefined, userId: string): string {
    if (eventName) return eventName;
    if (this.memberMgr) {
      const member = this.memberMgr.get(userId);
      if (member?.name && member.name !== userId) return member.name;
    }
    return '未知用户';
  }

  /**
   * Extract all <<REACT:emoji>> tags from text, send reactions, return text with tags stripped.
   * REACT is an annotation — can coexist with text and tool calls.
   */
  private async processReactions(text: string, messageId: string): Promise<string> {
    const pattern = /<{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*/gi;
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) return text;
    for (const match of matches) {
      this.typing.start(messageId, match[1]).catch(() => {});
      this.logger.info({ messageId, emojiType: match[1] }, 'Sending reaction');
    }
    return text.replace(pattern, '').trim();
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

    // For interactive (card) messages — event payload may be truncated.
    // Fetch full content via API (esp. for forwarded emails).
    if (msg.messageType === 'interactive') {
      try {
        const fullText = await this.sender.fetchMessageText(msg.messageId);
        if (fullText && fullText.length > msg.text.length) {
          this.logger.info({ messageId: msg.messageId, oldLen: msg.text.length, newLen: fullText.length }, 'Fetched full interactive content');
          msg.text = fullText;
        }
      } catch (err) {
        this.logger.warn({ err, messageId: msg.messageId }, 'Failed to fetch full interactive content');
      }
    }

    const sessionKey = SessionManager.getSessionKey(msg.chatType, msg.userId, msg.chatId);

    // Persist chatId mapping for cron job delivery (DM sessionKey can't derive chatId)
    const session = this.sessionMgr.getOrCreate(sessionKey);
    try {
      fs.writeFileSync(path.join(session.sessionDir, 'chat-id'), msg.chatId);
    } catch { /* ignore */ }

    // Check if session is muted (admin-only toggle)
    try {
      if (fs.existsSync(path.join(session.sessionDir, 'muted'))) {
        this.logger.debug({ sessionKey }, 'Session muted, ignoring message');
        return;
      }
    } catch { /* ignore */ }

    // Check if individual member is muted (across all sessions)
    try {
      if (fs.existsSync(path.join(session.sessionDir, 'members', msg.userId, 'muted'))) {
        this.logger.debug({ sessionKey, userId: msg.userId }, 'Member muted, ignoring message');
        return;
      }
    } catch { /* ignore */ }

    // Ensure member exists (sync already creates most, this is fallback for new users)
    if (this.memberMgr && msg.userId.startsWith('ou_')) {
      const existing = this.memberMgr.get(msg.userId);
      if (!existing) {
        // New user not yet synced — resolve name via API
        const resolvedName = await this.sender.resolveUserName(msg.userId) || msg.senderName || null;
        this.memberMgr.getOrCreate(msg.userId, resolvedName || msg.userId);
      } else if (existing.name === msg.userId && msg.senderName) {
        // Has profile but no real name yet — update from event
        this.memberMgr.update(msg.userId, { name: msg.senderName });
      }
      this.memberMgr.addSession(msg.userId, sessionKey);
    }

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

    // Check if session is busy — silently queue message (FIFO, processed when current task ends)
    if (this.runningTasks.has(sessionKey)) {
      const queued = this.queue.enqueue(sessionKey, { kind: 'claude-user-msg', sessionKey, msg });
      if (queued) {
        this.logger.info(
          { sessionKey, isMentioned: msg.isMentioned, queueSize: this.queue.queueSize(sessionKey) },
          'Message queued (session busy)',
        );
      } else {
        // Queue full — still record non-@mention in context buffer
        if (!msg.isMentioned && msg.chatType === 'group') {
          const session = this.sessionMgr.getOrCreate(sessionKey);
          if (!this.groupContext['buffers'].has(msg.chatId)) {
            this.groupContext.load(session.sessionDir, msg.chatId);
          }
          this.groupContext.add(msg.chatId, {
            timestamp: Date.now(),
            senderName: this.resolveSenderName(msg.senderName, msg.userId),
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

    // Auto-reply check: buffer non-@mention messages when appropriate
    if (msg.chatType === 'group' && !msg.isMentioned) {
      let autoReply = 'on';
      try { autoReply = fs.readFileSync(path.join(session.sessionDir, 'auto-reply'), 'utf-8').trim(); } catch {}

      // Skip without sending to Claude:
      // 1. auto=off: all non-@bot messages are buffered
      // 2. auto=on but message @mentions others (not bot): clearly not for Sigma
      const shouldBuffer = autoReply === 'off' || (autoReply === 'on' && msg.hasMentions);
      if (shouldBuffer) {
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: this.resolveSenderName(msg.senderName, msg.userId),
          senderId: msg.userId,
          text: msg.text,
        });
        this.groupContext.save(session.sessionDir, msg.chatId);
        return;
      }
    }

    // Store Feishu message for combined WeChat echo+reply (sent after Claude replies)
    if (this.wechatBridge?.isActive(sessionKey) && msg.chatType === 'p2p') {
      this.feishuPendingEcho.set(sessionKey, msg.text);
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

    // Thread reply: only follow thread if message is actually in a thread (has thread_id).
    // root_id alone may just be from quote-reply (not a real thread).
    const existingRootId = msg.threadId ? msg.rootId : undefined;
    let threadRootId: string | undefined = existingRootId;

    // Start typing indicator (THINKING emoji for non-@mention, normal for @mention)
    const reactionId = await this.typing.start(msg.messageId, isNonMentionGroup ? 'THINKING' : undefined);

    try {
      // Resolve user name: member profile (already created in handleMessage), then fallback
      let userName: string | null = null;
      if (this.memberMgr) {
        const member = this.memberMgr.get(msg.userId);
        if (member?.name && member.name !== msg.userId) userName = member.name;
      }
      if (!userName) userName = msg.senderName || null;
      // Build prompt with context
      let prompt = msg.text;

      // Add user identity prefix (for group chats or general context)
      if (userName) {
        const mcpHint = getFeishuMcpHint(session.sessionDir, msg.userId);
        const safeUserName = userName.replace(/[\n\r\]]/g, ' ');
        const safeMsgUserId = msg.userId.replace(/[\n\r\]]/g, '');
        prompt = `[发送者: ${safeUserName} | id: ${safeMsgUserId}]${mcpHint ? ' ' + mcpHint : ''} ${prompt}`;
      }

      // Inject MEMBER.md (per-user profile, via symlinked members/ dir)
      try {
        const memberMdPath = path.join(session.sessionDir, 'members', msg.userId, 'MEMBER.md');
        if (fs.existsSync(memberMdPath)) {
          const memberMd = fs.readFileSync(memberMdPath, 'utf-8').trim();
          if (memberMd && memberMd.length > 50) { // skip near-empty templates
            const truncated = memberMd.length > 1000 ? memberMd.slice(0, 1000) + '\n...(truncated)' : memberMd;
            prompt = `[用户档案]\n${truncated}\n[/用户档案]\n\n${prompt}`;
          }
        }
      } catch { /* ignore */ }

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
          prompt = `[群聊消息，未@你。请从第一个 token 开始判断：不需要回复（闲聊、表情、"好的/收到"等无关消息）→ 只输出 NO_REPLY；以下情况正常回复：有人提问、下达指令或任务、用户的消息与你上一条回复高度相关（追问/补充/确认）、讨论你擅长的话题、提到 Sigma。]\n${prompt}`;
        } else {
          prompt = `[你被@提及，必须回复]\n${prompt}`;
        }

        // Record + mark sent (for admin dashboard + missed message tracking)
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: userName || this.resolveSenderName(msg.senderName, msg.userId),
          senderId: msg.userId,
          text: msg.text,
        });
        this.groupContext.markSent(msg.chatId);
      } else if (msg.chatType === 'p2p') {
        // Record DM message (for admin dashboard only)
        this.groupContext.add(msg.chatId, {
          timestamp: Date.now(),
          senderName: userName || this.resolveSenderName(msg.senderName, msg.userId),
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

      // Execute and reply using the shared pipeline
      await this.executeAndReply({
        sessionKey,
        chatId: msg.chatId,
        prompt,
        sessionDir: session.sessionDir,
        replyToMessageId: msg.messageId,
        existingRootId,
        isNonMentionGroup,
        abortSignal: abortController.signal,
        images,
      });


    } catch (err) {
      this.logger.error({ err, sessionKey }, 'Failed to process message');
      await this.sender.sendReply(msg.chatId, '❌ 处理消息时出错，请重试', undefined, undefined, existingRootId);
    } finally {
      // Stop typing indicator and release lock
      await this.typing.stop(msg.messageId, reactionId);
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);

      // Process next queued message
      await this.processQueue(sessionKey);
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
      await this.sendMentionedFiles(msg.chatId, replyText, session.sessionDir, undefined, threadRootId, sessionKey);
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
   * Execute a cron job through the standard reply pipeline.
   * No typing indicator, no引用回复, no NO_REPLY injection.
   */
  async executeCronJob(sessionKey: string, chatId: string, prompt: string, jobName: string): Promise<void> {
    // Mute check happens here (before queueing) so muted sessions don't fill the queue
    try {
      const session = this.sessionMgr.getOrCreate(sessionKey);
      if (fs.existsSync(path.join(session.sessionDir, 'muted'))) {
        this.logger.info({ sessionKey, jobName }, 'Session muted, skipping cron job');
        return;
      }
    } catch { /* ignore */ }

    await this.enqueueOrRunJob({ kind: 'claude-cron', sessionKey, chatId, prompt, jobName });
  }

  /**
   * Public entry for non-user producers (cron, alert, wechat, admin chat,
   * IDLE email, agent unsolicited results). Routes the Job through the
   * unified per-session FIFO queue: runs immediately if no task is busy,
   * otherwise enqueues. Caller must not assume completion on return.
   */
  async enqueueOrRunJob(job: Job): Promise<void> {
    if (this.runningTasks.has(job.sessionKey)) {
      const queued = this.queue.enqueue(job.sessionKey, job);
      if (queued) {
        this.logger.info(
          { sessionKey: job.sessionKey, kind: job.kind, queueSize: this.queue.queueSize(job.sessionKey) },
          'Job queued (session busy)',
        );
      } else {
        this.logger.warn({ sessionKey: job.sessionKey, kind: job.kind }, 'Job dropped — queue full');
      }
      return;
    }
    // No task running — execute immediately. runJob's per-kind handler
    // owns the runningTasks lock + finally processQueue chain.
    await this.runJob(job);
  }

  /**
   * Run a queued cron Job. Holds runningTasks lock for the session.
   */
  private async runCronJob(job: Extract<Job, { kind: 'claude-cron' }>): Promise<void> {
    const { sessionKey, chatId, prompt, jobName } = job;
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const cronPrompt = `[定时任务执行: ${jobName}] ${prompt}\n[这是定时任务，必须输出实际文字内容发送给用户]`;

    this.logger.info({ sessionKey, jobName }, 'Executing cron job via reply pipeline');

    this.runningTasks.add(sessionKey);
    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    try {
      await this.executeAndReply({
        sessionKey,
        chatId,
        prompt: cronPrompt,
        sessionDir: session.sessionDir,
        replyToMessageId: undefined,
        existingRootId: undefined,
        isNonMentionGroup: false,
        isCronJob: true,
        abortSignal: abortController.signal,
      });
    } catch (err) {
      this.logger.error({ err, sessionKey, jobName }, 'Cron job execution failed');
      try {
        await this.sender.sendReply(chatId, `⚠️ 定时任务 **${jobName}** 执行失败: ${(err as Error).message}`);
      } catch { /* ignore */ }
    } finally {
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);
      await this.processQueue(sessionKey);
    }
  }

  /**
   * Run a queued WeChat Job. Holds runningTasks lock for the session.
   */
  private async runWechatJob(job: Extract<Job, { kind: 'claude-wechat' }>): Promise<void> {
    const { sessionKey, chatId, prompt, images } = job;
    const session = this.sessionMgr.getOrCreate(sessionKey);

    this.logger.info({ sessionKey, textLen: prompt.length }, 'Running WeChat job via reply pipeline');

    this.runningTasks.add(sessionKey);
    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    try {
      await this.executeAndReply({
        sessionKey,
        chatId,
        prompt,
        sessionDir: session.sessionDir,
        replyToMessageId: undefined,
        existingRootId: undefined,
        isNonMentionGroup: false,
        abortSignal: abortController.signal,
        images,
      });
    } catch (err) {
      this.logger.error({ err, sessionKey }, 'WeChat job execution failed');
    } finally {
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);
      await this.processQueue(sessionKey);
    }
  }

  /**
   * Run a queued Admin Chat Job. Holds runningTasks lock for the session.
   */
  private async runAdminChatJob(job: Extract<Job, { kind: 'claude-admin-chat' }>): Promise<void> {
    const { sessionKey, chatId, text, echo, showSource } = job;
    const session = this.sessionMgr.getOrCreate(sessionKey);

    this.logger.info({ sessionKey, textLen: text.length, echo }, 'Running admin chat job via reply pipeline');

    // Stash echo metadata for the streamer to consume after Claude replies
    this.adminChatPendingEcho.set(sessionKey, { text, echo, showSource });

    // Record admin message to group context (chat history persistence)
    if (!this.groupContext['buffers'].has(chatId)) {
      this.groupContext.load(session.sessionDir, chatId);
    }
    this.groupContext.add(chatId, {
      timestamp: Date.now(),
      senderName: 'Admin',
      senderId: 'admin',
      text,
    });
    this.groupContext.save(session.sessionDir, chatId);

    this.runningTasks.add(sessionKey);
    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    try {
      await this.executeAndReply({
        sessionKey,
        chatId,
        prompt: `<admin>${text}</admin>`,
        sessionDir: session.sessionDir,
        replyToMessageId: undefined,
        isNonMentionGroup: false,
        abortSignal: abortController.signal,
      });
    } catch (err) {
      this.logger.error({ err, sessionKey }, 'Admin chat job execution failed');
    } finally {
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);
      await this.processQueue(sessionKey);
    }
  }

  /**
   * Execute a card button action — sends the click as natural language to Claude.
   * Respects the same runningTasks queue as normal messages.
   */
  async executeButtonAction(sessionKey: string, chatId: string, actionId: string, label: string, userName: string, operatorId: string, cardId?: string, messageId?: string): Promise<void> {
    // Update original card immediately (disable buttons + show who clicked) — don't wait for queue
    if (cardId) {
      await this.updateCardButtonState(cardId, label, userName);
    }

    // If actionId is a slash command, route it through the command handler
    // (same path as if the user had typed it). This lets buttons trigger /model, /effort, etc.
    if (actionId?.startsWith('/')) {
      const handled = await this.commandHandler.handle(actionId, {
        chatId,
        messageId: messageId || '',
        sessionKey,
        userId: operatorId,
        senderName: userName,
      });
      if (handled) {
        this.logger.info({ sessionKey, actionId, userName }, 'Button routed to command handler');
        return;
      }
    }

    // Check if session is muted
    const session = this.sessionMgr.getOrCreate(sessionKey);
    try {
      if (fs.existsSync(path.join(session.sessionDir, 'muted'))) {
        this.logger.debug({ sessionKey }, 'Session muted, ignoring button action');
        return;
      }
    } catch { /* ignore */ }

    // If session is busy, queue the button action into the unified Job queue
    if (this.runningTasks.has(sessionKey)) {
      const queued = this.queue.enqueue(sessionKey, {
        kind: 'claude-button', sessionKey, chatId, actionId, label, userName, operatorId, cardId, messageId,
      });
      if (queued) {
        this.logger.info({ sessionKey, label, queueSize: this.queue.queueSize(sessionKey) }, 'Button action queued (session busy)');
      } else {
        this.logger.warn({ sessionKey, label }, 'Button action dropped — queue full');
      }
      return;
    }

    await this.runButtonAction(sessionKey, chatId, label, userName, messageId);
  }

  /**
   * Actually run a button action (called when session is free).
   */
  private async runButtonAction(sessionKey: string, chatId: string, label: string, userName: string, messageId?: string): Promise<void> {
    const session = this.sessionMgr.getOrCreate(sessionKey);
    const prompt = `[${userName} 点击了按钮: ${label}]`;

    this.logger.info({ sessionKey, label, userName, messageId }, 'Executing button action via reply pipeline');

    // Store button echo for WeChat dual-send
    if (this.wechatBridge?.isActive(sessionKey)) {
      this.feishuPendingEcho.set(sessionKey, `${userName} 点击了按钮: ${label}`);
    }

    this.runningTasks.add(sessionKey);
    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    // Add MeMeMe reaction to the card message (same as @bot messages)
    let reactionId: string | null = null;
    if (messageId) {
      reactionId = await this.typing.start(messageId);
    }

    try {
      await this.executeAndReply({
        sessionKey,
        chatId,
        prompt,
        sessionDir: session.sessionDir,
        replyToMessageId: messageId || undefined,
        existingRootId: undefined,
        isNonMentionGroup: false,
        abortSignal: abortController.signal,
      });
    } catch (err) {
      this.logger.error({ err, sessionKey, label }, 'Button action execution failed');
      await this.sender.sendReply(chatId, `⚠️ 按钮操作失败: ${(err as Error).message}`);
    } finally {
      // Remove typing indicator from card message
      if (messageId && reactionId) {
        await this.typing.stop(messageId, reactionId);
      }
      this.runningTasks.delete(sessionKey);
      this.abortControllers.delete(sessionKey);

      // Process next queued item (messages or button actions)
      await this.processQueue(sessionKey);
    }
  }

  /**
   * Update original card to disable callback buttons and show who clicked.
   * Link buttons (behaviors[0].type === 'open_url') stay enabled — they're stateless.
   * Modifies the clicked button label to "label@userName".
   */
  private async updateCardButtonState(cardId: string, clickedLabel: string, userName: string): Promise<void> {
    const cached = this.buttonCardCache.get(cardId);
    this.logger.info({ cardId, cacheHit: !!cached, cacheSize: this.buttonCardCache.size }, 'Button card cache lookup');
    if (!cached) {
      return;
    }

    try {
      const cardJson = JSON.parse(JSON.stringify(cached.cardJson)) as any; // deep clone
      const elements = cardJson?.body?.elements;
      if (!Array.isArray(elements)) return;

      // Find the column_set containing buttons and update them
      for (const el of elements) {
        if (el.tag === 'column_set' && Array.isArray(el.columns)) {
          for (const col of el.columns) {
            if (!Array.isArray(col.elements)) continue;
            for (const btn of col.elements) {
              if (btn.tag !== 'button') continue;
              const isLinkButton = btn.behaviors?.[0]?.type === 'open_url';
              if (!isLinkButton) {
                btn.disabled = true;
              }
              // Mark the clicked button with "label@userName"
              const btnLabel = btn.behaviors?.[0]?.value?.label || btn.text?.content;
              if (btnLabel === clickedLabel) {
                btn.text = { tag: 'plain_text', content: `${clickedLabel} @${userName}` };
                btn.type = 'primary'; // highlight the clicked one
              }
            }
          }
        }
      }

      const newSequence = cached.sequence + 1;
      await (this.sender.larkClient.cardkit as any).v1.card.update({
        path: { card_id: cardId },
        data: {
          card: { type: 'card_json', data: JSON.stringify(cardJson) },
          sequence: newSequence,
        },
      });
      cached.sequence = newSequence;
      this.logger.info({ cardId, clickedLabel, userName }, 'Updated card button state');
    } catch (err) {
      this.logger.warn({ err, cardId }, 'Failed to update card button state');
    }
  }

  /**
   * Shared reply pipeline: run Claude, stream results, send reply.
   * Used by both normal messages and cron jobs.
   */
  private async executeAndReply(opts: {
    sessionKey: string;
    chatId: string;
    prompt: string;
    sessionDir: string;
    replyToMessageId?: string;
    existingRootId?: string;
    isNonMentionGroup: boolean;
    abortSignal?: AbortSignal;
    images?: ImageAttachment[];
    isCronJob?: boolean;
  }): Promise<void> {
    const { sessionKey, chatId, prompt, sessionDir, replyToMessageId, existingRootId, isNonMentionGroup, abortSignal, images, isCronJob } = opts;

    this.logger.info({ sessionKey, isNonMentionGroup, isCronJob }, 'Entering reply pipeline');

    // If previous turn's card is still waiting for agents, finalize it now.
    const prevStreamer = this.activeStreamers.get(sessionKey);
    if (prevStreamer?.isWaitingForAgents()) {
      this.logger.info({ sessionKey }, 'New turn started — finalizing stale agent card from previous turn');
      prevStreamer.finalizeAfterAgents();
    }

    // Start WeChat typing indicator if bound
    if (this.wechatBridge?.isActive(sessionKey)) {
      this.wechatBridge.startTyping(sessionKey).catch(() => {});
    }

    const streamer = new CardStreamer(this.sender.larkClient, this.logger);
    this.activeStreamers.set(sessionKey, streamer);

    // Pass session info to streamer for button rendering + card cache
    streamer.sessionKey = sessionKey;
    streamer.sessionDir = sessionDir;
    streamer.chatId = chatId;
    streamer.buttonCardCache = this.buttonCardCache;

    let cardCreated = false;
    let cardCreating = false;
    let bufferedText = '';

    const ensureCard = () => {
      if (cardCreated || cardCreating) return;
      cardCreating = true;
      this.logger.info({ sessionKey }, 'Creating streaming card');
      const p = streamer.start(chatId, replyToMessageId, existingRootId, replyToMessageId).then(() => {
        cardCreating = false;
        cardCreated = true;
        if (bufferedText) streamer.updateText(bufferedText);
      });
      streamer.startPromise = p;
    };

    const onText = (key: string, text: string, liveUsage?: LiveUsage & { model?: string }) => {
      if (key !== sessionKey) return;
      bufferedText = text;
      if (liveUsage) streamer.updateLiveUsage(liveUsage);
      if (cardCreated && !cardCreating) {
        streamer.updateText(text);
      }
    };
    const onTool = (key: string, event: { type: 'start' | 'end'; toolName: string; toolInput?: string; toolUseId?: string; isError?: boolean }) => {
      if (key !== sessionKey) return;
      if (event.type === 'start' && !cardCreated && !cardCreating) {
        ensureCard();
      }
      if (event.type === 'start') {
        streamer.addToolCall(event.toolName, event.toolInput, event.toolUseId);
      } else if (event.type === 'end' && event.toolUseId) {
        streamer.updateToolCall(event.toolUseId, event.isError ? 'failed' : 'complete');
      }
    };
    const onThinking = (key: string, thinking: string) => {
      if (key !== sessionKey) return;
      if (!cardCreated && !cardCreating) ensureCard();
      streamer.addThinking(thinking);
    };
    this.runner.onTextStream(sessionKey, onText);
    this.runner.onToolStream(sessionKey, onTool);
    this.runner.onThinkingStream(sessionKey, onThinking);

    // Track running subagents — only real background agents (local_agent), not background bash tasks
    const runningAgents = new Map<string, { toolUseId?: string; description?: string }>();
    this.runner.onSubagentStream(sessionKey, (_key, event) => {
      if (event.type === 'started') {
        // Only track local_agent as a real background agent that should block card completion.
        // local_bash and other task types complete within the same turn and don't need waiting.
        if (event.taskType && event.taskType !== 'local_agent') return;
        runningAgents.set(event.taskId, { toolUseId: event.toolUseId, description: event.description });
        if (event.toolUseId) streamer.registerSubagent(event.taskId, event.toolUseId);
      } else if (event.type === 'progress') {
        if (event.toolName) streamer.addSubagentStep(event.taskId, event.toolName, event.description);
      } else {
        const agent = runningAgents.get(event.taskId);
        runningAgents.delete(event.taskId);
        streamer.completeSubagentSteps(event.taskId);
        if (agent?.toolUseId) streamer.updateToolCall(agent.toolUseId, event.type === 'completed' ? 'complete' : 'failed');
        if (runningAgents.size === 0 && streamer.isWaitingForAgents()) {
          this.logger.info({ sessionKey }, 'All subagents completed, finalizing card');
          streamer.finalizeAfterAgents();
          this.runner.onSubagentStream(sessionKey, undefined);
        }
      }
    });

    try {
      const result = await this.runner.run({
        sessionKey,
        message: prompt + TITLE_INSTRUCTION,
        sessionDir,
        abortSignal,
        images,
      });

      const isFromWechat = this.wechatPendingEcho.has(sessionKey);
      const isFromAdmin = this.adminChatPendingEcho.has(sessionKey);

      let rawText = result.fullText || '';
      // Process <<REACT:emoji>> — send reactions only if there's a real message to react to
      // For WeChat/Admin messages: keep REACT tags, apply them after the echo is sent
      if (replyToMessageId) {
        rawText = await this.processReactions(rawText, replyToMessageId);
      } else if (!isFromWechat && !isFromAdmin) {
        // Cron job or other no-reply context: strip REACT tags
        rawText = rawText.replace(/<{1,2}\s*REACT\s*[:：]\s*\w+\s*>{1,2}\s*/gi, '').trim();
      }
      // For isFromWechat: REACT tags stay in rawText, extracted later in dual-send
      const replyText = rawText.replace(/<{1,2}\s*THREAD\s*>{1,2}\s*/gi, '').trim();
      const streamRootId = existingRootId;
      const cleanText = replyText;

      if (isNoReply(replyText) || (!cardCreated && !cardCreating && isNonMentionGroup && !replyText) || (!cardCreated && !cardCreating && !replyText)) {
        // NO_REPLY or empty text without card — finalize card if it was already created
        if (cardCreated || cardCreating) {
          if (streamer.startPromise) await streamer.startPromise;
          await streamer.complete(bufferedText || '(无回复)');
        }
      } else if (isFromWechat && cardCreated) {
        // WeChat message with tools → card already streaming on Feishu.
        // Complete the card with echo prepended, no separate text message needed.
        const wechatEchoText = this.wechatPendingEcho.get(sessionKey);
        const echoPrefix = wechatEchoText ? `> [来自微信] ${wechatEchoText}\n\n` : '';
        await streamer.complete(echoPrefix + rawText || '(空回复)', {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          peakCallInputTokens: result.peakCallInputTokens,
          peakCallCacheReadTokens: result.peakCallCacheReadTokens,
          peakCallCacheCreationTokens: result.peakCallCacheCreationTokens,
          model: result.model,
          costUsd: result.costUsd,
        });
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, undefined, sessionKey);
        this.wechatPendingEcho.delete(sessionKey); // consumed by card, skip dual-send Feishu
        this.runner.onSubagentStream(sessionKey, undefined);
      } else if (isFromWechat) {
        // WeChat message without tools → no card, dual-send handles combined Feishu message.
        this.logger.info({ sessionKey, textLen: cleanText.length }, 'WeChat message — Feishu reply deferred to dual-send');
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, undefined, sessionKey);
        this.runner.onSubagentStream(sessionKey, undefined);
      } else if (isFromAdmin) {
        // Admin chat message → Feishu reply deferred to echo in finally block (if echo enabled)
        this.logger.info({ sessionKey, textLen: cleanText.length }, 'Admin chat — Feishu reply deferred to echo');
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, undefined, sessionKey);
        this.runner.onSubagentStream(sessionKey, undefined);
      } else if (runningAgents.size > 0) {
        if (!cardCreated) ensureCard();
        if (streamer.startPromise) await streamer.startPromise;
        streamer.completeTextOnly(rawText || '(空回复)');
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, streamRootId, sessionKey);
        this.logger.info({ sessionKey, runningAgents: runningAgents.size }, 'Turn done but agents still running');
        setTimeout(() => {
          if (streamer.isWaitingForAgents()) {
            this.logger.warn({ sessionKey }, 'Agent timeout — finalizing card');
            streamer.finalizeAfterAgents();
            this.runner.onSubagentStream(sessionKey, undefined);
          }
        }, 30 * 60 * 1000);
      } else if (!cardCreated && !cardCreating && !rawText.includes('<<BUTTON:')) {
        // No card, no buttons — send as plain text
        this.logger.info({ sessionKey, textLen: cleanText.length }, 'No tools used, sending plain text reply');
        await this.sender.sendReply(chatId, cleanText || '(空回复)', replyToMessageId, sessionDir, streamRootId);
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, streamRootId, sessionKey);
        this.runner.onSubagentStream(sessionKey, undefined);
      } else {
        // Card exists (or in flight), or buttons present — complete as card
        if (!cardCreated) {
          // Card still being created (race) or buttons present without card — wait/create
          if (!cardCreating) ensureCard();
          if (streamer.startPromise) await streamer.startPromise;
        }
        await streamer.complete(rawText || '(空回复)', {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          peakCallInputTokens: result.peakCallInputTokens,
          peakCallCacheReadTokens: result.peakCallCacheReadTokens,
          peakCallCacheCreationTokens: result.peakCallCacheCreationTokens,
          model: result.model,
          costUsd: result.costUsd,
        });
        await this.sendMentionedFiles(chatId, cleanText, sessionDir, undefined, streamRootId, sessionKey);
        this.runner.onSubagentStream(sessionKey, undefined);
      }

      // Write bot reply to context buffer
      const cleanReply = replyText.replace(/<{1,2}\s*THREAD\s*>{1,2}\s*/gi, '');
      if (cleanReply && !isNoReply(cleanReply)) {
        if (!this.groupContext['buffers'].has(chatId)) {
          this.groupContext.load(sessionDir, chatId);
        }
        const entries = this.groupContext['buffers'].get(chatId);
        if (isCronJob) {
          // Cron: add as new context entry
          this.groupContext.add(chatId, {
            timestamp: Date.now(),
            senderName: `⏰ 定时任务`,
            text: prompt,
            botReply: cleanReply.length > 500 ? cleanReply.slice(0, 500) + '...' : cleanReply,
          });
        } else if (entries && entries.length > 0) {
          entries[entries.length - 1].botReply = cleanReply.length > 500
            ? cleanReply.slice(0, 500) + '...' : cleanReply;
        }
        this.groupContext.save(sessionDir, chatId);
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        this.logger.info({ sessionKey }, 'Task stopped by user');
        await streamer.complete(streamer.getCurrentText() || '⏹ 任务已中止');
      } else {
        this.logger.error({ err, sessionKey }, 'Reply pipeline failed');
        await streamer.abort(`❌ 出错了: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.runner.onSubagentStream(sessionKey, undefined);
    } finally {
      this.runner.onTextStream(sessionKey, undefined);
      this.runner.onToolStream(sessionKey, undefined);
      this.runner.onThinkingStream(sessionKey, undefined);

      // Admin echo info — read early so WeChat dual-send can check it
      const adminEchoInfo = this.adminChatPendingEcho.get(sessionKey);
      this.adminChatPendingEcho.delete(sessionKey);

      // WeChat dual-send (skip if message is from admin — admin echo handles WeChat separately)
      if (this.wechatBridge?.isActive(sessionKey) && bufferedText && !isNoReply(bufferedText) && !adminEchoInfo) {
        const wechatEcho = this.wechatPendingEcho.get(sessionKey);
        const feishuEcho = this.feishuPendingEcho.get(sessionKey);
        this.wechatPendingEcho.delete(sessionKey);
        this.feishuPendingEcho.delete(sessionKey);

        if (wechatEcho) {
          // Message from WeChat → send reply to WeChat + combined echo+reply to Feishu
          this.wechatBridge.sendToWechat(sessionKey, bufferedText).catch(err => {
            this.logger.warn({ err, sessionKey }, 'Failed to send reply to WeChat');
          });
          // Strip REACT tags from display text, collect them for the Feishu message
          const reactPattern = /<{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*/gi;
          const reactEmojis: string[] = [];
          let displayText = bufferedText.replace(reactPattern, (_, emoji) => { reactEmojis.push(emoji); return ''; }).trim();
          const combined = `> [来自微信] ${wechatEcho}\n\n${displayText}`;
          this.sender.sendReply(chatId, combined, undefined, sessionDir, undefined, { sessionKey, chatId }).then(msgId => {
            // Apply REACT emojis to the sent Feishu echo message
            if (msgId && reactEmojis.length > 0) {
              for (const emoji of reactEmojis) {
                this.processReactions(`<<REACT:${emoji}>>`, msgId).catch(() => {});
              }
            }
          }).catch(err => {
            this.logger.warn({ err, sessionKey }, 'Failed to send combined WeChat echo to Feishu');
          });
        } else {
          // Message from Feishu → send combined echo+reply to WeChat
          if (feishuEcho) {
            // Strip markers from reply, then combine with echo prefix
            this.wechatBridge.sendToWechat(sessionKey, `\`[来自飞书] ${feishuEcho}\`\n\n${bufferedText}`).catch(err => {
              this.logger.warn({ err, sessionKey }, 'Failed to send reply to WeChat');
            });
          } else {
            this.wechatBridge.sendToWechat(sessionKey, bufferedText).catch(err => {
              this.logger.warn({ err, sessionKey }, 'Failed to send reply to WeChat');
            });
          }
        }
      }

      // Admin Chat echo

      if (bufferedText && !isNoReply(bufferedText)) {
        // Echo TO admin (when message is from Feishu/WeChat)
        if (this.adminChat?.isConnected(sessionKey) && !adminEchoInfo) {
          const wEcho = this.wechatPendingEcho.get(sessionKey);
          const fEcho = this.feishuPendingEcho.get(sessionKey);
          const source = wEcho ? '微信' : '飞书';
          const originalText = wEcho || fEcho || '';
          if (originalText) {
            this.adminChat.sendEcho(sessionKey, source, originalText, bufferedText);
          } else {
            this.adminChat.sendToAdmin(sessionKey, bufferedText);
          }
        }

        // Echo FROM admin to Feishu + WeChat (when echo checkbox was on)
        if (adminEchoInfo?.echo) {
          // Extract REACT tags before building display text
          const reactPattern = /<{1,2}\s*REACT\s*[:：]\s*(\w+)\s*>{1,2}\s*/gi;
          const reactEmojis: string[] = [];
          const cleanReply = bufferedText.replace(reactPattern, (_, emoji) => { reactEmojis.push(emoji); return ''; }).trim();

          // showSource: true → "[ECHO] 原文\n\n回复", false → 仅回复
          const feishuText = adminEchoInfo.showSource
            ? `> [ECHO] ${adminEchoInfo.text}\n\n${cleanReply}`
            : cleanReply;
          const wechatText = adminEchoInfo.showSource
            ? `\`[ECHO] ${adminEchoInfo.text}\`\n\n${cleanReply}`
            : cleanReply;

          this.sender.sendReply(chatId, feishuText, undefined, sessionDir, undefined, { sessionKey, chatId }).then(msgId => {
            // Apply REACT emojis to the sent Feishu echo message
            if (msgId && reactEmojis.length > 0) {
              for (const emoji of reactEmojis) {
                this.processReactions(`<<REACT:${emoji}>>`, msgId).catch(() => {});
              }
            }
          }).catch(err => {
            this.logger.warn({ err, sessionKey }, 'Failed to send admin echo to Feishu');
          });
          if (this.wechatBridge?.isActive(sessionKey)) {
            this.wechatBridge.sendToWechat(sessionKey, wechatText).catch(err => {
              this.logger.warn({ err, sessionKey }, 'Failed to send admin echo to WeChat');
            });
          }
        }
      }

      const pipelineElapsed = Date.now() - streamer['startTime'];
      const replyMode = cardCreated ? 'card' : (bufferedText ? 'text' : 'empty');
      this.logger.info({ sessionKey, replyMode, elapsed: pipelineElapsed, isCronJob }, 'Reply pipeline done');
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
    sessionKey?: string,
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

        // Skip very large files (> 30MB, Feishu IM upload API limit)
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

        // Also send to WeChat if bound
        if (sessionKey && this.wechatBridge?.isActive(sessionKey)) {
          this.wechatBridge.sendFileToWechat(sessionKey, filePath).catch(err => {
            this.logger.warn({ err, filePath }, 'Failed to send file to WeChat');
          });
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to send mentioned files');
    }
  }

  /**
   * Dequeue the next Job for a session and dispatch by kind.
   * Single FIFO queue covers all Job kinds — messages, buttons, cron, alert,
   * wechat, admin-chat, and broadcast — so they reach the user in order.
   */
  private async processQueue(sessionKey: string): Promise<void> {
    const job = this.queue.dequeue(sessionKey);
    if (!job) return;
    await this.runJob(job);
  }

  /**
   * Execute a single Job. Caller must ensure runningTasks lock is not held
   * by another task in the same session.
   */
  private async runJob(job: Job): Promise<void> {
    this.logger.info({ sessionKey: job.sessionKey, kind: job.kind }, 'Running job');
    switch (job.kind) {
      case 'claude-user-msg':
        await this.executeMessage(job.msg, job.sessionKey);
        return;
      case 'claude-button':
        await this.runButtonAction(job.sessionKey, job.chatId, job.label, job.userName, job.messageId);
        return;
      case 'claude-cron':
        await this.runCronJob(job);
        return;
      case 'claude-wechat':
        await this.runWechatJob(job);
        return;
      case 'claude-admin-chat':
        await this.runAdminChatJob(job);
        return;
      case 'claude-email-process':
        await this.runEmailProcessJob(job);
        return;
      // Phase 3c will add: claude-alert. Pure broadcasts (Alert
      // message_only, agent results, admin-as-sigma) intentionally
      // bypass the queue — they are <200ms sends that must reach the
      // user immediately and don't risk Claude concurrency.
      default:
        this.logger.error({ kind: (job as Job).kind }, 'Unhandled job kind — Phase 3 not yet wired');
        return;
    }
  }
}
