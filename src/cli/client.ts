import { request as httpRequest, type RequestOptions } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  ApiResponse, Wiki, WikiConfig, QueueJob, JobType, AuditEntry,
} from '../lib/types.js';
import { SOCKET_PATH, JOB_POLL_INTERVAL_MS } from '../lib/constants.js';
import { DaemonNotRunningError } from '../lib/errors.js';

export class MemexClient {
  constructor(private socketPath: string = SOCKET_PATH) {}

  // ── Generic request ────────────────────────────────────────────────────

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    return new Promise((resolve, reject) => {
      const opts: RequestOptions = {
        socketPath: this.socketPath,
        method,
        path,
        headers: { 'Content-Type': 'application/json' },
      };

      const req = httpRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve(JSON.parse(raw) as ApiResponse<T>);
          } catch {
            resolve({ ok: false, error: raw } as ApiResponse<T>);
          }
        });
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          reject(new DaemonNotRunningError());
        } else {
          reject(err);
        }
      });

      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Make a request and stream the raw response body chunks.
   * Used for login flow where we stream CLI output.
   */
  async stream(method: string, path: string, body?: unknown): Promise<AsyncIterable<string>> {
    return new Promise((resolve, reject) => {
      const opts: RequestOptions = {
        socketPath: this.socketPath,
        method,
        path,
        headers: { 'Content-Type': 'application/json' },
      };

      const req = httpRequest(opts, (res) => {
        // Track response errors so the async iterator can propagate them
        let responseError: Error | null = null;
        res.on('error', (err) => { responseError = err; });

        const iterable: AsyncIterable<string> = {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise((resolveNext, rejectNext) => {
                  if (responseError) {
                    rejectNext(responseError);
                    return;
                  }
                  const onData = (chunk: Buffer) => {
                    res.removeListener('end', onEnd);
                    res.removeListener('error', onError);
                    resolveNext({ value: chunk.toString('utf-8'), done: false });
                  };
                  const onEnd = () => {
                    res.removeListener('data', onData);
                    res.removeListener('error', onError);
                    resolveNext({ value: '', done: true });
                  };
                  const onError = (err: Error) => {
                    res.removeListener('data', onData);
                    res.removeListener('end', onEnd);
                    rejectNext(err);
                  };
                  res.once('data', onData);
                  res.once('end', onEnd);
                  res.once('error', onError);
                });
              },
            };
          },
        };
        resolve(iterable);
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          reject(new DaemonNotRunningError());
        } else {
          reject(err);
        }
      });

      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // ── Convenience methods ────────────────────────────────────────────────

  createWiki(id: string, name?: string) {
    return this.request<Wiki>('POST', '/wikis', { id, name });
  }

  listWikis() {
    return this.request<Wiki[]>('GET', '/wikis');
  }

  getWiki(id: string) {
    return this.request<Wiki & { pending_jobs: number }>('GET', `/wikis/${id}`);
  }

  destroyWiki(id: string, keepData: boolean = false) {
    return this.request('DELETE', `/wikis/${id}`, { keepData });
  }

  updateConfig(wikiId: string, config: WikiConfig) {
    return this.request<Wiki>('PUT', `/wikis/${wikiId}/config`, config);
  }

  chownWiki(wikiId: string, uid: number) {
    return this.request<Wiki>('POST', `/wikis/${wikiId}/chown`, { uid });
  }

  setApiKey(wikiId: string, key: string) {
    return this.request('POST', `/wikis/${wikiId}/api-key`, { key });
  }

  setCredentials(wikiId: string, credentials: string) {
    return this.request('POST', `/wikis/${wikiId}/credentials`, { credentials });
  }

  submitJob(wikiId: string, type: JobType, payload: object, wait: boolean = false) {
    const path = `/wikis/${wikiId}/jobs` + (wait ? '?wait=true' : '');
    return this.request<QueueJob>('POST', path, { type, payload });
  }

  getJob(wikiId: string, jobId: number) {
    return this.request<QueueJob>('GET', `/wikis/${wikiId}/jobs/${jobId}`);
  }

  listJobs(wikiId: string) {
    return this.request<QueueJob[]>('GET', `/wikis/${wikiId}/jobs`);
  }

  listFiles(wikiId: string, prefix?: string) {
    const path = `/wikis/${wikiId}/files` + (prefix ? `?prefix=${encodeURIComponent(prefix)}` : '');
    return this.request<Array<{ path: string; type: 'file' | 'directory' }>>('GET', path);
  }

  readFile(wikiId: string, filePath: string) {
    return this.request<{ path: string; content: string }>('GET', `/wikis/${wikiId}/files/${filePath}`);
  }

  getAuditLog(wikiId: string, limit?: number) {
    const path = `/wikis/${wikiId}/logs` + (limit ? `?limit=${limit}` : '');
    return this.request<AuditEntry[]>('GET', path);
  }

  /**
   * Upload a local file to the daemon for ingestion into a wiki's raw/ directory.
   */
  async uploadFile(wikiId: string, localPath: string): Promise<ApiResponse<{ filename: string }>> {
    const content = readFileSync(localPath);
    const filename = basename(localPath);
    return this.request<{ filename: string }>('POST', `/wikis/${wikiId}/ingest-file`, {
      filename,
      content: content.toString('base64'),
    });
  }

  /**
   * Submit a job and poll until it completes.
   */
  async waitForJob(wikiId: string, jobId: number, onPoll?: (job: QueueJob) => void): Promise<QueueJob> {
    while (true) {
      const resp = await this.getJob(wikiId, jobId);
      if (!resp.ok || !resp.data) {
        throw new Error(resp.error ?? 'Failed to get job status');
      }

      const job = resp.data;
      if (onPoll) onPoll(job);

      if (job.status === 'completed' || job.status === 'failed') {
        return job;
      }

      await sleep(JOB_POLL_INTERVAL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
