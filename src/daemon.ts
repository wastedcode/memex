import { mkdirSync, existsSync } from 'node:fs';
import { Database } from './daemon/db.js';
import { NamespaceManager } from './daemon/namespace.js';
import { WikiScaffold } from './daemon/scaffold.js';
import { AuthManager } from './daemon/auth.js';
import { ClaudeRunner } from './daemon/runner.js';
import { QueueManager } from './daemon/queue.js';
import { RouteHandler } from './daemon/routes.js';
import { DaemonServer } from './daemon/server.js';
import {
  DATA_DIR, RUN_DIR, SOCKET_PATH, DB_PATH, WIKIS_DIR,
  AUTO_LINT_INTERVAL,
} from './lib/constants.js';

export async function startDaemon(): Promise<void> {
  console.log('[memex] Starting daemon...');

  // ── Ensure directories ─────────────────────────────────────────────────
  // RUN_DIR may be pre-created by systemd (RuntimeDirectory=memex) in a
  // read-only /run mount (ProtectSystem=strict). Skip mkdir when it exists.
  for (const dir of [DATA_DIR, WIKIS_DIR, RUN_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // ── Database ───────────────────────────────────────────────────────────
  const db = new Database(DB_PATH);
  db.initialize();

  const staleCount = db.resetStaleJobs();
  if (staleCount > 0) {
    console.log(`[memex] Reset ${staleCount} stale job(s) from previous run`);
  }

  // ── Namespace manager ──────────────────────────────────────────────────
  const namespace = new NamespaceManager(WIKIS_DIR);
  namespace.checkCapabilities();
  namespace.ensureDirectories();

  // ── Components ─────────────────────────────────────────────────────────
  const scaffold = new WikiScaffold(WIKIS_DIR);
  const auth = new AuthManager(WIKIS_DIR);
  const runner = new ClaudeRunner(namespace, auth, db, WIKIS_DIR);
  const queue = new QueueManager(db, runner, AUTO_LINT_INTERVAL);
  const routes = new RouteHandler(db, scaffold, namespace, queue, auth);
  const server = new DaemonServer(SOCKET_PATH, routes);

  // ── Start ──────────────────────────────────────────────────────────────
  await server.start();
  queue.start();

  const wikiCount = db.listWikis().length;
  console.log(`[memex] Daemon ready (PID ${process.pid})`);
  console.log(`[memex] Socket: ${SOCKET_PATH}`);
  console.log(`[memex] Data:   ${DATA_DIR}`);
  console.log(`[memex] Wikis:  ${wikiCount}`);

  // ── Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[memex] Received ${signal}, shutting down...`);

    await queue.stop();
    await server.stop();
    db.close();

    console.log('[memex] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
