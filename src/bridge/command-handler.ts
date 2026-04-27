import * as fs from 'node:fs';
import type { MessageSender } from '../feishu/message-sender.js';
import type { SessionManager } from '../claude/session-manager.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { Logger } from '../utils/logger.js';
import { AccountStore } from '../email/account-store.js';
import { loadRules, saveRules } from '../email/email-processor.js';
import type { EmailSetup } from './email-setup.js';
import type { IdleMonitor } from '../email/idle-monitor.js';
import type { WechatBridge } from '../wechat/wechat-bridge.js';

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
  private wechatBridge: WechatBridge | null = null;

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

  setWechatBridge(bridge: WechatBridge): void {
    this.wechatBridge = bridge;
  }

  async handle(text: string, ctx: CommandContext): Promise<boolean> {
    const cmd = text.trim().toLowerCase();

    if (cmd === '/new') {
      return this.handleNew(ctx);
    }
    if (cmd === '/compact') {
      return this.handleCompact(ctx);
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
    if (cmd === '/model' || cmd.startsWith('/model ')) {
      return this.handleModel(text.trim(), ctx);
    }
    if (cmd === '/effort' || cmd.startsWith('/effort ')) {
      return this.handleEffort(text.trim(), ctx);
    }
    if (cmd === '/wechat' || cmd.startsWith('/wechat ')) {
      return this.handleWechat(text.trim(), ctx);
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
      const MENU: Array<{ alias: string; label: string }> = [
        { alias: 'on',     label: '开启 (AI 判断)' },
        { alias: 'off',    label: '关闭 (仅 @)' },
        { alias: 'always', label: '全部回复 (Always)' },
      ];
      const lines: string[] = [
        `**自动回复状态: ${current}**`,
        '',
        descMap[current] || descMap['on'],
        '',
        '点按下方按钮切换（当前高亮）：',
        '',
      ];
      for (const item of MENU) {
        const style = item.alias === current ? 'primary' : 'default';
        lines.push(`<<BUTTON:${item.label}|/auto ${item.alias}|${style}>>`);
      }
      await this.sender.sendReply(
        ctx.chatId,
        lines.join('\n'),
        ctx.messageId,
        undefined,
        undefined,
        { sessionKey: ctx.sessionKey, chatId: ctx.chatId },
      );
    }
    return true;
  }


  private async handleModel(text: string, ctx: CommandContext): Promise<boolean> {
    const session = this.sessionMgr.get(ctx.sessionKey) || this.sessionMgr.getOrCreate(ctx.sessionKey);
    const modelFile = `${session.sessionDir}/model`;
    const parts = text.split(/\s+/);
    const sub = parts[1]?.toLowerCase();

    const ALIASES: Record<string, string> = {
      // Haiku
      'haiku':           'haiku',
      // Sonnet (current)
      'sonnet':          'claude-sonnet-4-6[1m]',
      'sonnet 1m':       'claude-sonnet-4-6[1m]',
      'sonnet 200k':     'claude-sonnet-4-6',
      // Opus 4.6 (previous flagship)
      'opus 4.6':        'claude-opus-4-6[1m]',
      'opus 4.6 1m':     'claude-opus-4-6[1m]',
      'opus 4.6 200k':   'claude-opus-4-6',
      // Opus 4.7 (current flagship)
      'opus':            'claude-opus-4-7[1m]',
      'opus 1m':         'claude-opus-4-7[1m]',
      'opus 200k':       'claude-opus-4-7',
    };

    const DISPLAY: Record<string, string> = {
      'haiku':                   'Haiku 4.5 · 200K',
      'claude-sonnet-4-6[1m]':   'Sonnet 4.6 · 1M',
      'claude-sonnet-4-6':       'Sonnet 4.6 · 200K',
      'claude-opus-4-6[1m]':     'Opus 4.6 · 1M',
      'claude-opus-4-6':         'Opus 4.6 · 200K',
      'claude-opus-4-7[1m]':     'Opus 4.7 · 1M',
      'claude-opus-4-7':         'Opus 4.7 · 200K',
      // Legacy short-form aliases that may still appear in sessionDir/model files
      'opus[1m]':                'Opus 4.7 · 1M',
      'sonnet[1m]':              'Sonnet 4.6 · 1M',
    };

    // Display-order: short command alias + (resolved model string)
    // Keep this in sync with the button card below so the docs & UI match.
    const MENU: Array<{ alias: string; resolved: string }> = [
      { alias: 'sonnet',        resolved: 'claude-sonnet-4-6[1m]' },
      { alias: 'sonnet 200k',   resolved: 'claude-sonnet-4-6' },
      { alias: 'opus 4.6',      resolved: 'claude-opus-4-6[1m]' },
      { alias: 'opus 4.6 200k', resolved: 'claude-opus-4-6' },
      { alias: 'opus',          resolved: 'claude-opus-4-7[1m]' },
      { alias: 'opus 200k',     resolved: 'claude-opus-4-7' },
      { alias: 'haiku',         resolved: 'haiku' },
    ];

    const modelArg = parts.slice(1).join(' ').toLowerCase();
    if (modelArg && ALIASES[modelArg]) {
      const model = ALIASES[modelArg];
      fs.writeFileSync(modelFile, model);
      this.runner.respawn(ctx.sessionKey);
      await this.sender.sendText(ctx.chatId, `✅ 模型已切换为 **${DISPLAY[model] || model}**`, ctx.messageId);
      this.logger.info({ sessionKey: ctx.sessionKey, model }, '/model: switched');
    } else if (!modelArg) {
      let current = 'claude-sonnet-4-6[1m]';
      try { current = fs.readFileSync(modelFile, 'utf-8').trim(); } catch {}
      const lines: string[] = [
        `**当前模型：${DISPLAY[current] || current}**`,
        '',
        '点按下方按钮切换（当前高亮）：',
        '',
      ];
      for (const item of MENU) {
        const style = item.resolved === current ? 'primary' : 'default';
        const label = DISPLAY[item.resolved] || item.resolved;
        lines.push(`<<BUTTON:${label}|/model ${item.alias}|${style}>>`);
      }
      await this.sender.sendReply(
        ctx.chatId,
        lines.join('\n'),
        ctx.messageId,
        undefined,
        undefined,
        { sessionKey: ctx.sessionKey, chatId: ctx.chatId },
      );
    } else {
      await this.sender.sendText(ctx.chatId, `⚠️ 未知模型: ${modelArg}`, ctx.messageId);
    }
    return true;
  }


  private async handleEffort(text: string, ctx: CommandContext): Promise<boolean> {
    const session = this.sessionMgr.get(ctx.sessionKey) || this.sessionMgr.getOrCreate(ctx.sessionKey);
    const effortFile = `${session.sessionDir}/effort`;
    const modelFile = `${session.sessionDir}/model`;
    const parts = text.split(/\s+/);
    const sub = parts[1]?.toLowerCase();

    const VALID_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

    let currentModel = 'sonnet';
    try { currentModel = fs.readFileSync(modelFile, 'utf-8').trim(); } catch {}
    const isOpus47 = currentModel.includes('opus-4-7') || currentModel === 'opus' || currentModel === 'opus 1m';

    if (sub === 'auto') {
      try { fs.unlinkSync(effortFile); } catch {}
      this.runner.respawn(ctx.sessionKey);
      await this.sender.sendText(ctx.chatId, '✅ Effort 已重置为模型默认值（Opus 4.7 默认 xhigh，Sonnet 4.6 默认 high/medium）', ctx.messageId);
      this.logger.info({ sessionKey: ctx.sessionKey }, '/effort: reset to auto');
      return true;
    }

    if (sub && VALID_LEVELS.has(sub)) {
      fs.writeFileSync(effortFile, sub);
      this.runner.respawn(ctx.sessionKey);
      let msg = `✅ Effort 已切换为 **${sub}**`;
      if (sub === 'xhigh' && !isOpus47) {
        msg += '\n⚠️ xhigh 仅 Opus 4.7 支持，当前模型将自动降级为 high';
      }
      await this.sender.sendText(ctx.chatId, msg, ctx.messageId);
      this.logger.info({ sessionKey: ctx.sessionKey, effort: sub }, '/effort: switched');
      return true;
    }

    if (!sub) {
      let current = 'auto';
      try {
        const saved = fs.readFileSync(effortFile, 'utf-8').trim();
        if (saved) current = saved;
      } catch {}
      const defaultHint = isOpus47 ? 'Opus 4.7 默认 xhigh' : 'Sonnet/Opus 4.6 默认 high 或 medium';
      const MENU: Array<{ alias: string; label: string }> = [
        { alias: 'low',    label: 'Low (最快)' },
        { alias: 'medium', label: 'Medium (中等)' },
        { alias: 'high',   label: 'High (平衡)' },
        { alias: 'xhigh',  label: 'xHigh (Opus 4.7 专属)' },
        { alias: 'max',    label: 'Max (无上限)' },
        { alias: 'auto',   label: 'Auto (模型默认)' },
      ];
      const lines: string[] = [
        `**当前 effort: ${current}**`,
        `当前模型: ${currentModel}（${defaultHint}）`,
        '',
        'Effort 控制 adaptive reasoning 思考深度。点按下方按钮切换（当前高亮）：',
        '',
      ];
      for (const item of MENU) {
        const style = item.alias === current ? 'primary' : 'default';
        lines.push(`<<BUTTON:${item.label}|/effort ${item.alias}|${style}>>`);
      }
      lines.push('');
      lines.push('注: Haiku 不支持 effort。xhigh 在非 Opus 4.7 模型上自动降级为 high。');
      await this.sender.sendReply(
        ctx.chatId,
        lines.join('\n'),
        ctx.messageId,
        undefined,
        undefined,
        { sessionKey: ctx.sessionKey, chatId: ctx.chatId },
      );
      return true;
    }

    await this.sender.sendText(ctx.chatId, `⚠️ 未知 effort 等级: ${sub}（有效: low/medium/high/xhigh/max/auto）`, ctx.messageId);
    return true;
  }


  private async handleWechat(text: string, ctx: CommandContext): Promise<boolean> {
    // Only allow in DM
    if (ctx.sessionKey.startsWith('group_')) {
      await this.sender.sendText(
        ctx.chatId,
        '⚠️ 微信绑定需要在私聊中操作\n\n微信号属于个人账号，绑定信息不适合在群聊中展示。请私聊 Sigma 发送 /wechat 完成绑定。',
        ctx.messageId,
      );
      return true;
    }

    if (!this.wechatBridge) {
      await this.sender.sendText(ctx.chatId, '⚠️ 微信桥接功能未启用', ctx.messageId);
      return true;
    }

    const parts = text.split(/\s+/);
    const sub = parts[1]?.toLowerCase() || '';

    switch (sub) {
      case 'status':
        await this.wechatBridge.showStatus(ctx.sessionKey, ctx.chatId, ctx.messageId);
        break;
      case 'unbind':
        await this.wechatBridge.unbind(ctx.sessionKey, ctx.chatId, ctx.messageId);
        break;
      case 'rebind':
        await this.wechatBridge.rebind(ctx.sessionKey, ctx.chatId, ctx.messageId);
        break;
      default:
        // /wechat or /wechat bind — start binding
        await this.wechatBridge.startBinding(ctx.sessionKey, ctx.chatId, ctx.messageId);
        break;
    }
    return true;
  }

  private async handleCompact(ctx: CommandContext): Promise<boolean> {
    const session = this.sessionMgr.get(ctx.sessionKey) || this.sessionMgr.getOrCreate(ctx.sessionKey);
    // Forward /compact directly to Claude Code — it's a built-in slash command.
    await this.sender.sendText(ctx.chatId, '⏳ 正在压缩上下文…', ctx.messageId);
    try {
      const result = await this.runner.pool.send({
        sessionKey: ctx.sessionKey,
        sessionDir: session.sessionDir,
        message: '/compact',
      });
      if (result.error) {
        await this.sender.sendText(ctx.chatId, `❌ 压缩失败：${result.error}`, ctx.messageId);
      } else {
        await this.sender.sendText(ctx.chatId, '✅ 上下文已压缩。下一条消息开始使用更轻量的历史。', ctx.messageId);
      }
      this.logger.info({ sessionKey: ctx.sessionKey, hasError: !!result.error }, '/compact: user-invoked');
    } catch (err: any) {
      await this.sender.sendText(ctx.chatId, `❌ 压缩失败：${err?.message || err}`, ctx.messageId);
      this.logger.error({ err, sessionKey: ctx.sessionKey }, '/compact threw');
    }
    return true;
  }

  private async handleHelp(ctx: CommandContext): Promise<boolean> {
    const helpText = [
      '**可用命令**',
      '',
      '`/new` — 重置会话，开始新对话（保留记忆和文件）',
      '`/compact` — 压缩当前会话历史（降低 ctx 占用、避免「Prompt is too long」）',
      '`/stop` — 中止当前正在运行的任务',
      '`/status` — 查看当前会话状态',
      '`/email` — 邮箱管理（添加、查看、测试）',
      '`/register` — 注册开发者身份（Git + 飞书 MCP）',
      '`/auto [on|off|always]` — 群聊自动回复（on=AI判断, off=仅@回复, always=全部回复）',
      '`/model [sonnet|opus|haiku]` — 切换 AI 模型',
      '`/effort [low|medium|high|xhigh|max|auto]` — 切换思考深度（Speed ↔ Intelligence）',
      '`/wechat` — 绑定微信（扫码后微信消息同步，共享 Claude 会话，仅私聊）',
      '`/help` — 显示此帮助信息',
      '',
      '直接发送消息即可与 Claude 对话。Claude 可以读写文件、执行命令等。',
    ].join('\n');

    await this.sender.sendReply(ctx.chatId, helpText, ctx.messageId);
    return true;
  }
}
