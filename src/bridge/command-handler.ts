import * as fs from 'node:fs';
import type { MessageSender } from '../feishu/message-sender.js';
import type { SessionManager } from '../claude/session-manager.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { Logger } from '../utils/logger.js';
import { AccountStore } from '../email/account-store.js';
import { loadRules, saveRules } from '../email/email-processor.js';
import type { EmailSetup } from './email-setup.js';
import type { IdleMonitor } from '../email/idle-monitor.js';

export interface CommandContext {
  chatId: string;
  messageId: string;
  sessionKey: string;
  userId: string;
  senderName?: string;
}

/**
 * Handles slash commands from Feishu messages.
 * Returns true if the message was a command (handled), false otherwise.
 */
export class CommandHandler {
  private emailSetup: EmailSetup | null = null;
  private idleMonitor: IdleMonitor | null = null;

  constructor(
    private sender: MessageSender,
    private sessionMgr: SessionManager,
    private runner: ClaudeRunner,
    private runningTasks: Set<string>,
    private abortControllers: Map<string, AbortController>,
    private logger: Logger,
  ) {}

  setEmailSetup(setup: EmailSetup): void {
    this.emailSetup = setup;
  }

  setIdleMonitor(monitor: IdleMonitor): void {
    this.idleMonitor = monitor;
  }

  async handle(text: string, ctx: CommandContext): Promise<boolean> {
    const cmd = text.trim().toLowerCase();

    if (cmd === '/new') {
      return this.handleNew(ctx);
    }
    if (cmd === '/stop') {
      return this.handleStop(ctx);
    }
    if (cmd === '/status') {
      return this.handleStatus(ctx);
    }
    if (cmd === '/help') {
      return this.handleHelp(ctx);
    }
    if (cmd.startsWith('/email')) {
      return this.handleEmail(text.trim(), ctx);
    }
    if (cmd === '/register') {
      return this.handleRegister(ctx);
    }
    if (cmd === '/auto' || cmd.startsWith('/auto ')) {
      return this.handleAuto(text.trim(), ctx);
    }

    return false;
  }

  private async handleNew(ctx: CommandContext): Promise<boolean> {
    // Kill process + clear sessionId → next message spawns fresh (no --resume)
    this.runner.reset(ctx.sessionKey);
    await this.sender.sendText(
      ctx.chatId,
      '✅ 上下文已清空，开始新对话。记忆和文件保留。（下条消息需要短暂启动）',
      ctx.messageId,
    );
    this.logger.info({ sessionKey: ctx.sessionKey }, '/new: process reset, no resume');
    return true;
  }

  private async handleStop(ctx: CommandContext): Promise<boolean> {
    const controller = this.abortControllers.get(ctx.sessionKey);
    if (controller) {
      // Send SIGINT first — Claude Code will stop current turn and emit a result.
      // The abortController then cancels the message-bridge wait loop.
      this.runner.abort(ctx.sessionKey);
      controller.abort();
      await this.sender.sendText(ctx.chatId, '⏹ 已中止当前任务', ctx.messageId);
      this.logger.info({ sessionKey: ctx.sessionKey }, '/stop: task aborted');
    } else {
      await this.sender.sendText(ctx.chatId, 'ℹ️ 当前没有运行中的任务', ctx.messageId);
    }
    return true;
  }

  private async handleStatus(ctx: CommandContext): Promise<boolean> {
    const session = this.sessionMgr.get(ctx.sessionKey);
    const isRunning = this.runningTasks.has(ctx.sessionKey);
    const activeProcs = this.runner.activeCount;

    const lines = [
      `**会话状态**`,
      `- 会话: \`${ctx.sessionKey}\``,
      `- 常驻进程: ${isRunning ? '运行中' : '待命'}`,
      `- 当前任务: ${isRunning ? '运行中' : '空闲'}`,
      `- 全局活跃进程: ${activeProcs}`,
    ];

    await this.sender.sendReply(ctx.chatId, lines.join('\n'), ctx.messageId);
    return true;
  }

  private async handleEmail(text: string, ctx: CommandContext): Promise<boolean> {
    const parts = text.split(/\s+/);
    const sub = parts[1]?.toLowerCase() || '';
    const arg = parts.slice(2).join(' ');

    const session = this.sessionMgr.get(ctx.sessionKey) || this.sessionMgr.getOrCreate(ctx.sessionKey);

    switch (sub) {
      case 'add': {
        if (!this.emailSetup) return false;
        await this.emailSetup.start(ctx.sessionKey, ctx.chatId, ctx.messageId, arg);
        return true;
      }

      case 'list': {
        const accounts = AccountStore.load(session.sessionDir);
        if (accounts.length === 0) {
          await this.sender.sendText(ctx.chatId, '📧 尚未配置邮箱。使用 /email add 添加。', ctx.messageId);
        } else {
          const lines = ['**已配置的邮箱**', ''];
          for (const a of accounts) {
            lines.push(`- \`${a.id}\`: ${a.label} (${a.imap.user}) [推送: ${a.pushEnabled ? '开' : '关'}]`);
          }
          await this.sender.sendReply(ctx.chatId, lines.join('\n'), ctx.messageId);
        }
        return true;
      }

      case 'remove': {
        if (!arg) {
          await this.sender.sendText(ctx.chatId, '用法: /email remove <账号id>', ctx.messageId);
          return true;
        }
        const accountId = arg.trim();
        const removed = AccountStore.remove(session.sessionDir, accountId);
        if (removed) {
          // Stop IDLE monitoring for this account
          if (this.idleMonitor) {
            this.idleMonitor.stopAccount(ctx.sessionKey, accountId);
          }
          await this.sender.sendText(ctx.chatId, `✅ 已删除邮箱 "${accountId}"`, ctx.messageId);
        } else {
          await this.sender.sendText(ctx.chatId, `⚠️ 未找到邮箱 "${accountId}"`, ctx.messageId);
        }
        return true;
      }

      case 'test': {
        if (!arg) {
          await this.sender.sendText(ctx.chatId, '用法: /email test <账号id>', ctx.messageId);
          return true;
        }
        const account = AccountStore.get(session.sessionDir, arg.trim());
        if (!account) {
          await this.sender.sendText(ctx.chatId, `⚠️ 未找到邮箱 "${arg.trim()}"`, ctx.messageId);
          return true;
        }
        await this.sender.sendText(ctx.chatId, '🔄 正在测试连接...', ctx.messageId);
        const result = await AccountStore.test(account);
        const lines = [`**测试结果: ${account.label}**`, ''];
        lines.push(result.imap ? '✅ IMAP 连接成功' : `❌ IMAP 失败: ${result.imapError}`);
        lines.push(result.smtp ? '✅ SMTP 连接成功' : `❌ SMTP 失败: ${result.smtpError}`);
        await this.sender.sendReply(ctx.chatId, lines.join('\n'), ctx.messageId);
        return true;
      }

      case 'rules': {
        if (!arg) {
          // Show current rules
          const currentRules = loadRules(session.sessionDir);
          if (currentRules) {
            await this.sender.sendReply(ctx.chatId, [
              '**当前邮件推送规则**',
              '',
              currentRules,
              '',
              '修改规则: `/email rules <新规则>`',
              '清除规则: `/email rules clear`',
            ].join('\n'), ctx.messageId);
          } else {
            await this.sender.sendReply(ctx.chatId, [
              '**当前无自定义规则**',
              '',
              '默认行为：过滤纯广告/垃圾邮件，其他正常邮件都推送。',
              '',
              '设置规则示例:',
              '`/email rules 过滤所有来自 noreply@ 的邮件；关注所有来自 @company.com 的邮件；Vercel/GitHub 的通知邮件只推送失败告警`',
            ].join('\n'), ctx.messageId);
          }
          return true;
        }

        if (arg.trim().toLowerCase() === 'clear') {
          saveRules(session.sessionDir, '');
          await this.sender.sendText(ctx.chatId, '✅ 邮件规则已清除，恢复默认行为', ctx.messageId);
          return true;
        }

        saveRules(session.sessionDir, arg);
        await this.sender.sendReply(ctx.chatId, [
          '✅ 邮件推送规则已更新',
          '',
          arg,
          '',
          '新规则将应用于之后收到的所有新邮件。',
        ].join('\n'), ctx.messageId);
        return true;
      }

      case 'cancel': {
        if (this.emailSetup) {
          this.emailSetup.cancel(ctx.sessionKey);
          await this.sender.sendText(ctx.chatId, '❌ 邮箱配置已取消', ctx.messageId);
        }
        return true;
      }

      default: {
        // No subcommand → show help or start add
        if (!sub) {
          await this.sender.sendReply(ctx.chatId, [
            '**邮箱管理命令**',
            '',
            '`/email add [提供商]` — 添加邮箱（如 /email add gmail）',
            '`/email list` — 查看已配置邮箱',
            '`/email remove <id>` — 删除邮箱',
            '`/email test <id>` — 测试邮箱连接',
            '`/email rules [规则]` — 查看/设置邮件推送规则',
            '`/email cancel` — 取消正在进行的配置',
          ].join('\n'), ctx.messageId);
        } else {
          // Treat unknown subcommand as provider hint for add
          if (this.emailSetup) {
            await this.emailSetup.start(ctx.sessionKey, ctx.chatId, ctx.messageId, sub + ' ' + arg);
          }
        }
        return true;
      }
    }
  }

  private async handleRegister(ctx: CommandContext): Promise<boolean> {
    await this.sender.sendReply(
      ctx.chatId,
      [
        '**开发者身份注册**',
        '',
        '注册后可以用你自己的 Git 身份（name/email/SSH key）和飞书文档 MCP 进行协作。',
        '',
        '请 @我 说「注册开发者身份」，我会引导你完成配置。',
      ].join('\n'),
      ctx.messageId,
    );
    return true;
  }

  private async handleAuto(text: string, ctx: CommandContext): Promise<boolean> {
    const session = this.sessionMgr.get(ctx.sessionKey) || this.sessionMgr.getOrCreate(ctx.sessionKey);
    const autoReplyFile = `${session.sessionDir}/auto-reply`;
    const parts = text.split(/\s+/);
    const sub = parts[1]?.toLowerCase();

    if (sub === 'on' || sub === 'off' || sub === 'always') {
      fs.writeFileSync(autoReplyFile, sub);
      const descMap: Record<string, string> = {
        on: '已开启：未@消息也会由 AI 判断是否回复',
        off: '已关闭：仅回复 @消息（未@消息记录为上下文）',
        always: '已开启 Always 模式：所有消息都视为@提及，必定回复',
      };
      await this.sender.sendText(ctx.chatId, `✅ 自动回复${descMap[sub]}`, ctx.messageId);
      this.logger.info({ sessionKey: ctx.sessionKey, autoReply: sub }, '/auto: updated');
    } else {
      let current = 'on';
      try { current = fs.readFileSync(autoReplyFile, 'utf-8').trim(); } catch {}
      const descMap: Record<string, string> = {
        on: '当前：未@消息也会由 AI 判断是否回复',
        off: '当前：仅回复 @消息（未@消息记录为上下文）',
        always: '当前：Always 模式，所有消息都视为@提及，必定回复',
      };
      await this.sender.sendReply(ctx.chatId, [
        `**自动回复状态: ${current}**`,
        '',
        descMap[current] || descMap['on'],
        '',
        '`/auto on` — 开启（AI 判断是否回复未@消息）',
        '`/auto off` — 关闭（仅回复@消息）',
        '`/auto always` — 全部回复（所有消息都当作@处理）',
      ].join('\n'), ctx.messageId);
    }
    return true;
  }


  private async handleHelp(ctx: CommandContext): Promise<boolean> {
    const helpText = [
      '**可用命令**',
      '',
      '`/new` — 重置会话，开始新对话（保留记忆和文件）',
      '`/stop` — 中止当前正在运行的任务',
      '`/status` — 查看当前会话状态',
      '`/email` — 邮箱管理（添加、查看、测试）',
      '`/register` — 注册开发者身份（Git + 飞书 MCP）',
      '`/auto [on|off|always]` — 群聊自动回复（on=AI判断, off=仅@回复, always=全部回复）',
      '`/help` — 显示此帮助信息',
      '',
      '直接发送消息即可与 Claude 对话。Claude 可以读写文件、执行命令等。',
    ].join('\n');

    await this.sender.sendReply(ctx.chatId, helpText, ctx.messageId);
    return true;
  }
}
