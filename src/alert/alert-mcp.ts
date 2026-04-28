#!/usr/bin/env node
/**
 * Alert MCP Server — exposes alert (condition-triggered job) management as MCP tools.
 * Spawned by Claude Code as a stdio MCP server.
 * Reads SESSION_DIR from environment (set by process-pool.ts).
 *
 * See: shared/sigma-alert-plan.md (chapter 七-十二)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const SESSION_DIR = process.env.SESSION_DIR || '';
if (!SESSION_DIR) {
  process.stderr.write('alert-mcp: SESSION_DIR not set\n');
  process.exit(1);
}

const ALERTS_FILE = path.join(SESSION_DIR, 'alerts.json');
const SIGNAL_FILE = path.join(SESSION_DIR, '.alerts-changed');

interface AlertWatermark {
  last_pubdate: number;
  processed_ids: string[];
  max_processed_size?: number;
}

interface AlertStats {
  polls: number;
  triggers: number;
  failures: number;
  last_poll?: string;
  last_trigger?: string;
}

interface Alert {
  id: string;
  name: string;
  type: 'one_shot' | 'watcher';
  enabled: boolean;
  interval_seconds: number;
  check_command: string;
  prompt: string;
  execution_mode: 'claude' | 'shell' | 'message_only';
  trigger_command?: string;
  state: { watermark: AlertWatermark; stats: AlertStats };
  max_runtime_days?: number;
  createdAt: string;
}

function readAlerts(): Alert[] {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function writeAlerts(alerts: Alert[]): void {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
}

function signalChange(): void {
  fs.writeFileSync(SIGNAL_FILE, String(Date.now()));
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Tool implementations ────────────────────────────────────

function listAlerts(): string {
  const alerts = readAlerts();
  if (alerts.length === 0) return '当前没有 Alert。';

  const lines = [`共 ${alerts.length} 个 Alert：\n`];
  for (const a of alerts) {
    const status = a.enabled ? '✅ 启用' : '⏸️ 禁用';
    const stats = a.state?.stats || { polls: 0, triggers: 0, failures: 0 };
    const lastTrigger = stats.last_trigger
      ? new Date(stats.last_trigger).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : '从未触发';
    const wmSize = (a.state?.watermark?.processed_ids || []).length;
    lines.push(`**${a.name}** (ID: ${a.id})`);
    lines.push(`  类型: ${a.type} | 状态: ${status} | 间隔: ${a.interval_seconds}s | 模式: ${a.execution_mode}`);
    lines.push(`  统计: polls=${stats.polls} triggers=${stats.triggers} failures=${stats.failures} 已处理=${wmSize}`);
    lines.push(`  上次触发: ${lastTrigger}`);
    lines.push(`  prompt: ${a.prompt.slice(0, 150)}${a.prompt.length > 150 ? '...' : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

function createAlert(args: {
  name: string;
  type?: 'one_shot' | 'watcher';
  interval_seconds: number;
  check_command: string;
  prompt: string;
  execution_mode?: 'claude' | 'shell' | 'message_only';
  trigger_command?: string;
  max_runtime_days?: number;
}): string {
  if (!args.name) return 'Error: name is required';
  if (!args.check_command) return 'Error: check_command is required';
  if (!args.prompt) return 'Error: prompt is required';
  if (!args.interval_seconds || args.interval_seconds < 10) return 'Error: interval_seconds must be >= 10';

  const alert: Alert = {
    id: generateId(),
    name: args.name,
    type: args.type || 'watcher',
    enabled: true,
    interval_seconds: args.interval_seconds,
    check_command: args.check_command,
    prompt: args.prompt,
    execution_mode: args.execution_mode || 'claude',
    trigger_command: args.trigger_command,
    state: {
      watermark: { last_pubdate: 0, processed_ids: [], max_processed_size: 200 },
      stats: { polls: 0, triggers: 0, failures: 0 },
    },
    max_runtime_days: args.max_runtime_days ?? 30,
    createdAt: new Date().toISOString(),
  };

  const alerts = readAlerts();
  alerts.push(alert);
  writeAlerts(alerts);
  signalChange();

  return `Alert 已创建：\n  名称: ${alert.name}\n  ID: ${alert.id}\n  类型: ${alert.type}\n  间隔: ${alert.interval_seconds}秒\n  执行模式: ${alert.execution_mode}\n  check: ${alert.check_command.slice(0, 100)}${alert.check_command.length > 100 ? '...' : ''}\n\nAlert 已上线，将在 ${alert.interval_seconds} 秒后首次轮询。`;
}

function deleteAlert(args: { id: string }): string {
  if (!args.id) return 'Error: id is required';
  const alerts = readAlerts();
  const idx = alerts.findIndex((a) => a.id === args.id);
  if (idx === -1) return `Error: 未找到 ID 为 "${args.id}" 的 Alert`;
  const removed = alerts.splice(idx, 1)[0];
  writeAlerts(alerts);
  signalChange();
  return `已删除 Alert "${removed.name}" (ID: ${removed.id})`;
}

function toggleAlert(args: { id: string; enabled: boolean }): string {
  if (!args.id) return 'Error: id is required';
  const alerts = readAlerts();
  const a = alerts.find((x) => x.id === args.id);
  if (!a) return `Error: 未找到 ID 为 "${args.id}" 的 Alert`;
  a.enabled = args.enabled;
  writeAlerts(alerts);
  signalChange();
  return `已${args.enabled ? '启用' : '禁用'} Alert "${a.name}"`;
}

function resetAlert(args: { id: string }): string {
  if (!args.id) return 'Error: id is required';
  const alerts = readAlerts();
  const a = alerts.find((x) => x.id === args.id);
  if (!a) return `Error: 未找到 ID 为 "${args.id}" 的 Alert`;
  a.state = {
    watermark: { last_pubdate: 0, processed_ids: [], max_processed_size: 200 },
    stats: { polls: 0, triggers: 0, failures: 0 },
  };
  writeAlerts(alerts);
  signalChange();
  return `已重置 Alert "${a.name}" 的 watermark 和统计。下一轮将从当前最新状态重新建立基线。`;
}

function inspectAlert(args: { id: string }): string {
  if (!args.id) return 'Error: id is required';
  const alerts = readAlerts();
  const a = alerts.find((x) => x.id === args.id);
  if (!a) return `Error: 未找到 ID 为 "${args.id}" 的 Alert`;
  return JSON.stringify(a, null, 2);
}

// ─── MCP Protocol ────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_alerts',
    description: '列出所有 Alert（条件触发任务）。包含名称、类型、间隔、统计、上次触发时间。',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_alert',
    description: 'Create a condition-triggered alert. Two types: watcher (持续监听新事件，如 UP 主新视频) | one_shot (一次性条件，触发后自动停). check_command 是 sh 脚本，输出 JSON 数组 [{NEW_ID, NEW_PUBDATE, ...}]; exit 0 + 非空数组 = 触发. prompt 支持 {{NEW_ID}} {{NEW_TITLE}} 等模板替换. execution_mode: claude (启 Claude 子进程跑 prompt) | shell (跑 trigger_command) | message_only (直接发消息).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Alert 名称' },
        type: { type: 'string', enum: ['one_shot', 'watcher'], description: '类型，默认 watcher' },
        interval_seconds: { type: 'number', description: '轮询间隔（秒），最小 10' },
        check_command: { type: 'string', description: 'sh 检查脚本（可访问 $WATERMARK_JSON 环境变量），输出 JSON 数组' },
        prompt: { type: 'string', description: '触发时的 prompt 或消息模板，支持 {{字段}} 替换 check 输出的 NEW_xxx 字段' },
        execution_mode: { type: 'string', enum: ['claude', 'shell', 'message_only'], description: '默认 claude' },
        trigger_command: { type: 'string', description: 'execution_mode=shell 时执行的命令' },
        max_runtime_days: { type: 'number', description: 'watcher 自动停用天数（默认 30，0=永不）' },
      },
      required: ['name', 'interval_seconds', 'check_command', 'prompt'],
    },
  },
  {
    name: 'delete_alert',
    description: '删除 Alert',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'toggle_alert',
    description: '启用或禁用 Alert',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'enabled'],
    },
  },
  {
    name: 'reset_alert',
    description: '重置 Alert 的 watermark 和统计（清空已处理记录，从当前最新状态重新建立基线）',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'inspect_alert',
    description: '查看 Alert 完整状态（含 watermark / processed_ids / stats）',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

function handleRequest(req: { id: number | string; method: string; params?: any }): any {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'alert-mcp', version: '1.0.0' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args } = req.params || {};
      let text: string;
      switch (name) {
        case 'list_alerts': text = listAlerts(); break;
        case 'create_alert': text = createAlert(args || {}); break;
        case 'delete_alert': text = deleteAlert(args || {}); break;
        case 'toggle_alert': text = toggleAlert(args || {}); break;
        case 'reset_alert': text = resetAlert(args || {}); break;
        case 'inspect_alert': text = inspectAlert(args || {}); break;
        default: text = `Unknown tool: ${name}`;
      }
      return { content: [{ type: 'text', text }] };
    }
    default:
      return null;
  }
}

function sendResponse(id: number | string, result: any): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id: number | string, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req: any;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return;
  const result = handleRequest(req);
  if (result !== null) sendResponse(req.id, result);
  else sendError(req.id, -32601, `Method not found: ${req.method}`);
});
