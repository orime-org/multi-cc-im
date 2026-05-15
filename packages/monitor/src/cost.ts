/**
 * cc transcript jsonl tail → per-session cost.
 *
 * cc writes each assistant turn as one JSON-line to
 * `~/.claude/projects/<slug>/<sid>.jsonl`. We read the file end-to-end
 * each `/api/cost` hit (no cache — DD §4 B0 pure-memory). For typical
 * dev session sizes (~hundreds of lines, ~1 MB) the parse cost is
 * sub-50ms — fine for an "on demand" surface.
 *
 * Cumulative cost = sum of every `assistant.message.usage` block in
 * the file (NOT just the latest). Matches cc's own `/cost` semantic.
 *
 * Per [DD 2026-05-15 §2](../../../docs/superpowers/specs/2026-05-15-cc-monitor-dashboard-dd.md)
 * fact-finding: usage field layout (verified 2026-05-15):
 *
 *   {
 *     "input_tokens": 9,
 *     "output_tokens": 2818,
 *     "cache_creation_input_tokens": 18296,
 *     "cache_read_input_tokens": 32116,
 *     "server_tool_use": {...}
 *   }
 *
 * Flat `cache_creation_input_tokens` (no 5m/1h split) — `conventions.md`
 * "/usage /cost 计算" 段写的旧子档已过期，单独 follow-up 修。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { computeUsd, priceForModel } from './prices.js';
import type { SessionCost } from './types.js';

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Parse a single jsonl line (cc transcript turn). Returns null if the
 * line isn't an assistant-message line with usage data (system / user /
 * partial-tool-use lines are skipped).
 */
function parseUsageLine(line: string): { usage: UsageBlock; model: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const msg = obj.message;
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  const usage = m.usage;
  if (!usage || typeof usage !== 'object') return null;
  const model = typeof m.model === 'string' ? m.model : null;
  return { usage: usage as UsageBlock, model };
}

/**
 * Aggregate token + USD cost for one cc transcript jsonl file.
 *
 * Errors (file unreadable / malformed JSON throughout) → returns
 * zero-token entry with `model: null`. Never throws; the dashboard
 * should still render even if one session's transcript is corrupt.
 */
export async function computeSessionCost(
  jsonlPath: string,
): Promise<SessionCost> {
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/, '');
  let content: string;
  try {
    content = await readFile(jsonlPath, 'utf-8');
  } catch {
    return {
      sessionId,
      jsonlPath,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      usdEstimate: 0,
      model: null,
    };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let lastModel: string | null = null;

  for (const line of content.split('\n')) {
    if (!line) continue;
    const parsed = parseUsageLine(line);
    if (!parsed) continue;
    inputTokens += parsed.usage.input_tokens ?? 0;
    outputTokens += parsed.usage.output_tokens ?? 0;
    cacheCreationInputTokens += parsed.usage.cache_creation_input_tokens ?? 0;
    cacheReadInputTokens += parsed.usage.cache_read_input_tokens ?? 0;
    if (parsed.model) lastModel = parsed.model;
  }

  return {
    sessionId,
    jsonlPath,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    model: lastModel,
    usdEstimate: computeUsd(priceForModel(lastModel), {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    }),
  };
}

/**
 * Find recent cc transcript jsonl files. Walks
 * `<projectsRoot>/<slug>/<sid>.jsonl`; returns most-recently-modified
 * first, capped by `limit`. mtime-based ordering means "active right
 * now" sessions surface first — exactly what dashboard wants.
 *
 * `projectsRoot` defaults to `~/.claude/projects/` (production). Tests
 * inject a fixture dir.
 */
export async function findRecentSessions(
  projectsRoot: string,
  limit = 20,
): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsRoot);
  } catch {
    return [];
  }

  // Glob each project's *.jsonl, collect (path, mtime), sort, slice.
  const candidates: Array<{ path: string; mtime: number }> = [];
  const { stat } = await import('node:fs/promises');
  for (const dir of projectDirs) {
    let entries: string[];
    try {
      entries = await readdir(join(projectsRoot, dir));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(projectsRoot, dir, f);
      try {
        const s = await stat(full);
        candidates.push({ path: full, mtime: s.mtimeMs });
      } catch {
        /* skip races (file deleted mid-walk) */
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.slice(0, limit).map((c) => c.path);
}
