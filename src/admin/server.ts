import express from 'express';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import { createRoutes } from './routes.js';
import { RelayServer } from '../relay/relay-server.js';
import type { RelayCommand } from '../relay/protocol.js';
import { randomUUID, createHmac } from 'node:crypto';

export interface AdminServerResult {
  httpServer: http.Server;
  relayServer: RelayServer;
}

/** Generate a signed auth token */
function signToken(password: string): string {
  const payload = Date.now().toString();
  const sig = createHmac('sha256', password).update(payload).digest('hex').slice(0, 16);
  return `${payload}.${sig}`;
}

/** Verify a signed auth token */
function verifyToken(token: string, password: string): boolean {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', password).update(payload).digest('hex').slice(0, 16);
  return sig === expected;
}

/** Parse cookie header and extract a value */
function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`));
  return match ? match[1] : null;
}

export function startAdminServer(
  sessionsDir: string,
  port: number,
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void },
  feishuClient?: lark.Client,
  adminPassword?: string,
): AdminServerResult {
  const app = express();
  app.use(express.json());

  const authEnabled = !!adminPassword;

  // ── Auth endpoints (no middleware) ──

  app.post('/api/auth/login', (req, res) => {
    if (!authEnabled) {
      res.json({ ok: true });
      return;
    }
    const { password } = req.body;
    if (password !== adminPassword) {
      res.status(401).json({ error: 'Wrong password' });
      return;
    }
    const token = signToken(adminPassword);
    res.setHeader('Set-Cookie', `sigma_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
    res.json({ ok: true });
  });

  app.get('/api/auth/check', (req, res) => {
    if (!authEnabled) {
      res.json({ authenticated: true });
      return;
    }
    const token = getCookie(req.headers.cookie, 'sigma_token');
    if (token && verifyToken(token, adminPassword!)) {
      res.json({ authenticated: true });
    } else {
      res.status(401).json({ authenticated: false });
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'sigma_token=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
  });

  // ── Auth middleware (protects /api/* except auth and relay) ──

  if (authEnabled) {
    app.use('/api', (req, res, next) => {
      // Skip auth for: login/check/logout, relay endpoints, session-names (extension)
      if (req.path.startsWith('/auth/') || req.path.startsWith('/relay/') || req.path === '/session-names') {
        next();
        return;
      }
      const token = getCookie(req.headers.cookie, 'sigma_token');
      if (token && verifyToken(token, adminPassword!)) {
        next();
      } else {
        res.status(401).json({ error: 'Unauthorized' });
      }
    });
  }

  // API routes
  app.use(createRoutes(sessionsDir, feishuClient));

  // Relay command API — MCP server sends commands here
  const relayServer = new RelayServer(logger);

  app.post('/api/relay/command', async (req, res) => {
    const { sessionKey, tool, params } = req.body;
    if (!sessionKey || !tool) {
      res.status(400).json({ error: 'Missing sessionKey or tool' });
      return;
    }
    const command: RelayCommand = {
      id: randomUUID(),
      tool,
      params: params || {},
    };
    const response = await relayServer.sendCommand(sessionKey, command);
    if (response.error) {
      res.status(502).json({ error: response.error });
    } else {
      res.json({ result: response.result });
    }
  });

  app.get('/api/relay/status', (_req, res) => {
    res.json({ connections: relayServer.getStatus() });
  });

  // Serve frontend static files (production)
  const webDist = path.join(process.cwd(), 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback — serve index.html for all non-API routes
    app.use((_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  relayServer.attach(httpServer);

  httpServer.listen(port, '127.0.0.1', () => {
    logger.info(`Admin dashboard running at http://127.0.0.1:${port} (localhost only, use CF tunnel for external access)`);
  });

  return { httpServer, relayServer };
}
