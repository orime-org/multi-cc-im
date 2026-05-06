import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@multi-cc-im/storage-files';

/**
 * State file IO for cc session lifecycle.
 *
 * Per-session files live under `<stateDir>/<sessionId>.<suffix>` where
 * `stateDir` defaults to `~/.multi-cc-im/state/` (caller decides exact path).
 * The directory is **monitor-only** — it never accumulates cc conversation
 * content (cc's own transcript jsonl at `~/.claude/projects/<dir>/<sid>.jsonl`
 * already records that data). multi-cc-im keeps these per-event files purely
 * to bridge the hook subprocess ↔ daemon process gap.
 *
 * - `<sid>.SessionStart` — written by SessionStart hook with pid / startedAt /
 *                          paneId / cwd / transcript_path. Truncate-rewritten
 *                          on `claude --resume` (same sid). Long-lived for
 *                          the duration of the cc session.
 * - `<sid>.Stop.<ts>`    — written by Stop hook per-turn with the assistant
 *                          reply. Daemon reads → forwards to wechat → unlinks
 *                          (typical lifetime <100ms). Multiple files can
 *                          accumulate if daemon was down; processed in
 *                          timestamp order.
 * - `<sid>.SessionEnd`   — empty 0-byte tombstone written by SessionEnd hook.
 *                          Daemon checks file existence to mark cc dead.
 *
 * All writes go through `@multi-cc-im/storage-files`'s `atomicWrite` (mode
 * 0600 + same-dir tmp + fsync + rename). Reads are plain `readFile`; ENOENT
 * → null. Per [pane-alive strategy DD](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md)
 * + Storage DD pattern A (state files + atomic write, no SQL DB).
 */

function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

// ============================================================================
// File-name suffixes (single source of truth for adapter file-watch + sweep)
// ============================================================================

export const SESSION_START_SUFFIX = '.SessionStart';
export const SESSION_END_SUFFIX = '.SessionEnd';
export const STOP_PREFIX = '.Stop.';

/**
 * Convert a Date to a filesystem-safe ISO-style timestamp:
 * `2026-05-06T16:20:15.123Z` → `2026-05-06T16-20-15-123Z`.
 *
 * Colons are valid on POSIX filesystems but break Windows / SMB shares; periods
 * are fine but replacing both with `-` keeps the format uniform and
 * lexicographically-sortable (timestamps sort correctly as strings).
 */
export function formatStopTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

// ============================================================================
// SessionStart file: long-lived snapshot of cc session metadata
// ============================================================================

export interface SessionStartFile {
  /** cc parent process PID at SessionStart time. */
  pid: number;
  /**
   * Output of `ps -o lstart= -p <pid>` captured at SessionStart, used to detect
   * PID reuse on later isAlive checks. Stored verbatim (not parsed) — exact
   * string match is the comparison.
   */
  startedAt: string;
  /**
   * `process.env.WEZTERM_PANE` captured at SessionStart hook (cc inherits the
   * env from wezterm). Bridge session-registry uses this for the
   * `paneId → sessionId` reverse map. Optional: cc may run outside wezterm
   * (no env), in which case the session isn't routable from bridge.
   */
  paneId?: number;
  /**
   * `cwd` from SessionStart payload (already realpath'd by cc). Bridge
   * SessionRegistry stores so the session can be displayed / filtered by
   * project root without re-reading the payload.
   */
  cwd: string;
  /**
   * `transcript_path` from SessionStart payload (cc's own jsonl file path).
   * Reserved for future analytics work that wants to read cc's transcript
   * directly without spawning a hook.
   */
  transcript_path: string;
}

export interface PerSessionIO {
  stateDir: string;
  sessionId: string;
}

export function sessionStartPath(opts: PerSessionIO): string {
  return join(opts.stateDir, `${opts.sessionId}${SESSION_START_SUFFIX}`);
}

export async function writeSessionStartFile(
  opts: PerSessionIO & SessionStartFile,
): Promise<void> {
  const body: SessionStartFile = {
    pid: opts.pid,
    startedAt: opts.startedAt,
    ...(opts.paneId !== undefined ? { paneId: opts.paneId } : {}),
    cwd: opts.cwd,
    transcript_path: opts.transcript_path,
  };
  await atomicWrite(sessionStartPath(opts), JSON.stringify(body, null, 2));
}

export async function readSessionStartFile(
  opts: PerSessionIO,
): Promise<SessionStartFile | null> {
  return readJsonOrNull<SessionStartFile>(sessionStartPath(opts));
}

export async function deleteSessionStartFile(
  opts: PerSessionIO,
): Promise<void> {
  await unlinkOrIgnoreENOENT(sessionStartPath(opts));
}

// ============================================================================
// SessionEnd file: empty tombstone — file existence IS the signal
// ============================================================================

export function sessionEndPath(opts: PerSessionIO): string {
  return join(opts.stateDir, `${opts.sessionId}${SESSION_END_SUFFIX}`);
}

export async function writeSessionEndFile(opts: PerSessionIO): Promise<void> {
  // 0-byte tombstone — daemon only checks file existence; reason / endedAt
  // are intentionally NOT persisted (cc's transcript records the reason if
  // anyone really needs it; mtime gives endedAt for cleanup retention).
  await atomicWrite(sessionEndPath(opts), '');
}

export async function existsSessionEndFile(
  opts: PerSessionIO,
): Promise<boolean> {
  try {
    await readFile(sessionEndPath(opts));
    return true;
  } catch (err) {
    if (isENOENT(err)) return false;
    throw err;
  }
}

export async function deleteSessionEndFile(opts: PerSessionIO): Promise<void> {
  await unlinkOrIgnoreENOENT(sessionEndPath(opts));
}

// ============================================================================
// Stop files: per-turn transient queue (write → forward → unlink)
// ============================================================================

export interface StopFile {
  /** cc's last assistant message text — bridge forwards verbatim to wechat. */
  last_assistant_message: string;
}

export function stopFilePath(opts: PerSessionIO & { timestamp: string }): string {
  return join(
    opts.stateDir,
    `${opts.sessionId}${STOP_PREFIX}${opts.timestamp}`,
  );
}

export async function writeStopFile(
  opts: PerSessionIO & { timestamp: string; last_assistant_message: string },
): Promise<void> {
  const body: StopFile = { last_assistant_message: opts.last_assistant_message };
  await atomicWrite(stopFilePath(opts), JSON.stringify(body, null, 2));
}

/**
 * Read a Stop file by absolute path (chokidar 'add' gives us full paths).
 * Returns null on ENOENT — handles the daemon-double-event race where
 * chokidar fires twice for the same file.
 */
export async function readStopFile(filePath: string): Promise<StopFile | null> {
  return readJsonOrNull<StopFile>(filePath);
}

export async function deleteStopFile(filePath: string): Promise<void> {
  await unlinkOrIgnoreENOENT(filePath);
}

/**
 * List all `<sid>.Stop.*` files for a given session, sorted ascending by
 * timestamp suffix (= chronological order — daemon should process oldest
 * first when catching up after downtime).
 */
export async function listStopFiles(opts: PerSessionIO): Promise<string[]> {
  const prefix = `${opts.sessionId}${STOP_PREFIX}`;
  let entries: string[];
  try {
    entries = await readdir(opts.stateDir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => name.startsWith(prefix))
    .sort() // lexicographic = chronological for our timestamp format
    .map((name) => join(opts.stateDir, name));
}

// ============================================================================
// shared helpers
// ============================================================================

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    if (raw.length === 0) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

async function unlinkOrIgnoreENOENT(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}
