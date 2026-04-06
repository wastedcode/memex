import type { JobType, JobLimits } from './types.js';

// ── Paths (overridable via env) ──────────────────────────────────────────────

export const DATA_DIR = process.env['MEMEX_DATA_DIR'] ?? '/var/lib/memex';
export const RUN_DIR = process.env['MEMEX_RUN_DIR'] ?? '/run/memex';
export const SOCKET_PATH = process.env['MEMEX_SOCKET_PATH'] ?? `${RUN_DIR}/memex.sock`;
export const DB_PATH = `${DATA_DIR}/memex.db`;
export const WIKIS_DIR = `${DATA_DIR}/wikis`;
export const NS_DIR = `${RUN_DIR}/ns`;

// Mount target inside namespaces — must exist on host as empty directory
export const WORKSPACE_MOUNT = '/workspace';

// ── Job limits ───────────────────────────────────────────────────────────────

export const JOB_LIMITS: Record<JobType, JobLimits> = {
  ingest: { timeout_ms: 5 * 60_000, max_turns: 25 },
  query:  { timeout_ms: 2 * 60_000, max_turns: 15 },
  lint:   { timeout_ms: 10 * 60_000, max_turns: 30 },
};

// ── Process management ───────────────────────────────────────────────────────

export const SIGTERM_GRACE_MS = 5_000;
export const AUTO_LINT_INTERVAL = 10;
export const JOB_POLL_INTERVAL_MS = 500;

// ── Claude defaults ──────────────────────────────────────────────────────────

export const DEFAULT_MODEL = 'sonnet';
export const BASE_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];

/** Tools that may be added via .tools/allowed-tools.txt. Bash and other shell/code tools are excluded. */
export const ALLOWED_TOOLS_WHITELIST = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'NotebookEdit', 'WebFetch', 'WebSearch',
]);

// ── Validation ───────────────────────────────────────────────────────────────

export const WIKI_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}[a-zA-Z0-9]$/;
