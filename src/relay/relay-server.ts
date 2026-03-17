import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { RelayCommand, RelayResponse, RelayMessage, ExtensionStatus } from './protocol.js';

const PING_INTERVAL = 30_000;
const COMMAND_TIMEOUT = 60_000;

interface PendingCommand {
  resolve: (resp: RelayResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  ws: WebSocket;
  sessionKey: string;
  connectedAt: number;
  lastPingAt: number;
  userAgent?: string;
  pending: Map<string, PendingCommand>;
}

export class RelayServer {
  private wss!: WebSocketServer;
  private connections = new Map<string, Connection>(); // sessionKey -> connection
  private pingTimer?: ReturnType<typeof setInterval>;
  private logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

  constructor(logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void }) {
    this.logger = logger;
  }

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: '/relay' });

    this.wss.on('connection', (ws, req) => {
      // Extract session key from URL: /relay?session=<key>
      const url = new URL(req.url || '', 'http://localhost');
      const sessionKey = url.searchParams.get('session');

      if (!sessionKey) {
        ws.close(4001, 'Missing session parameter');
        return;
      }

      // Close existing connection for same session
      const existing = this.connections.get(sessionKey);
      if (existing) {
        existing.ws.close(4002, 'Replaced by new connection');
        this.cleanupConnection(sessionKey);
      }

      const conn: Connection = {
        ws,
        sessionKey,
        connectedAt: Date.now(),
        lastPingAt: Date.now(),
        userAgent: req.headers['user-agent'],
        pending: new Map(),
      };
      this.connections.set(sessionKey, conn);
      this.logger.info({ sessionKey }, 'Extension connected');

      ws.on('message', (data) => {
        try {
          const msg: RelayMessage = JSON.parse(data.toString());
          this.handleMessage(conn, msg);
        } catch (err) {
          this.logger.warn({ sessionKey, err }, 'Invalid message from extension');
        }
      });

      ws.on('close', () => {
        this.cleanupConnection(sessionKey);
        this.logger.info({ sessionKey }, 'Extension disconnected');
      });

      ws.on('error', (err) => {
        this.logger.error({ sessionKey, err }, 'Extension WebSocket error');
      });
    });

    // Periodic ping to keep connections alive
    this.pingTimer = setInterval(() => {
      for (const [key, conn] of this.connections) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          this.send(conn.ws, { type: 'ping' });
        } else {
          this.cleanupConnection(key);
        }
      }
    }, PING_INTERVAL);

    this.logger.info('Relay WebSocket server attached');
  }

  /** Send a command to an extension and wait for response */
  async sendCommand(sessionKey: string, command: RelayCommand): Promise<RelayResponse> {
    const conn = this.connections.get(sessionKey);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return { id: command.id, error: 'Extension not connected' };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(command.id);
        resolve({ id: command.id, error: `Command timed out after ${COMMAND_TIMEOUT}ms` });
      }, COMMAND_TIMEOUT);

      conn.pending.set(command.id, { resolve, timer });
      this.send(conn.ws, { type: 'command', payload: command });
    });
  }

  /** Check if an extension is connected for a session */
  isConnected(sessionKey: string): boolean {
    const conn = this.connections.get(sessionKey);
    return !!conn && conn.ws.readyState === WebSocket.OPEN;
  }

  /** Get status of all connected extensions */
  getStatus(): ExtensionStatus[] {
    const result: ExtensionStatus[] = [];
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        result.push({
          sessionKey: conn.sessionKey,
          connectedAt: conn.connectedAt,
          lastPingAt: conn.lastPingAt,
          userAgent: conn.userAgent,
        });
      }
    }
    return result;
  }

  destroy(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const conn of this.connections.values()) {
      conn.ws.close(1001, 'Server shutting down');
    }
    this.connections.clear();
    this.wss?.close();
  }

  private handleMessage(conn: Connection, msg: RelayMessage): void {
    switch (msg.type) {
      case 'response': {
        const pending = conn.pending.get(msg.payload.id);
        if (pending) {
          clearTimeout(pending.timer);
          conn.pending.delete(msg.payload.id);
          pending.resolve(msg.payload);
        }
        break;
      }
      case 'pong':
        conn.lastPingAt = Date.now();
        break;
      default:
        break;
    }
  }

  private cleanupConnection(sessionKey: string): void {
    const conn = this.connections.get(sessionKey);
    if (!conn) return;
    // Reject all pending commands
    for (const [id, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ id, error: 'Extension disconnected' });
    }
    conn.pending.clear();
    this.connections.delete(sessionKey);
  }

  private send(ws: WebSocket, msg: RelayMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
