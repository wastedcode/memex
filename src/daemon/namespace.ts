import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityError } from '../lib/errors.js';
import { WIKIS_DIR, WORKSPACE_MOUNT } from '../lib/constants.js';

/**
 * Per-job mount namespace isolation.
 *
 * Instead of persistent namespaces (which require kernel-specific unshare --mount=<file>),
 * we wrap each job command in `unshare -m -- sh -c '...'`. The namespace lives and dies
 * with the process. Simpler, more portable, same isolation.
 */
export class NamespaceManager {
  constructor(
    private wikisDir: string = WIKIS_DIR,
  ) {}

  /**
   * Verify that we have CAP_SYS_ADMIN by attempting a trivial namespace operation.
   */
  checkCapabilities(): void {
    try {
      execFileSync('unshare', ['-m', '--', 'true'], { stdio: 'pipe' });
    } catch {
      throw new CapabilityError();
    }
  }

  /**
   * Ensure the /workspace mount target exists on the host.
   */
  ensureDirectories(): void {
    mkdirSync(WORKSPACE_MOUNT, { recursive: true });
  }

  /**
   * Verify a wiki's directory exists.
   */
  validateWiki(wikiId: string): void {
    const wikiDir = join(this.wikisDir, wikiId);
    if (!existsSync(wikiDir)) {
      throw new Error(`Wiki directory does not exist: ${wikiDir}`);
    }
  }

  /**
   * Build the command + args to run a command inside a fresh mount namespace
   * with the wiki's directory bind-mounted to /workspace.
   *
   * Returns [command, ...args] to pass to spawn().
   * The caller appends their actual command (e.g. claude -p ...) to innerArgs.
   */
  wrapCommand(wikiId: string, innerCommand: string[]): { command: string; args: string[] } {
    const wikiDir = join(this.wikisDir, wikiId);

    // Build a shell script that:
    // 1. Bind-mounts the wiki dir to /workspace
    // 2. Remounts nosuid,nodev
    // 3. Remounts wiki/raw/ as read-only (immutable source archive)
    // 4. cd into /workspace
    // 5. exec the inner command
    const rawDir = join(wikiDir, 'wiki', 'raw');
    const rawMount = `${WORKSPACE_MOUNT}/wiki/raw`;
    const script = [
      `mount --bind ${shellEscape(wikiDir)} ${shellEscape(WORKSPACE_MOUNT)}`,
      `mount -o remount,nosuid,nodev ${shellEscape(WORKSPACE_MOUNT)}`,
      // raw/ is the immutable source archive — Claude can read but never write
      `mount --bind ${shellEscape(rawDir)} ${shellEscape(rawMount)}`,
      `mount -o remount,bind,ro ${shellEscape(rawMount)}`,
      `cd ${shellEscape(WORKSPACE_MOUNT)}`,
      `exec ${innerCommand.map(shellEscape).join(' ')}`,
    ].join(' && ');

    return {
      command: 'unshare',
      args: ['-m', '--propagation', 'private', '--', 'sh', '-c', script],
    };
  }
}

function shellEscape(s: string): string {
  // Wrap in single quotes, escaping any existing single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
