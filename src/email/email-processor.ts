import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClaudeRunner } from '../claude/runner.js';
import type { EmailAccount } from './account-store.js';
import type { Logger } from '../utils/logger.js';

const RULES_FILE = 'email-rules.txt';

export interface RawEmail {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  text: string;         // Plain text body
  headers: Record<string, string>;
}

export interface ProcessedEmail {
  isSpam: boolean;
  from: string;
  subject: string;
  summary: string;
  translatedSubject?: string;
  date: Date;
  uid: number;
  accountId: string;
  accountLabel: string;
}

/**
 * Load user-defined email rules from session directory.
 */
export function loadRules(sessionDir: string): string {
  const filePath = path.join(sessionDir, RULES_FILE);
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Load the user's CLAUDE.md so the email classifier can pick up user
 * preferences (investment limits, language, methodology, etc) when
 * generating personalized summaries — without giving it write access
 * to the user's session transcript.
 *
 * Cap at 8KB to keep prompt size bounded; users with longer CLAUDE.md
 * should keep load-bearing context near the top.
 */
function loadUserClaudeMd(sessionDir: string): string {
  const filePath = path.join(sessionDir, 'CLAUDE.md');
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return raw.length > 8000 ? raw.slice(0, 8000) + '\n\n[…truncated]' : raw;
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Save user-defined email rules to session directory.
 */
export function saveRules(sessionDir: string, rules: string): void {
  const filePath = path.join(sessionDir, RULES_FILE);
  fs.writeFileSync(filePath, rules, 'utf-8');
}

/**
 * Processes new emails: all emails go through Claude with user-defined rules.
 */
export class EmailProcessor {
  private processorDir: string;

  constructor(
    private runner: ClaudeRunner,
    private sessionsDir: string,
    private logger: Logger,
  ) {
    this.processorDir = path.join(path.dirname(sessionsDir), '_email_processor');
    fs.mkdirSync(this.processorDir, { recursive: true });
  }

  async process(emails: RawEmail[], account: EmailAccount, sessionDir: string): Promise<ProcessedEmail[]> {
    if (emails.length === 0) return [];

    // Hard rules (whitelist/spam) and soft preferences (CLAUDE.md) — both
    // injected into prompt; classifier runs in isolated _email_processor
    // session so the user's transcript is not polluted.
    const userRules = loadRules(sessionDir);
    const userClaudeMd = loadUserClaudeMd(sessionDir);

    try {
      return await this.classifyWithClaude(emails, account, userRules, userClaudeMd);
    } catch (err) {
      this.logger.error({ err, accountId: account.id }, 'Claude email processing failed');
      // Fallback: treat all as non-spam with basic info
      return emails.map(email => ({
        isSpam: false,
        from: email.from,
        subject: email.subject,
        summary: email.text.slice(0, 200) + (email.text.length > 200 ? '...' : ''),
        date: email.date,
        uid: email.uid,
        accountId: account.id,
        accountLabel: account.label,
      }));
    }
  }

  private async classifyWithClaude(emails: RawEmail[], account: EmailAccount, userRules: string, userClaudeMd: string): Promise<ProcessedEmail[]> {
    const emailDescriptions = emails.map((e, i) => {
      const bodySnippet = (e.text || '').slice(0, 1000);
      return `--- 邮件 ${i + 1} ---
发件人: ${e.from}
主题: ${e.subject}
日期: ${e.date.toISOString()}
正文片段:
${bodySnippet}`;
    }).join('\n\n');

    const rulesSection = userRules
      ? `\n## 硬规则（必须严格遵守，不可被下方用户档案推翻）\n${userRules}\n\n请严格按照以上规则判断每封邮件是否应该推送（notify）。如果规则是白名单模式（只推送某些发件人），则不在白名单中的邮件一律设 notify: false。\n`
      : `\n## 默认规则\n过滤纯广告/营销/垃圾邮件（notify: false），其他正常邮件都推送（notify: true）。\n`;

    const userBackgroundSection = userClaudeMd
      ? `\n## 用户档案（来自 CLAUDE.md，仅用于个性化摘要视角，不可推翻硬规则）\n${userClaudeMd}\n`
      : '';

    const prompt = `你是邮件分析助手。分析以下 ${emails.length} 封邮件，对每封邮件：
1. 根据硬规则判断是否需要推送给用户 (notify: true/false)
2. 用1-2句中文生成摘要 (summary) — 结合用户档案，挑用户最关心的视角
3. 如果主题不是中文，翻译成中文 (translatedSubject，中文主题则省略此字段)
${rulesSection}${userBackgroundSection}
注意：硬规则决定 notify 字段；用户档案只影响 summary 的措辞和切入点，不能让被规则过滤的邮件变为 notify=true。

严格按以下 JSON 数组格式输出，不要输出其他内容：
[{"index":0,"notify":true,"summary":"...","translatedSubject":"..."},...]

${emailDescriptions}`;

    const result = await this.runner.run({
      sessionKey: '_email_processor',
      message: prompt,
      sessionDir: this.processorDir,
    });

    const responseText = result.fullText?.trim() || '';
    this.logger.debug({ responseLength: responseText.length }, 'Claude email analysis response');

    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      this.logger.warn({ response: responseText.slice(0, 500) }, 'Failed to parse Claude JSON response');
      throw new Error('Invalid Claude response format');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      index: number;
      notify: boolean;
      summary: string;
      translatedSubject?: string;
    }>;

    const results: ProcessedEmail[] = [];
    for (const item of parsed) {
      const email = emails[item.index];
      if (!email) continue;

      results.push({
        isSpam: !item.notify,
        from: email.from,
        subject: email.subject,
        summary: item.summary,
        translatedSubject: item.translatedSubject,
        date: email.date,
        uid: email.uid,
        accountId: account.id,
        accountLabel: account.label,
      });
    }

    return results;
  }
}

/**
 * Format processed emails into a Feishu push notification.
 */
export function formatPushNotification(emails: ProcessedEmail[]): string {
  if (emails.length === 1) {
    const e = emails[0];
    const subject = e.translatedSubject
      ? `${e.translatedSubject}（${e.subject}）`
      : e.subject;
    const time = e.date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const lines = [
      `<<TITLE:📬 ${e.accountLabel} 新邮件>>`,
      '',
      `**来自**: ${e.from}`,
      `**主题**: ${subject}`,
      `**时间**: ${time}`,
      '',
      `> ${e.summary}`,
      '',
      `💡 回复我可以对这封邮件进行操作（如"回复他说收到了"、"查看全文"）`,
    ];
    return lines.join('\n');
  }

  // Multiple emails
  const lines = [
    `<<TITLE:📬 ${emails.length} 封新邮件>>`,
    '',
  ];

  for (const e of emails) {
    const subject = e.translatedSubject
      ? `${e.translatedSubject}（${e.subject}）`
      : e.subject;
    const time = e.date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
    lines.push(`**${time}** — ${e.from}`);
    lines.push(`📌 ${subject}`);
    lines.push(`> ${e.summary}`);
    lines.push('');
  }

  lines.push(`💡 回复我可以对这些邮件进行操作`);
  return lines.join('\n');
}
