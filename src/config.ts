import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
  };
  claude: {
    path: string;
    model: string;
    systemPrompt: string;
  };
  sessionsDir: string;
  maxConcurrent: number;
  maxQueuePerSession: number;
  processTimeout: number;
  logLevel: string;
  adminPort: number;
  adminPasswords: string[];
  relaySecret: string;
  tunnelUrl: string;
}

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function findClaudePath(): string {
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    return path.join(os.homedir(), '.local/bin/claude');
  }
}

function loadSystemPrompt(): string {
  // Priority: SYSTEM_PROMPT env var > system-prompt.txt file > default
  const envPrompt = process.env.SYSTEM_PROMPT;
  if (envPrompt) return envPrompt;

  // Try to load from file (relative to project root)
  const promptFile = path.join(process.cwd(), 'system-prompt.txt');
  try {
    if (fs.existsSync(promptFile)) {
      return fs.readFileSync(promptFile, 'utf-8').trim();
    }
  } catch {
    // Fall through to default
  }

  return '你是一个有用的AI助手，通过飞书与用户交流。请用中文回复。';
}

export function loadConfig(): Config {
  return {
    feishu: {
      appId: required('FEISHU_APP_ID'),
      appSecret: required('FEISHU_APP_SECRET'),
    },
    claude: {
      path: optional('CLAUDE_PATH', findClaudePath()),
      model: optional('CLAUDE_MODEL', 'sonnet'),
      systemPrompt: loadSystemPrompt(),
    },
    sessionsDir: optional('SESSIONS_DIR', path.join(process.cwd(), 'sessions')),
    maxConcurrent: parseInt(optional('MAX_CONCURRENT', '3'), 10),
    maxQueuePerSession: parseInt(optional('MAX_QUEUE_PER_SESSION', '5'), 10),
    processTimeout: parseInt(optional('PROCESS_TIMEOUT', '120000'), 10),
    logLevel: optional('LOG_LEVEL', 'info'),
    adminPort: parseInt(optional('ADMIN_PORT', '3333'), 10),
    adminPasswords: optional('ADMIN_PASSWORD', '').split(',').map(s => s.trim()).filter(Boolean),
    relaySecret: optional('RELAY_SECRET', 'sigma-relay-default-secret'),
    tunnelUrl: optional('CF_TUNNEL_URL', ''),
  };
}
