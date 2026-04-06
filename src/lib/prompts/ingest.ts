import type { IngestPayload } from '../types.js';

/**
 * Build the prompt for an ingest job.
 *
 * Claude reads the raw source files and integrates them into the wiki.
 * This is not just filing — it's building understanding. The wiki should
 * get richer with every ingest, not just wider.
 */
export function buildIngestPrompt(payload: IngestPayload): string {
  const fileList = payload.files
    .map(f => `- raw/${f}`)
    .join('\n');

  return `New source documents have been added to the knowledge base.

Source files to process:
${fileList}

Integrate these into the wiki:

1. Read each source file listed above.
2. Read _schema.md for current conventions (create it if it doesn't exist — this is a new knowledge base).
3. Read _index.md to see what's already filed.
4. Search existing wiki pages for related content (grep for names, topics, themes).
5. For each source document:
   a. Extract key facts, concepts, entities, and relationships.
   b. Determine which existing pages should be updated and which new pages should be created.
   c. Create or update wiki pages with the extracted information.
   d. Maintain bidirectional links — if you link A→B, update B→A too.
   e. Update _index.md with current summaries for all affected pages.
6. Append a dated ingest entry to _log.md summarizing what was ingested and what pages were affected.
7. **Reflect on the schema.** Before finishing, re-read _schema.md and ask yourself:
   - Have I established patterns that aren't documented? (e.g. bug lifecycle stages, severity conventions, required fields for a category)
   - Are there recurring structures across pages in the same category? (e.g. all bugs have Status/Reporter/Impact — codify that)
   - Has my filing behavior drifted from what the schema says? Update the schema to match reality.
   - Are there cross-category patterns worth noting? (e.g. "bugs should always link to their owning product")
   - Would a future version of me, seeing this schema for the first time, make the same decisions I just made?
   The schema is your institutional memory. If you learned something from this ingest — a new convention, a refinement, a pattern — write it down. Vocabulary, heuristics, page templates, lifecycle stages, things to ignore. The schema should get richer with every ingest, not just when new categories appear.

Rules:
- NEVER modify files in raw/ — they are immutable sources (this is enforced by the filesystem)
- Prefer updating existing pages over creating duplicates
- If a source contradicts existing wiki content, UPDATE the existing page — resolve or flag the contradiction
- Keep pages focused — one topic per page
- Use descriptive kebab-case paths: themes/pricing-feedback.md, customers/acme-corp.md
- Every page must have a ## Related section with labeled, bidirectional links
- The "reason" for each change should articulate what it ADDS to the knowledge base — not mechanics

After completing all file operations, output ONLY valid JSON (no markdown fences, no explanation):
{
  "summary": "one-line human summary of what you filed",
  "operations": [
    {"action": "create|update", "path": "relative/path.md", "reason": "what this adds to the knowledge base"}
  ]
}`;
}
