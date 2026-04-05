import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import { McpManager } from './mcp-manager.js';

export interface Session {
  sessionKey: string;
  sessionId?: string;
  sessionDir: string;
  lastUsed: number;
}

const SESSION_EXPIRE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;    // 1 hour
const PERSIST_FILE = 'sessions.json';

export class SessionManager {
  private sessions = new Map<string, Session>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private persistPath: string;
  private mcpManager: McpManager;

  constructor(
    private sessionsDir: string,
    private logger: Logger,
  ) {
    this.persistPath = path.join(path.dirname(sessionsDir), PERSIST_FILE);
    fs.mkdirSync(sessionsDir, { recursive: true });
    this.mcpManager = new McpManager(sessionsDir, logger);
    this.loadFromDisk();
    this.startCleanup();
  }

  /**
   * Derive session key from chat type and ID
   */
  static getSessionKey(chatType: 'p2p' | 'group', userId: string, chatId: string): string {
    if (chatType === 'p2p') {
      return `dm_${userId}`;
    }
    return `group_${chatId}`;
  }

  /**
   * Get or create a session
   */
  getOrCreate(sessionKey: string): Session {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      const sessionDir = path.join(this.sessionsDir, sessionKey);
      fs.mkdirSync(sessionDir, { recursive: true });
      session = {
        sessionKey,
        sessionDir,
        lastUsed: Date.now(),
      };
      this.sessions.set(sessionKey, session);

      // Initialize CLAUDE.md with session settings template if it doesn't exist
      this.initClaudeMd(sessionDir);

      // Create symlinks to shared and members directories
      this.ensureSharedLink(sessionDir);
      this.ensureMembersLink(sessionDir);

      this.logger.info({ sessionKey }, 'Created new session');
    }

    // Ensure links exist (also for existing sessions)
    this.ensureSharedLink(session.sessionDir);
    this.ensureMembersLink(session.sessionDir);

    session.lastUsed = Date.now();

    // Generate per-session MCP config (.claude/settings.json)
    this.mcpManager.setup(sessionKey, session.sessionDir);

    return session;
  }

  /**
   * Get the MCP manager (for scheduler to access skills)
   */
  getMcpManager(): McpManager {
    return this.mcpManager;
  }

  /**
   * Reset session (/new command) — clear sessionId but keep directory and memories
   */
  reset(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.sessionId = undefined;
      this.saveToDisk();
      this.logger.info({ sessionKey }, 'Session reset (memories and files preserved)');
    }
  }

  /**
   * Get a session by key
   */
  get(sessionKey: string): Session | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Get all session keys (for scanning email accounts, etc.)
   */
  getSessionKeys(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get the sessions directory path
   */
  getSessionsDir(): string {
    return this.sessionsDir;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.saveToDisk();
  }

  /**
   * Ensure a symlink ./shared → {projectRoot}/shared exists in the session directory.
   * Allows cross-session knowledge transfer without escaping session boundaries.
   */
  private ensureSharedLink(sessionDir: string): void {
    const linkPath = path.join(sessionDir, 'shared');
    const target = path.join(path.dirname(this.sessionsDir), 'shared');
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) return; // Already exists
      // Not a symlink (maybe a regular dir) — skip to avoid data loss
      return;
    } catch {
      // Does not exist — create it
    }
    try {
      fs.symlinkSync(target, linkPath, 'dir');
    } catch {
      // Ignore — race condition or permission issue
    }
  }

  /** Ensure members/ symlink exists in session directory. */
  private ensureMembersLink(sessionDir: string): void {
    const linkPath = path.join(sessionDir, 'members');
    const target = path.join(path.dirname(this.sessionsDir), 'members');
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) return;
      return; // Not a symlink — don't overwrite
    } catch { /* doesn't exist */ }
    try {
      fs.symlinkSync(target, linkPath, 'dir');
    } catch { /* ignore */ }
  }

  /**
   * Initialize CLAUDE.md as the primary memory layer for this session.
   * Auto-loaded by Claude Code at zero cost — no tool calls needed.
   */
  private initClaudeMd(sessionDir: string): void {
    const claudeMdPath = path.join(sessionDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) return; // Don't overwrite existing

    const template = `# Session 设定

本文件自动加载，是最高优先级的记忆层。重要信息请直接写入此文件（用 Edit 工具更新对应章节）。

## 用户信息

（用户身份、公司、角色）

## 用户偏好

（语言风格、工作习惯、常用工具、沟通偏好）

## 重要事实

（客户信息、项目背景、关键日期、账号信息等不变的事实）

## 经验与方法论

（踩过的坑、有效的工作流程、需要避免的错误、提炼出的最佳实践）

## Git Commit 规范

提交代码时必须使用以下格式：

\`\`\`
<type>(<需求名称>): <简短描述>

<详细描述>

feishuId:<飞书id>
\`\`\`

**type 字段**：feat(新功能) | fix(修bug) | docs(文档) | style(格式) | refactor(重构) | test(测试)

- **需求名称**：飞书中的需求或 bug 标题
- **简短描述**：不超过 50 字符
- **详细描述**：若有则添加，无则删除，单行不超过 50 字符
- **feishuId**：对应飞书需求 ID

## 交互按钮

回复中可以使用 \`<<BUTTON:显示文案|操作标识|样式?>>\` 添加可点击按钮（样式: primary/danger/默认灰色）。适用场景：
- 完成任务后的后续操作确认（如"部署"、"推送"、"发送"）
- 提供链接快捷入口（配合文字说明）
- 需要用户做选择时（如"方案A" / "方案B"）

示例：\`修改完成，测试通过。<<BUTTON:推送代码|push|primary>> <<BUTTON:取消|cancel>>\`
`;
    try {
      fs.writeFileSync(claudeMdPath, template);
    } catch {
      // Ignore — might be a race condition
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, session] of this.sessions) {
        if (now - session.lastUsed > SESSION_EXPIRE_MS) {
          // Only clear sessionId, keep directory for memories
          session.sessionId = undefined;
          cleaned++;
        }
      }
      if (cleaned > 0) {
        this.saveToDisk();
        this.logger.debug({ cleaned }, 'Cleaned expired sessions');
      }
    }, CLEANUP_INTERVAL_MS);
  }

  private saveToDisk(): void {
    try {
      const data = Array.from(this.sessions.values())
        .filter((s) => s.sessionId) // Only persist sessions with active sessionId
        .map((s) => ({
          sessionKey: s.sessionKey,
          sessionId: s.sessionId,
          lastUsed: s.lastUsed,
        }));
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.error({ err }, 'Failed to save sessions');
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;

      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as Array<{
        sessionKey: string;
        sessionId?: string;
        lastUsed: number;
      }>;

      const now = Date.now();
      for (const entry of data) {
        // Skip expired sessions
        if (now - entry.lastUsed > SESSION_EXPIRE_MS) continue;

        const sessionDir = path.join(this.sessionsDir, entry.sessionKey);
        fs.mkdirSync(sessionDir, { recursive: true });
        this.sessions.set(entry.sessionKey, {
          sessionKey: entry.sessionKey,
          sessionId: entry.sessionId,
          sessionDir,
          lastUsed: entry.lastUsed,
        });

        // Ensure MCP config is up to date
        this.mcpManager.setup(entry.sessionKey, sessionDir);
      }

      this.logger.info({ count: this.sessions.size }, 'Restored sessions from disk');
    } catch (err) {
      this.logger.error({ err }, 'Failed to load sessions');
    }
  }
}
