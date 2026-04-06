import type { ServerResponse } from 'node:http';
import type { Database } from './db.js';
import type { WikiScaffold } from './scaffold.js';
import type { NamespaceManager } from './namespace.js';
import type { QueueManager } from './queue.js';
import type { AuthManager } from './auth.js';
import type {
  RouteResponse, CreateWikiRequest, SubmitJobRequest, WikiConfig, JobType,
} from '../lib/types.js';
import { WIKI_ID_PATTERN, JOB_POLL_INTERVAL_MS, ALLOWED_TOOLS_WHITELIST, BASE_ALLOWED_TOOLS } from '../lib/constants.js';
import {
  WikiNotFoundError, WikiExistsError, JobNotFoundError, ValidationError, ForbiddenError,
} from '../lib/errors.js';

interface RouteContext {
  wait?: boolean;
  res?: ServerResponse;
  callerUid: number;
  query?: URLSearchParams;
}

type Route = {
  method: string;
  pattern: RegExp;
  handler: (params: Record<string, string>, body: unknown, ctx: RouteContext) => Promise<RouteResponse>;
};

export class RouteHandler {
  private routes: Route[];

  constructor(
    private db: Database,
    private scaffold: WikiScaffold,
    private namespace: NamespaceManager,
    private queue: QueueManager,
    private auth: AuthManager,
  ) {
    this.routes = [
      { method: 'POST',   pattern: /^\/wikis$/,                             handler: this.createWiki.bind(this) },
      { method: 'GET',    pattern: /^\/wikis$/,                             handler: this.listWikis.bind(this) },
      { method: 'GET',    pattern: /^\/wikis\/(?<id>[^/]+)$/,               handler: this.getWiki.bind(this) },
      { method: 'DELETE', pattern: /^\/wikis\/(?<id>[^/]+)$/,               handler: this.destroyWiki.bind(this) },
      { method: 'PUT',    pattern: /^\/wikis\/(?<id>[^/]+)\/config$/,       handler: this.updateConfig.bind(this) },
      { method: 'POST',   pattern: /^\/wikis\/(?<id>[^/]+)\/chown$/,        handler: this.chownWiki.bind(this) },
      { method: 'POST',   pattern: /^\/wikis\/(?<id>[^/]+)\/api-key$/,      handler: this.setApiKey.bind(this) },
      { method: 'POST',   pattern: /^\/wikis\/(?<id>[^/]+)\/credentials$/,  handler: this.setCredentials.bind(this) },
      { method: 'POST',   pattern: /^\/wikis\/(?<id>[^/]+)\/jobs$/,         handler: this.submitJob.bind(this) },
      { method: 'GET',    pattern: /^\/wikis\/(?<id>[^/]+)\/jobs\/(?<jobId>\d+)$/, handler: this.getJob.bind(this) },
      { method: 'GET',    pattern: /^\/wikis\/(?<id>[^/]+)\/jobs$/,         handler: this.listJobs.bind(this) },
      { method: 'GET',    pattern: /^\/wikis\/(?<id>[^/]+)\/logs$/,         handler: this.getAuditLog.bind(this) },
      { method: 'POST',   pattern: /^\/wikis\/(?<id>[^/]+)\/ingest-file$/,  handler: this.receiveFile.bind(this) },
      { method: 'GET',    pattern: /^\/wikis\/(?<id>[^/]+)\/files$/,        handler: this.listFiles.bind(this) },
      { method: 'GET',    pattern: /^\/wikis\/(?<id>[^/]+)\/files\/(?<path>.+)$/, handler: this.readFile.bind(this) },
    ];
  }

  async handle(method: string, path: string, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = path.match(route.pattern);
      if (match) {
        return route.handler(match.groups ?? {}, body, ctx);
      }
    }

    return { status: 404, body: { ok: false, error: 'Not found' } };
  }

  // ── Wiki CRUD ───────────────────────────────────────────────────────────

  private async createWiki(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const b = requireBody(body);
    const id = b.id as string | undefined;
    const name = b.name as string | undefined;

    if (!id || !WIKI_ID_PATTERN.test(id)) {
      throw new ValidationError(
        `Invalid wiki ID '${id}'. Must be 3-64 chars, alphanumeric with hyphens and underscores, ` +
        'cannot start or end with a hyphen or underscore.'
      );
    }

    if (this.db.getWiki(id)) {
      throw new WikiExistsError(id);
    }

    const wiki = this.db.createWiki(id, name ?? id, ctx.callerUid);
    this.scaffold.create(id);
    this.namespace.validateWiki(id);
    this.db.logAudit(id, 'wiki.created');

    return { status: 201, body: { ok: true, data: wiki } };
  }

  private async listWikis(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikis = this.db.listWikis(ctx.callerUid);
    return { status: 200, body: { ok: true, data: wikis } };
  }

  private async getWiki(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wiki = this.requireWiki(params['id']!, ctx.callerUid);
    const pendingJobs = this.db.getPendingJobCount(wiki.id);
    return {
      status: 200,
      body: { ok: true, data: { ...wiki, pending_jobs: pendingJobs } },
    };
  }

  private async destroyWiki(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);

    const keepData = body && typeof body === 'object' && 'keepData' in body
      ? Boolean((body as { keepData: unknown }).keepData)
      : false;

    this.scaffold.destroy(wikiId, keepData);
    this.db.deleteWiki(wikiId);

    return { status: 200, body: { ok: true } };
  }

  private async chownWiki(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;

    // Root (uid 0) can chown any wiki; otherwise only the current owner can transfer
    const wiki = this.db.getWiki(wikiId);
    if (!wiki) throw new WikiNotFoundError(wikiId);
    if (ctx.callerUid !== 0 && wiki.owner_uid !== ctx.callerUid) {
      throw new ForbiddenError(wikiId);
    }

    const b = requireBody(body);
    const newOwnerUid = b.uid as number | undefined;
    if (newOwnerUid === undefined || typeof newOwnerUid !== 'number' || !Number.isInteger(newOwnerUid) || newOwnerUid < 0) {
      throw new ValidationError('uid (non-negative integer) is required');
    }

    const updated = this.db.chownWiki(wikiId, newOwnerUid);
    this.db.logAudit(wikiId, 'wiki.chown', `uid ${ctx.callerUid} → ${newOwnerUid}`);

    return { status: 200, body: { ok: true, data: updated } };
  }

  private async updateConfig(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);

    const config = requireBody(body) as WikiConfig;

    // Handle allowed_tools separately — validated and written to disk
    if (config.allowed_tools !== undefined) {
      if (!Array.isArray(config.allowed_tools)) {
        throw new ValidationError('allowed_tools must be an array of tool names');
      }
      const invalid = config.allowed_tools.filter(t => !ALLOWED_TOOLS_WHITELIST.has(t));
      if (invalid.length > 0) {
        const allowed = [...ALLOWED_TOOLS_WHITELIST].filter(t => !BASE_ALLOWED_TOOLS.includes(t));
        throw new ValidationError(
          `Invalid tools: ${invalid.join(', ')}. ` +
          `Allowed extras: ${allowed.join(', ')}`
        );
      }
      this.scaffold.writeAllowedTools(wikiId, config.allowed_tools);
      this.db.logAudit(wikiId, 'wiki.allowed_tools_updated', JSON.stringify(config.allowed_tools));
    }

    // Pass remaining DB-backed fields
    const { allowed_tools: _, ...dbConfig } = config;
    if (Object.keys(dbConfig).length > 0) {
      const wiki = this.db.updateWiki(wikiId, dbConfig);
      this.db.logAudit(wikiId, 'wiki.config_updated', JSON.stringify(dbConfig));
      return { status: 200, body: { ok: true, data: wiki } };
    }

    const wiki = this.db.getWiki(wikiId);
    return { status: 200, body: { ok: true, data: wiki } };
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  private async setApiKey(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);

    const b = requireBody(body);
    const key = b.key as string | undefined;
    if (!key || typeof key !== 'string') {
      throw new ValidationError('API key is required');
    }

    this.auth.setApiKey(wikiId, key);
    this.db.logAudit(wikiId, 'wiki.api_key_set');

    return { status: 200, body: { ok: true } };
  }

  private async setCredentials(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);

    const b = requireBody(body);
    const credentials = b.credentials as string | undefined;
    if (!credentials || typeof credentials !== 'string') {
      throw new ValidationError('credentials (JSON string) is required');
    }

    // Validate it's actually JSON
    try {
      JSON.parse(credentials);
    } catch {
      throw new ValidationError('credentials must be valid JSON');
    }

    this.auth.setCredentials(wikiId, credentials);
    this.db.logAudit(wikiId, 'wiki.credentials_set');

    return { status: 200, body: { ok: true } };
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  private async submitJob(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);

    const b = requireBody(body);
    const type = b.type as string;
    const payload = b.payload as object | undefined;
    if (!type || !isValidJobType(type)) {
      throw new ValidationError(`Invalid job type '${type}'. Must be one of: ingest, query, lint`);
    }

    const job = this.db.createJob(wikiId, type, payload ?? {});
    this.queue.notify(wikiId);
    this.db.logAudit(wikiId, `job.${type}.submitted`, `job #${job.id}`);

    // If wait mode, poll until job completes
    if (ctx.wait) {
      const result = await this.waitForJob(job.id);
      return { status: 200, body: { ok: true, data: result } };
    }

    return { status: 202, body: { ok: true, data: job } };
  }

  private async getJob(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);
    const jobId = Number(params['jobId']);
    const job = this.db.getJob(jobId);
    if (!job || job.wiki_id !== wikiId) throw new JobNotFoundError(jobId);
    return { status: 200, body: { ok: true, data: job } };
  }

  private async listJobs(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);
    const jobs = this.db.listJobs(wikiId, { limit: 50 });
    return { status: 200, body: { ok: true, data: jobs } };
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  private async getAuditLog(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);
    const log = this.db.getAuditLog(wikiId);
    return { status: 200, body: { ok: true, data: log } };
  }

  // ── File upload ──────────────────────────────────────────────────────────

  private async receiveFile(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);

    const b = requireBody(body);
    const filename = b.filename as string | undefined;
    const content = b.content as string | undefined;
    if (!filename || typeof filename !== 'string' || !content || typeof content !== 'string') {
      throw new ValidationError('filename (string) and content (base64 string) are required');
    }

    const buffer = Buffer.from(content, 'base64');
    const stored = this.scaffold.writeRawFile(wikiId, filename, buffer);

    return { status: 201, body: { ok: true, data: { filename: stored } } };
  }

  // ── File browsing ────────────────────────────────────────────────────

  private async listFiles(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);

    const prefix = ctx.query?.get('prefix') ?? '';
    const files = this.scaffold.listWikiFiles(wikiId, prefix);
    return { status: 200, body: { ok: true, data: files } };
  }

  private async readFile(params: Record<string, string>, body: unknown, ctx: RouteContext): Promise<RouteResponse> {
    const wikiId = params['id']!;
    this.requireWiki(wikiId, ctx.callerUid);

    const filePath = params['path']!;
    const content = this.scaffold.readWikiFile(wikiId, filePath);
    return { status: 200, body: { ok: true, data: { path: filePath, content } } };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private requireWiki(wikiId: string, callerUid: number) {
    const wiki = this.db.getWiki(wikiId);
    if (!wiki) throw new WikiNotFoundError(wikiId);
    if (wiki.owner_uid !== callerUid) throw new ForbiddenError(wikiId);
    return wiki;
  }

  private waitForJob(jobId: number, timeoutMs: number = 10 * 60_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const job = this.db.getJob(jobId);
        if (!job || job.status === 'completed' || job.status === 'failed') {
          resolve(job);
        } else if (Date.now() > deadline) {
          resolve(job); // return current state rather than error — client can poll again
        } else {
          setTimeout(check, JOB_POLL_INTERVAL_MS);
        }
      };
      check();
    });
  }
}

function isValidJobType(type: string): type is JobType {
  return type === 'ingest' || type === 'query' || type === 'lint';
}

/**
 * Validate that a request body is a non-null object.
 * Throws ValidationError if not.
 */
function requireBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}
