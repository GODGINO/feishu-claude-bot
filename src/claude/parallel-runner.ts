import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import type { MessageSender } from '../feishu/message-sender.js';
import type { Config } from '../config.js';

/**
 * ParallelRunner — `/并行 <prompt>` driver.
 *
 * Spawns an isolated, one-shot Claude Code child process that shares the parent
 * session directory (cwd, CLAUDE.md, members, skills, git repo) but writes to a
 * brand-new session-id, so its transcript never collides with the long-lived
 * main process managed by ProcessPool.
 *
 * Concurrency: at most `maxConcurrent` (default 2) live parallel agents per
 * parent session. Other agents see each other's work via `git log` once they
 * commit — there is no shared in-memory state.
 *
 * MVP behaviour:
 *   - Output captured as one stdout block then chunked to Feishu (no streaming card).
 *   - On-screen prefix `[/并行 #N]` is appended by the parallel agent itself,
 *     per the system prompt we inject up-front.
 *   - The child runs with `--dangerously-skip-permissions` like the main pool.
 *
 * NOT in MVP (to follow on Day 2):
 *   - Transcript copy so parallel sees prior conversation history
 *   - Streaming card with `[/并行 #N]` title color
 *   - Per-fork cardId tracking / abort
 */
export class ParallelRunner {
  // parentSessionKey → set of running fork PIDs
  private active = new Map<string, Set<number>>();
  // parentSessionKey → next forkN to assign (monotonic per session)
  private nextN = new Map<string, number>();
  private maxConcurrent = 2;

  constructor(
    private config: Config,
    private logger: Logger,
  ) {}

  /** How many parallel agents are alive for this parent session. */
  activeCount(parentSessionKey: string): number {
    return this.active.get(parentSessionKey)?.size || 0;
  }

  /** Whether a new parallel agent can be spawned right now. */
  canSpawn(parentSessionKey: string): boolean {
    return this.activeCount(parentSessionKey) < this.maxConcurrent;
  }

  /**
   * Spawn one parallel agent. Resolves when the agent exits. Errors during
   * spawn/exit are caught and reported to Feishu — the caller's await never throws.
   */
  async run(opts: {
    parentSessionKey: string;
    parentSessionDir: string;
    chatId: string;
    prompt: string;
    replyToMessageId?: string;
    sender: MessageSender;
  }): Promise<void> {
    const { parentSessionKey, parentSessionDir, chatId, prompt, replyToMessageId, sender } = opts;

    if (!this.canSpawn(parentSessionKey)) {
      await sender.sendText(chatId, `⚠️ 已达并行上限（${this.maxConcurrent}），请等当前任务结束`, replyToMessageId);
      return;
    }

    const forkN = (this.nextN.get(parentSessionKey) || 0) + 1;
    this.nextN.set(parentSessionKey, forkN);
    const forkId = crypto.randomBytes(3).toString('hex');
    const tag = `[/并行 #${forkN}]`;

    const wrappedPrompt =
      `${tag} 你是 sigma 主 agent 的并行分身（${forkId}）。\n` +
      `工作目录：${parentSessionDir}\n` +
      `规则：\n` +
      `1. 你和其他 agent 共享同一个 cwd 和 git 仓库\n` +
      `2. 修改代码请用 git worktree 隔离，完成后 git commit；其他 agent 通过 git log 看到你的工作\n` +
      `3. 不要直接修改主工作目录里的关键文件（除非用户明确让你这么干）\n` +
      `4. 完成任务后简短给出汇报：做了什么、改了哪些文件、commit hash（如有）、是否进入了 worktree\n\n` +
      `用户请求：${prompt}`;

    const claudePath = this.config.claude.path;
    const model = this.config.claude.model || 'sonnet';
    const args = [
      '-p', wrappedPrompt,
      '--model', model,
      '--dangerously-skip-permissions',
    ];

    // Strip nested-Claude detection vars so the child doesn't refuse to run.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_EXECPATH;

    this.logger.info({ parentSessionKey, forkN, forkId, claudePath }, 'Spawning parallel agent');
    await sender.sendText(chatId, `🚀 ${tag} 已启动（${forkId}）`, replyToMessageId);

    let proc;
    try {
      proc = spawn(claudePath, args, { cwd: parentSessionDir, env });
    } catch (err) {
      this.logger.error({ err, parentSessionKey, forkN }, 'Parallel spawn failed');
      await sender.sendText(chatId, `${tag} ❌ spawn 失败: ${(err as Error).message}`);
      return;
    }

    const pid = proc.pid || 0;
    if (!this.active.has(parentSessionKey)) this.active.set(parentSessionKey, new Set());
    this.active.get(parentSessionKey)!.add(pid);

    let stdoutBuf = '';
    let stderrBuf = '';
    proc.stdout?.on('data', (d) => { stdoutBuf += d.toString(); });
    proc.stderr?.on('data', (d) => { stderrBuf += d.toString(); });

    try {
      const code = await new Promise<number>((resolve) => {
        proc!.on('exit', (c) => resolve(c ?? -1));
        proc!.on('error', () => resolve(-1));
      });

      const out = stdoutBuf.trim();
      if (code !== 0) {
        this.logger.warn({ parentSessionKey, forkN, code, stderr: stderrBuf.slice(0, 500) }, 'Parallel agent exited non-zero');
        const errMsg = `${tag} ❌ 退出码 ${code}\n${stderrBuf.slice(-800) || '(无 stderr)'}`;
        await sender.sendText(chatId, errMsg);
        return;
      }

      if (!out) {
        await sender.sendText(chatId, `${tag} ✅ 完成（无输出）`);
        return;
      }

      // Chunk if too long for one Feishu message
      const MAX = 3500;
      if (out.length <= MAX) {
        await sender.sendText(chatId, out);
      } else {
        for (let i = 0; i < out.length; i += MAX) {
          await sender.sendText(chatId, out.slice(i, i + MAX));
        }
      }
    } finally {
      this.active.get(parentSessionKey)?.delete(pid);
      if (this.active.get(parentSessionKey)?.size === 0) this.active.delete(parentSessionKey);
    }
  }
}
