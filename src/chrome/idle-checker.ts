import { execSync } from 'node:child_process';
import type { SessionManager } from '../claude/session-manager.js';
import type { Logger } from '../utils/logger.js';

const IDLE_MS = 30 * 60 * 1000;       // 30 minutes
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

export class ChromeIdleChecker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private sessionMgr: SessionManager,
    private portAllocations: Map<string, number>,
    private logger: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.logger.info('Chrome idle checker started (30min timeout, 5min interval)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private check(): void {
    for (const [sessionKey, port] of this.portAllocations) {
      try {
        // Check if Chrome is actually running on this port
        if (!this.isChromeRunning(port)) continue;

        // Check session idle time
        const session = this.sessionMgr.get(sessionKey);
        if (!session) continue;

        const idleMs = Date.now() - session.lastUsed;
        if (idleMs < IDLE_MS) continue;

        // Kill idle Chrome
        this.logger.info(
          { sessionKey, port, idleMinutes: Math.round(idleMs / 60000) },
          'Killing idle Chrome instance',
        );
        this.killChromeOnPort(port);
      } catch (err) {
        this.logger.debug({ err, sessionKey, port }, 'Error checking Chrome idle status');
      }
    }
  }

  private isChromeRunning(port: number): boolean {
    try {
      execSync(`curl -s --max-time 2 http://127.0.0.1:${port}/json/version`, {
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  private killChromeOnPort(port: number): void {
    try {
      const pid = execSync(`lsof -ti :${port}`, { stdio: 'pipe' }).toString().trim();
      if (pid) {
        // May return multiple PIDs (parent + child processes)
        for (const p of pid.split('\n')) {
          if (p.trim()) {
            execSync(`kill ${p.trim()}`, { stdio: 'pipe' });
          }
        }
        this.logger.info({ port, pid }, 'Chrome process killed');
      }
    } catch (err) {
      this.logger.debug({ err, port }, 'Failed to kill Chrome on port');
    }
  }
}
