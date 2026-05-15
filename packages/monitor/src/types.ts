/**
 * Shared types for `@multi-cc-im/monitor`.
 *
 * Per [DD 2026-05-15: cc 监控 dashboard](../../../docs/superpowers/specs/2026-05-15-cc-monitor-dashboard-dd.md):
 * monitor is read-only — pulls live state from daemon + tails cc transcript
 * jsonl on demand; no persistent storage of its own (B0 pure-memory).
 */

import type { TerminalId } from '@multi-cc-im/shared';

/**
 * Live daemon health snapshot — recomputed each dashboard render.
 * No history; just "right now".
 */
export interface DaemonStateSnapshot {
  pid: number;
  startedAt: string;
  uptimeSeconds: number;
  /** Active terminal id (whichever the wizard / config picked). */
  activeTerminal: TerminalId;
  /** Active IM adapter id. */
  imAdapter: string;
  /**
   * IM connection state. Lark WSClient: `'connected' | 'connecting' | 'unknown'`.
   * `connecting` covers initial dial + retry loop (PR #172).
   */
  imConnection: 'connected' | 'connecting' | 'unknown';
  /** Most recent reconnect timestamp, or null if never reconnected this run. */
  imLastReconnectAt: string | null;
  /** Cumulative reconnect attempts since daemon start. */
  imReconnectAttempts: number;
}

/**
 * Per-cc-tab snapshot. Pulled from `termAdapter.listPanes()` each render —
 * daemon's source of truth for which cc tabs exist (DD 2026-05-08 撤销 PaneAlive).
 */
export interface SessionSnapshot {
  /** `PaneId` opaque — number for wezterm, UUID-string for iterm2. Stringified for display. */
  paneId: string;
  title: string;
  cwd: string;
  /** Has the user run `/rename <name>` inside cc TUI? */
  hasRenamed: boolean;
  /** Computed: `hasRenamed && title.length > 0`. */
  addressable: boolean;
}

/** A single entry in the error ring buffer. */
export interface ErrorEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Logical phase / category — e.g. `'imAdapter'`, `'forwardStop'`. */
  phase: string;
  /** Human-readable message (first line of error.message). */
  message: string;
}

/**
 * Per-cc-session cost aggregate — recomputed by tailing the jsonl on each
 * `/api/cost` hit. No internal cache (B0 pure-memory).
 *
 * Per cc transcript jsonl schema (实测 2026-05-15):
 *   "usage": {
 *     "input_tokens": <int>,
 *     "output_tokens": <int>,
 *     "cache_creation_input_tokens": <int>,   // flat, not 5m/1h split
 *     "cache_read_input_tokens": <int>,
 *     "server_tool_use": {...}
 *   }
 *
 * Drive-by: docs/conventions.md 「/usage /cost 计算 (v2 deferred)」 段记的
 * `cache_creation.ephemeral_5m/1h_input_tokens` 字段是早期 cc 版本，已过期。
 */
export interface SessionCost {
  /** cc session id (UUID, basename of jsonl). */
  sessionId: string;
  /** Approximate path to the source jsonl (relative to ~/.claude/projects/). */
  jsonlPath: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** USD price computed from `prices.ts` frozen LiteLLM Claude 4.x table. */
  usdEstimate: number;
  /** Model the cost was computed against (last seen `model` field in jsonl). */
  model: string | null;
}
