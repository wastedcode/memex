import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import type { RouteHandler } from './routes.js';
import type { ApiResponse } from '../lib/types.js';
import { getPeerCred } from './peercred.js';

export class DaemonServer {
  private server: Server;
  private socketUids = new WeakMap<Socket, number>();

  constructor(
    private socketPath: string,
    private routes: RouteHandler,
  ) {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch(err => {
        console.error('[server] Unhandled error:', err);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'Internal server error' });
        }
      });
    });

    // Extract peer credentials at connection time (before any HTTP parsing).
    // SO_PEERCRED is set by the kernel at connect() — it's immutable and unspoofable.
    this.server.on('connection', (socket: Socket) => {
      try {
        const cred = getPeerCred(socket);
        this.socketUids.set(socket, cred.uid);
      } catch (err) {
        console.error('[server] Failed to get peer credentials:', err);
        socket.destroy();
      }
    });
  }

  async start(): Promise<void> {
    // Remove stale socket file
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        chmodSync(this.socketPath, 0o666);
        console.log(`[server] Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        if (existsSync(this.socketPath)) {
          try { unlinkSync(this.socketPath); } catch { /* ignore */ }
        }
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = req.url ?? '/';

    // Parse body for POST/PUT
    let body: unknown = undefined;
    if (method === 'POST' || method === 'PUT') {
      body = await readBody(req);
    }

    // Check for streaming (wait) mode on job submission
    const urlObj = new URL(url, 'http://localhost');
    const wait = urlObj.searchParams.get('wait') === 'true';

    // Retrieve the caller's UID from the underlying socket
    const socket = req.socket as Socket;
    const callerUid = this.socketUids.get(socket);
    if (callerUid === undefined) {
      sendJson(res, 500, { ok: false, error: 'Could not determine caller identity' });
      return;
    }

    try {
      const result = await this.routes.handle(method, urlObj.pathname, body, {
        wait,
        res, // pass response for streaming login output
        callerUid,
        query: urlObj.searchParams,
      });

      // If the route already handled the response (e.g., streaming), skip
      if (res.writableEnded) return;

      sendJson(res, result.status, result.body);
    } catch (err) {
      if (res.writableEnded) return;

      if (err && typeof err === 'object' && 'statusCode' in err) {
        const memexErr = err as { statusCode: number; message: string; code: string };
        sendJson(res, memexErr.statusCode, {
          ok: false,
          error: memexErr.message,
        });
      } else {
        console.error('[server] Error handling request:', err);
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
      }
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: ApiResponse): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// 100 MB — enough for large PDFs/images encoded as base64
const MAX_BODY_BYTES = 100 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
