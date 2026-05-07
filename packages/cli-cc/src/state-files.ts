import { execFile } from 'node:child_process';
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
export const PERMISSION_REQUEST_PREFIX = '.PermissionRequest.';
export const PERMISSION_RESPONSE_PREFIX = '.PermissionResponse.';
/** Per [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md) — global IM-mode tombstone. */
export const IM_WORK_FILE_NAME = 'IMWork';
/** Per the same DD — per-session IMReplyContext snapshot. */
export const IM_ORIGIN_SUFFIX = '.IMOrigin';
/** Per [DD: daemon liveness](../../../docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md) — daemon PID lock file. */
export const DAEMON_PID_FILE_NAME = 'daemon.pid';

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
// Permission request / response files: hook-subprocess ↔ daemon IPC for
// `@<tabname> /1` (allow) / `/2` (deny) IM審批 per [DD permission forward](../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md).
//
// Lifecycle:
//   1. cc PreToolUse hook → hook subprocess writes <sid>.PermissionRequest.<id>.json
//   2. daemon (chokidar) picks up the file, forwards prompt to IM
//   3. IM user replies → daemon writes <sid>.PermissionResponse.<id>.json
//   4. hook subprocess (polling) reads response, then unlinks both files
//      and exits with stdout `{permissionDecision: ...}`.
//   5. On daemon-down: cleanup sweep deletes orphan request/response files.
// ============================================================================

export interface PermissionRequestFile {
  /** Random short id used to pair Request → Response. */
  requestId: string;
  /** Tool cc wants to call (e.g. `'Bash'`, `'Edit'`, `'WebFetch'`). */
  toolName: string;
  /** cc's tool_input verbatim (per-tool schema). */
  toolInput: Record<string, unknown>;
  /** When hook wrote the file (ms epoch). Daemon may use to detect stale. */
  createdAt: number;
}

export interface PermissionResponseFile {
  /** Echoes the request id so hook subprocess matches its own request. */
  requestId: string;
  /** User's decision relayed from IM. */
  decision: 'allow' | 'deny';
  /** Human-readable reason — passed through to cc as
   *  `permissionDecisionReason` so cc transcript records why. */
  reason: string;
}

export function permissionRequestPath(
  opts: PerSessionIO & { requestId: string },
): string {
  return join(
    opts.stateDir,
    `${opts.sessionId}${PERMISSION_REQUEST_PREFIX}${opts.requestId}.json`,
  );
}

export function permissionResponsePath(
  opts: PerSessionIO & { requestId: string },
): string {
  return join(
    opts.stateDir,
    `${opts.sessionId}${PERMISSION_RESPONSE_PREFIX}${opts.requestId}.json`,
  );
}

export async function writePermissionRequestFile(
  opts: PerSessionIO & PermissionRequestFile,
): Promise<void> {
  const body: PermissionRequestFile = {
    requestId: opts.requestId,
    toolName: opts.toolName,
    toolInput: opts.toolInput,
    createdAt: opts.createdAt,
  };
  await atomicWrite(
    permissionRequestPath(opts),
    JSON.stringify(body, null, 2),
  );
}

export async function readPermissionRequestFile(
  filePath: string,
): Promise<PermissionRequestFile | null> {
  return readJsonOrNull<PermissionRequestFile>(filePath);
}

export async function writePermissionResponseFile(
  opts: PerSessionIO & PermissionResponseFile,
): Promise<void> {
  const body: PermissionResponseFile = {
    requestId: opts.requestId,
    decision: opts.decision,
    reason: opts.reason,
  };
  await atomicWrite(
    permissionResponsePath(opts),
    JSON.stringify(body, null, 2),
  );
}

export async function readPermissionResponseFile(
  filePath: string,
): Promise<PermissionResponseFile | null> {
  return readJsonOrNull<PermissionResponseFile>(filePath);
}

export async function deletePermissionRequestFile(
  opts: PerSessionIO & { requestId: string },
): Promise<void> {
  await unlinkOrIgnoreENOENT(permissionRequestPath(opts));
}

export async function deletePermissionResponseFile(
  opts: PerSessionIO & { requestId: string },
): Promise<void> {
  await unlinkOrIgnoreENOENT(permissionResponsePath(opts));
}

/**
 * Delete a permission Request/Response file by absolute path. Mirrors
 * `deleteStopFile`'s API — useful when sweeping per-sid orphans returned
 * by `listPermission*Files` without re-parsing the request id from the
 * filename.
 */
export async function deletePermissionFileByPath(
  filePath: string,
): Promise<void> {
  await unlinkOrIgnoreENOENT(filePath);
}

/**
 * List all `<sid>.PermissionRequest.*` files for a given session. Used by
 * the PreToolUse hook subprocess to sweep orphans before writing its own
 * Request (mirrors Stop's "clear stale before write" pattern).
 */
export async function listPermissionRequestFiles(
  opts: PerSessionIO,
): Promise<string[]> {
  const prefix = `${opts.sessionId}${PERMISSION_REQUEST_PREFIX}`;
  let entries: string[];
  try {
    entries = await readdir(opts.stateDir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(opts.stateDir, name));
}

export async function listPermissionResponseFiles(
  opts: PerSessionIO,
): Promise<string[]> {
  const prefix = `${opts.sessionId}${PERMISSION_RESPONSE_PREFIX}`;
  let entries: string[];
  try {
    entries = await readdir(opts.stateDir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(opts.stateDir, name));
}

// ============================================================================
// IMWork: global tombstone — file exists ⇔ user is in IM mode (manual switch
// via @multi-cc-im /start /stop). Per [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md).
//
// Contents: 0-byte tombstone (file existence IS the signal). Lifecycle:
//   - daemon writes on `@multi-cc-im /start`
//   - daemon deletes on `@multi-cc-im /stop`
//   - daemon deletes on every daemon start (auto-reset to local mode)
// ============================================================================

export function imWorkPath(stateDir: string): string {
  return join(stateDir, IM_WORK_FILE_NAME);
}

export async function writeIMWorkFile(stateDir: string): Promise<void> {
  // 0-byte tombstone — content is intentionally empty.
  await atomicWrite(imWorkPath(stateDir), '');
}

export async function existsIMWorkFile(stateDir: string): Promise<boolean> {
  try {
    await readFile(imWorkPath(stateDir));
    return true;
  } catch (err) {
    if (isENOENT(err)) return false;
    throw err;
  }
}

export async function deleteIMWorkFile(stateDir: string): Promise<void> {
  await unlinkOrIgnoreENOENT(imWorkPath(stateDir));
}

// ============================================================================
// IMOrigin: per-session IMReplyContext snapshot. Tracks "the most recent IM
// dispatch ctx for this cc". Per [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md).
//
// Contents: opaque IMReplyContext JSON — bridge stores adapter-defined value
// without inspecting it (mirrors `ReplyContext = unknown` design in shared).
// Lifecycle:
//   - daemon writes/overwrites on every IM dispatch to this cc (B2 — newest ctx wins)
//   - daemon deletes after cc Stop forward (one-shot)
//   - daemon start sweep (orphan cleanup)
// ============================================================================

export function imOriginPath(opts: PerSessionIO): string {
  return join(opts.stateDir, `${opts.sessionId}${IM_ORIGIN_SUFFIX}`);
}

export async function writeIMOriginFile(
  opts: PerSessionIO & { replyCtx: unknown },
): Promise<void> {
  // Overwrite semantic — newest ctx wins (B2 per DD).
  await atomicWrite(imOriginPath(opts), JSON.stringify(opts.replyCtx, null, 2));
}

export async function readIMOriginFile(opts: PerSessionIO): Promise<unknown> {
  return readJsonOrNull<unknown>(imOriginPath(opts));
}

export async function existsIMOriginFile(opts: PerSessionIO): Promise<boolean> {
  try {
    await readFile(imOriginPath(opts));
    return true;
  } catch (err) {
    if (isENOENT(err)) return false;
    throw err;
  }
}

export async function deleteIMOriginFile(opts: PerSessionIO): Promise<void> {
  await unlinkOrIgnoreENOENT(imOriginPath(opts));
}

/** List all `<sid>.IMOrigin` files in the state dir (used by daemon start sweep). */
export async function listIMOriginFiles(stateDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(IM_ORIGIN_SUFFIX))
    .map((name) => join(stateDir, name));
}

// ============================================================================
// daemon.pid: PID lock for the daemon process. Per
// [DD: daemon liveness](../../../docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md).
//
// Lifecycle:
//   - daemon start → write { pid, startedAt } (unless another daemon
//     already running — start enforces double-start guard via isDaemonAlive)
//   - daemon stop  → delete (Ctrl+C / graceful shutdown)
//   - daemon SIGKILL'd → file leaks; next daemon start sees it as "stale
//     lock" (PID dead OR lstart mismatch) and overwrites
//
// `startedAt` is the verbatim output of `ps -o lstart= -p <pid>` (e.g.
// "Mon May  9 10:00:00 2026"). Stored alongside PID specifically to defend
// against PID reuse — when the OS recycles a dead daemon's PID to some
// unrelated process, lstart of that PID won't match what we recorded so
// `isDaemonAlive` returns false correctly.
// ============================================================================

export interface DaemonPidFile {
  pid: number;
  /**
   * Output of `ps -o lstart= -p <pid>` captured at daemon start, used to
   * detect PID reuse on later isDaemonAlive checks. Stored verbatim.
   */
  startedAt: string;
}

export function daemonPidPath(stateDir: string): string {
  return join(stateDir, DAEMON_PID_FILE_NAME);
}

export async function writeDaemonPidFile(
  opts: { stateDir: string } & DaemonPidFile,
): Promise<void> {
  const body: DaemonPidFile = {
    pid: opts.pid,
    startedAt: opts.startedAt,
  };
  await atomicWrite(daemonPidPath(opts.stateDir), JSON.stringify(body, null, 2));
}

export async function readDaemonPidFile(
  stateDir: string,
): Promise<DaemonPidFile | null> {
  return readJsonOrNull<DaemonPidFile>(daemonPidPath(stateDir));
}

export async function deleteDaemonPidFile(stateDir: string): Promise<void> {
  await unlinkOrIgnoreENOENT(daemonPidPath(stateDir));
}

/**
 * Capture the OS process start-time string for a given PID via
 * `ps -o lstart= -p <pid>`. Returns null on ENOENT (PID does not exist) or
 * any non-zero exit code (PID may be in another user / kernel process).
 *
 * Used by `isDaemonAlive` for PID-reuse defense and by daemon start's
 * double-start check.
 */
export async function captureProcessLstart(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { timeout: 5_000 },
      (err, stdout) => {
        if (err) {
          // err.code = ESRCH (PID not found) or non-zero exit. Either way,
          // we treat as "no lstart available" rather than throwing — caller
          // (isDaemonAlive) interprets null as "PID dead/inaccessible".
          resolve(null);
          return;
        }
        const trimmed = stdout.trim();
        resolve(trimmed.length === 0 ? null : trimmed);
      },
    );
  });
}

/**
 * Check whether the daemon recorded in `<stateDir>/daemon.pid` is still
 * alive. Two-step verification per [DD: daemon liveness] candidate d:
 *
 *   1. `process.kill(pid, 0)` — fast existence test (no fork)
 *   2. `ps -o lstart= -p <pid>` — verify the PID still belongs to the
 *      same process we recorded (defends against OS PID reuse)
 *
 * Returns:
 *   - false if no daemon.pid file
 *   - false if PID does not exist (ESRCH / EPERM)
 *   - false if PID exists but lstart string differs from recorded
 *   - true otherwise
 *
 * Throws only on unexpected fs errors (file unreadable, permission, etc.).
 */
export async function isDaemonAlive(stateDir: string): Promise<boolean> {
  const file = await readDaemonPidFile(stateDir);
  if (file === null) return false;

  // Step 1: PID existence (signal 0 doesn't actually kill anything)
  try {
    process.kill(file.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw err;
  }

  // Step 2: PID-reuse defense — actual lstart must match recorded
  const actualLstart = await captureProcessLstart(file.pid);
  return actualLstart !== null && actualLstart === file.startedAt;
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
