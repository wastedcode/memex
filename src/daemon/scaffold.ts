import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { WIKIS_DIR } from '../lib/constants.js';

const DEFAULT_CLAUDE_MD = `# Wiki Agent — Conventions

This file is auto-discovered by Claude Code and extends the base system prompt.
Use it to define wiki-specific conventions, domain vocabulary, and wiki structure.

The base system prompt handles core wiki behavior (index, schema, connections, log).
This file is for YOUR customizations on top of that.

## Domain

_(Describe what this knowledge base is about)_

## Conventions

_(Add wiki-specific filing rules, vocabulary, categories, and preferences here)_

## Things to ignore

_(Topics, patterns, or noise that should be skipped during ingestion)_
`;

// Schema is intentionally minimal — the LLM will create a proper one on first ingest
// when it sees the actual content and can establish meaningful conventions.
const DEFAULT_SCHEMA_MD = `# Schema

This file documents the conventions for this knowledge base.
It will be created and maintained by the wiki agent as content is ingested.

_(This is a new knowledge base. The schema will be populated on first ingest.)_
`;

const DEFAULT_INDEX_MD = `# Index

One-line summary of every wiki page, organized by category.
A reader should understand the shape of the knowledge base from this file alone.

_(No pages yet. The index will be populated as content is ingested.)_
`;

const DEFAULT_LOG_MD = `# Activity Log

Chronological record of knowledge base activity.

---
`;

export class WikiScaffold {
  constructor(private wikisDir: string = WIKIS_DIR) {}

  /**
   * Create the full directory structure and default files for a new wiki.
   */
  create(wikiId: string): void {
    const base = this.wikiDir(wikiId);

    // Directories
    mkdirSync(join(base, '.claude'), { recursive: true, mode: 0o700 });
    mkdirSync(join(base, '.tools'), { recursive: true });
    mkdirSync(join(base, 'wiki', 'raw'), { recursive: true });

    // Default files
    writeFileSync(join(base, '.claude.md'), DEFAULT_CLAUDE_MD);
    writeFileSync(join(base, 'wiki', '_schema.md'), DEFAULT_SCHEMA_MD);
    writeFileSync(join(base, 'wiki', '_index.md'), DEFAULT_INDEX_MD);
    writeFileSync(join(base, 'wiki', '_log.md'), DEFAULT_LOG_MD);
  }

  /**
   * Remove a wiki's directory tree.
   */
  destroy(wikiId: string, keepData: boolean = false): void {
    if (keepData) return;
    const dir = this.wikiDir(wikiId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Get the host filesystem path for a wiki's root directory.
   */
  wikiDir(wikiId: string): string {
    return join(this.wikisDir, wikiId);
  }

  /**
   * Write a file into the wiki's wiki/raw/ directory.
   * Prefixes with a timestamp to avoid collisions.
   * Returns the stored filename (relative to wiki/raw/).
   */
  writeRawFile(wikiId: string, filename: string, content: Buffer): string {
    const rawDir = join(this.wikiDir(wikiId), 'wiki', 'raw');
    mkdirSync(rawDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
    const stored = `${ts}-${sanitizeFilename(basename(filename))}`;
    writeFileSync(join(rawDir, stored), content);
    return stored;
  }

  /**
   * Read the wiki's .claude.md content.
   */
  readClaudeMd(wikiId: string): string {
    const p = join(this.wikiDir(wikiId), '.claude.md');
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf-8');
  }

  /**
   * Write the allowed-tools.txt file for a wiki.
   */
  writeAllowedTools(wikiId: string, tools: string[]): void {
    const toolsDir = join(this.wikiDir(wikiId), '.tools');
    mkdirSync(toolsDir, { recursive: true });
    const content = tools.length > 0
      ? tools.join('\n') + '\n'
      : '';
    writeFileSync(join(toolsDir, 'allowed-tools.txt'), content);
  }

  /**
   * Read the current allowed-tools.txt for a wiki.
   */
  readAllowedTools(wikiId: string): string[] {
    const p = join(this.wikiDir(wikiId), '.tools', 'allowed-tools.txt');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  }

  /**
   * List files in a wiki's wiki/ directory.
   * Returns an array of { path, type } entries relative to wiki/.
   * If prefix is given, only lists entries under that subdirectory.
   */
  listWikiFiles(wikiId: string, prefix: string = ''): Array<{ path: string; type: 'file' | 'directory' }> {
    const wikiContentDir = join(this.wikiDir(wikiId), 'wiki');
    const target = prefix ? join(wikiContentDir, prefix) : wikiContentDir;

    // Prevent directory traversal
    if (!target.startsWith(wikiContentDir)) {
      throw new Error('Invalid path');
    }

    if (!existsSync(target)) return [];

    const entries = readdirSync(target, { withFileTypes: true });
    const results: Array<{ path: string; type: 'file' | 'directory' }> = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      results.push({
        path: relPath,
        type: entry.isDirectory() ? 'directory' : 'file',
      });
    }

    return results.sort((a, b) => {
      // Directories first, then alphabetical
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }

  /**
   * Read a file from a wiki's wiki/ directory.
   * Returns the file content as a UTF-8 string.
   */
  readWikiFile(wikiId: string, filePath: string): string {
    const wikiContentDir = join(this.wikiDir(wikiId), 'wiki');
    const target = join(wikiContentDir, filePath);

    // Prevent directory traversal
    if (!target.startsWith(wikiContentDir)) {
      throw new Error('Invalid path');
    }

    if (!existsSync(target)) {
      throw new Error(`File not found: ${filePath}`);
    }

    return readFileSync(target, 'utf-8');
  }

  /**
   * Check if a wiki directory exists on disk.
   */
  exists(wikiId: string): boolean {
    return existsSync(this.wikiDir(wikiId));
  }
}

/**
 * Strip dangerous characters from filenames while preserving the extension.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
