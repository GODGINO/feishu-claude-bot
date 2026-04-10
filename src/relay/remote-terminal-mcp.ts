#!/usr/bin/env node
/**
 * Remote Terminal MCP Server (stdio transport)
 *
 * Spawned by Claude as a subprocess. Translates MCP tool calls into
 * HTTP POST requests to the relay server, which forwards them to
 * the Sigma Terminal app via WebSocket.
 *
 * Usage: node remote-terminal-mcp.js <sessionKey> [relayUrl]
 *   relayUrl defaults to http://localhost:3333
 */

import * as readline from 'node:readline';

const SESSION_KEY = process.argv[2];
const RELAY_URL = process.argv[3] || 'http://localhost:3333';

if (!SESSION_KEY) {
  process.stderr.write('Usage: remote-terminal-mcp.js <sessionKey> [relayUrl]\n');
  process.exit(1);
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: 'shell_exec',
    description: 'Execute a shell command on the user\'s Mac. Returns stdout, stderr, and exitCode.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Working directory. Defaults to user home.' },
        timeout: { type: 'integer', description: 'Timeout in ms. Default 60000.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'file_read',
    description: 'Read a file from the user\'s Mac. Returns content with line numbers (like Claude Code Read).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'integer', description: 'Line number to start from (0-based). Default 0.' },
        limit: { type: 'integer', description: 'Max lines to read. Default 2000.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write/create a file on the user\'s Mac. Overwrites if exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_edit',
    description: 'Edit a file by replacing a string. old_string must be unique in the file (unless replace_all). Works like Claude Code Edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        old_string: { type: 'string', description: 'The exact string to find and replace' },
        new_string: { type: 'string', description: 'The replacement string' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'Search for files by name pattern on the user\'s Mac.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.js")' },
        path: { type: 'string', description: 'Directory to search in. Defaults to user home.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents by regex pattern on the user\'s Mac.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in. Defaults to cwd.' },
        glob: { type: 'string', description: 'Glob to filter files (e.g. "*.ts")' },
        include: { type: 'string', description: 'File type filter (e.g. "ts", "js")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'system_info',
    description: 'Get system information about the user\'s Mac (OS, arch, shell, home, username, hostname).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'open',
    description: 'Open a URL, file, or application on the user\'s Mac using macOS `open` command.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'URL, file path, or app name to open' },
      },
      required: ['target'],
    },
  },
  {
    name: 'notify',
    description: 'Send a macOS notification to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body text' },
      },
      required: ['title', 'body'],
    },
  },
];

// ── JSON-RPC helpers ──

function jsonrpcResponse(id: number | string | null, result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id: number | string | null, code: number, message: string) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Relay communication ──

async function relayCommand(tool: string, params: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`${RELAY_URL}/api/relay/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey: SESSION_KEY, tool, params }),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as any;
    throw new Error(body.error || `Relay HTTP ${resp.status}`);
  }

  const data = await resp.json() as any;
  return data.result;
}

// ── MCP protocol handler ──

async function handleRequest(msg: any): Promise<string | null> {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return jsonrpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'remote-terminal', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return jsonrpcResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await relayCommand(name, args || {});
        const content = typeof result === 'string'
          ? [{ type: 'text', text: result }]
          : [{ type: 'text', text: JSON.stringify(result, null, 2) }];
        return jsonrpcResponse(id, { content });
      } catch (err: any) {
        return jsonrpcResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── stdio transport ──

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    const response = await handleRequest(msg);
    if (response) {
      process.stdout.write(response + '\n');
    }
  } catch (err: any) {
    process.stderr.write(`Parse error: ${err.message}\n`);
  }
});

process.stderr.write(`Remote terminal MCP started for session ${SESSION_KEY}\n`);
