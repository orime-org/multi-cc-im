import { z } from 'zod';

/**
 * Storage strategy is **file-based** (no SQL DB) — see Storage DD
 * (`docs/superpowers/specs/2026-04-29-storage-strategy-dd.md`).
 *
 * Rather than a single monolithic CRUD interface, each persistence concern
 * gets a small purpose-specific capability interface below. Concrete
 * implementations live in `packages/storage-files/`.
 */

// ============================================================================
// CursorStore: iLink getupdates cursor (single string, atomic write)
// ============================================================================

/**
 * Persists a single string (the iLink long-poll cursor). Re-read on bridge
 * restart so messages aren't lost. CLAUDE.md "Key conventions": "iLink
 * long-polling must persist a cursor".
 */
export interface CursorStore {
  /** Returns the last persisted cursor, or null on first-run. */
  get(): Promise<string | null>;
  /** Atomically replace the persisted cursor. */
  set(cursor: string): Promise<void>;
}

// ============================================================================
// CredentialStore: per-IM 0600 JSON file for bot tokens & similar secrets
// ============================================================================

/**
 * Persists IM-specific credentials (e.g. lark `app_id` + `app_secret`) at a
 * 0600 JSON file. Per [DD: credentials persistence strategy](../../../../docs/superpowers/specs/2026-05-03-keychain-library-dd.md)
 * we don't use OS keychain — avoids the WSL / DPAPI same-user-process
 * gotchas and matches the established convention.
 *
 * One store instance = one IM's credentials file (e.g.
 * `~/.multi-cc-im/credentials/lark.json`). The credentials shape `T` is
 * IM-specific; concrete adapters declare their schema (zod) and pass it to
 * `createCredentialStore`.
 */
export interface CredentialStore<T> {
  /** Returns persisted credentials, or `null` on first run / after delete. */
  load(): Promise<T | null>;
  /** Atomically replace the credentials file (mode 0600 via atomicWrite). */
  save(credentials: T): Promise<void>;
  /** Remove the credentials file (logout). Idempotent — no-op if absent. */
  delete(): Promise<void>;
}

// ============================================================================
// ConfigStore: TOML-backed user config
// ============================================================================

/** Schema for `[acl]` — owner-only allowlist. */
export const ACLConfigSchema = z.object({
  owners: z.array(z.string()).default([]),
});
export type ACLConfig = z.infer<typeof ACLConfigSchema>;

/**
 * Schema for cached external CLI / interpreter absolute paths (per
 * architecture.md "External CLI tool path strategy"). Each field is the
 * resolved absolute path written back to `config.toml` after the first
 * successful startup discovery — subsequent starts hit the cache first
 * and only re-discover if the cached path is stale.
 *
 * - `wezterm`: WezTerm CLI binary (when user's terminal adapter is wezterm)
 * - `claude`: cc CLI binary (for daemon-spawned AI dispatch subprocesses)
 * - `python3`: Python 3 interpreter (when user's terminal adapter is
 *   iterm2 — daemon spawns it once per call to run `iterm2-helper.py`).
 *   Per [DD: iTerm2 adapter](../../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md).
 */
export const ExternalPathsSchema = z.object({
  wezterm: z.string().optional(),
  claude: z.string().optional(),
  python3: z.string().optional(),
});
export type ExternalPaths = z.infer<typeof ExternalPathsSchema>;

/**
 * Top-level shape of `~/.multi-cc-im/config.toml`. zod-validated on load
 * (zod parse failure = fail-fast per architecture.md).
 */
export const ConfigSchema = z.object({
  acl: ACLConfigSchema.default({ owners: [] }),
  external_paths: ExternalPathsSchema.default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Load / save the user's config.toml. Implementations must use atomic write. */
export interface ConfigStore {
  load(): Promise<Config>;
  save(config: Config): Promise<void>;
}

// ============================================================================
// PendingQueue: bridge-internal append-only message buffer
// ============================================================================

/**
 * A message that arrived from IM but has not yet been delivered to cc.
 * `payload` is opaque to PendingQueue; the bridge encodes its routing
 * decision into this field and decodes on drain.
 */
export interface PendingMsg {
  id: string;
  /** Unix milliseconds at enqueue time. */
  enqueuedAt: number;
  /** Adapter-decided message body (opaque to the queue). */
  payload: unknown;
}

/**
 * Append-only on-disk queue with offset-based ack — drain-and-replay
 * survives bridge restart without losing messages. Backed by JSONL file
 * + offset pointer per Storage DD.
 */
export interface PendingQueue {
  /** Append a message to the queue; returns assigned id + timestamp. */
  enqueue(msg: Omit<PendingMsg, 'id' | 'enqueuedAt'>): Promise<PendingMsg>;
  /**
   * Yield messages with offsets >= `offset`. Iterator may be terminated
   * early; offset advances only on explicit `ack`.
   */
  drainSince(offset: number): AsyncIterable<{ msg: PendingMsg; offset: number }>;
  /** Mark messages up to and including `offset` as delivered. */
  ack(offset: number): Promise<void>;
  /** Rewrite the on-disk file dropping pre-`offset` entries (operator hint). */
  compact(): Promise<void>;
}
