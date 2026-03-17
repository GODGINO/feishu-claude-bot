import 'dotenv/config';
import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { createFeishuClients } from './feishu/client.js';
import { createEventHandler } from './feishu/event-handler.js';
import { MessageSender } from './feishu/message-sender.js';
import { TypingIndicator } from './feishu/typing.js';
import { ClaudeRunner } from './claude/runner.js';
import { SessionManager } from './claude/session-manager.js';
import { MessageBridge } from './bridge/message-bridge.js';
import { CronRunner } from './scheduler/cron-runner.js';
import { ChromeIdleChecker } from './chrome/idle-checker.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { IdleMonitor } from './email/idle-monitor.js';
import { EmailProcessor, formatPushNotification } from './email/email-processor.js';
import { startAdminServer } from './admin/server.js';

/**
 * Ensure only one bot instance runs at a time.
 * 1. Kill previous PID from PID file
 * 2. pgrep to kill ALL orphan bot processes (any start method)
 * 3. Write current PID
 * 4. Start a background watchdog that periodically checks for rogue duplicates
 */
function ensureSingleInstance(pidPath: string, logger: ReturnType<typeof createLogger>): void {
  // Kill previous PID file holder
  try {
    const oldPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 'SIGTERM');
        logger.info({ oldPid }, 'Killed previous bot process via PID file');
      } catch { /* already gone */ }
    }
  } catch { /* no PID file */ }

  // Kill ALL orphan bot processes regardless of how they were started
  killOrphanProcesses(logger);

  // Claim PID
  fs.writeFileSync(pidPath, String(process.pid));
}

function killOrphanProcesses(logger: ReturnType<typeof createLogger>): void {
  for (const pattern of ['node dist/index.js', 'tsx src/index.ts', 'tsx watch src/index.ts']) {
    try {
      const output = execSync(`pgrep -f "${pattern}"`, { encoding: 'utf-8' }).trim();
      const pids = output.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => p && p !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
          logger.info({ pid, pattern }, 'Killed orphan bot process');
        } catch { /* already gone */ }
      }
    } catch { /* pgrep exits 1 when no matches */ }
  }
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const PID_FILE = path.join(path.dirname(config.sessionsDir), '.bot.pid');
  ensureSingleInstance(PID_FILE, logger);

  // Watchdog: periodically check for rogue duplicate processes (every 60s)
  setInterval(() => {
    killOrphanProcesses(logger);
  }, 60_000);

  logger.info('Starting Feishu Claude Bot...');

  // Create Feishu clients
  const { client, wsClient } = createFeishuClients(
    config.feishu.appId,
    config.feishu.appSecret,
    logger,
  );

  // Get bot's own open_id for @mention detection in groups
  let botOpenId = '';
  try {
    const resp = await client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    const respData = resp as any;
    botOpenId = respData?.data?.bot?.open_id || respData?.bot?.open_id || '';
    if (botOpenId) {
      logger.info({ botOpenId }, 'Bot info retrieved');
    } else {
      logger.warn('Bot info response missing open_id, will auto-detect from mentions');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to get bot info, will auto-detect from mentions');
  }

  // Create core components (botStartTime filters out stale events from before startup)
  const botStartTime = Date.now();
  const { dispatcher, onMessage } = createEventHandler(botOpenId, logger, botStartTime);
  const sender = new MessageSender(client, logger);
  const typing = new TypingIndicator(client, logger);
  const runner = new ClaudeRunner(config, logger, config.sessionsDir);
  const sessionMgr = new SessionManager(config.sessionsDir, logger);

  // Create message bridge (orchestrates everything)
  const bridge = new MessageBridge(sender, typing, runner, sessionMgr, config, logger);

  // Route all messages through the bridge
  onMessage(async (msg) => {
    await bridge.handleMessage(msg);
  });

  // Start cron scheduler for skills
  const scheduler = new CronRunner(runner, sessionMgr, sender, logger);
  scheduler.start();

  // Start email IDLE monitor (push notifications for new emails)
  const emailProcessor = new EmailProcessor(runner, config.sessionsDir, logger);
  const idleMonitor = new IdleMonitor(
    config.sessionsDir,
    async (sessionKey, chatId, account, emails) => {
      try {
        const session = sessionMgr.getOrCreate(sessionKey);
        const processed = await emailProcessor.process(emails, account, session.sessionDir);
        const toNotify = processed.filter(e => !e.isSpam);
        if (toNotify.length > 0) {
          const text = formatPushNotification(toNotify);
          await sender.sendReply(chatId, text);

        }
        const spamCount = processed.filter(e => e.isSpam).length;
        if (spamCount > 0) {
          logger.debug({ sessionKey, accountId: account.id, spamCount }, 'Filtered spam emails');
        }
      } catch (err) {
        logger.error({ err, sessionKey, accountId: account.id }, 'Failed to process new emails');
      }
    },
    logger,
  );
  bridge.setIdleMonitor(idleMonitor);
  idleMonitor.start();

  // Start Chrome idle checker (auto-kill after 30min idle)
  const chromeChecker = new ChromeIdleChecker(
    sessionMgr,
    sessionMgr.getMcpManager().getPortAllocations(),
    logger,
  );
  chromeChecker.start();

  // Start admin dashboard + relay server
  const { relayServer } = startAdminServer(config.sessionsDir, config.adminPort, logger, client, config.adminPassword);

  // Start WebSocket connection
  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info('Feishu WebSocket connected. Bot is ready!');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    relayServer.destroy();
    idleMonitor.stopAll();
    chromeChecker.stop();
    scheduler.stop();
    runner.killAll();
    sessionMgr.destroy();
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
