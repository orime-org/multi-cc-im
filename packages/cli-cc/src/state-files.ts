import { execFile } from 'node:child_process';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '@multi-cc-im/storage-files';
import {
  IMReplyContextSchema,
  type IMReplyContext,
} from '@multi-cc-im/shared';

/**
 * State file IO for cc session lifecycle, post-DD #61
 * (pane-keyed state files, see [DD](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)).
 *
 * Files live under `<stateDir>` (typically `~/.multi-cc-im/state/`). Two
 * categories:
 *
 * **Top-level (per-daemon):**
 * - `IMWork`         — JSON `{auto:boolean}`; user controls via @multi-cc-im /start [auto] /stop.
 *                      File existence ⇔ IM mode ON. 0-byte (legacy) → `{auto:false}`.
 * - `daemon.pid`     — daemon PID lock (JSON `{pid, startedAt}`)
 * - `wechat-cursor`  — iLink long-poll cursor (handled by im-wechat package, not here)
 *
 * **Per-pane (cc-fired or daemon-fired, prefixed by wezterm pane id):**
 * - `<paneId>_<sid>.Stop.<ts>`                    — cc Stop hook writes
 * - `<paneId>_<sid>.PermissionRequest.<id>.json`  — cc PreToolUse hook writes
 * - `<paneId>_<sid>.PermissionResponse.<id>.json` — daemon writes (mirrors Request key)
 * - `<paneId>.IMOrigin`                           — daemon writes (single paneId — daemon
 *                                                   doesn't know sid at IM dispatch time)
 *
 * **Filter-by-naming**: the `<paneId>_<sid>.<event>` format is itself the
 * proof of authenticity. Only a hook subprocess invoked by cc inside a
 * wezterm tab can construct it (paneId from `process.env.WEZTERM_PANE`,
 * sid from cc hook payload). vim / ssh / VS Code-launched cc cannot
 * produce these files. See [DD](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md).
 *
 * All writes go through `@multi-cc-im/storage-files`'s `atomicWrite` (mode
 * 0600 + same-dir tmp + fsync + rename). Reads are plain `readFile`; ENOENT
 * → null.
 */

function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

// ============================================================================
// File-name suffixes / prefixes (single source of truth for adapter file-watch
// + sweep + filename parsers).
// ============================================================================

export const STOP_PREFIX = '.Stop.';

/**
 * Convert a Date to a filesystem-safe ISO-style timestamp:
 * `2026-05-08T16:20:15.123Z` → `2026-05-08T16-20-15-123Z`.
 *
 * Used as the suffix in `<paneId>_<sid>.Stop.<ts>` filenames. The colon-free
 * form is portable across POSIX + Windows / SMB shares; lexicographic sort
 * still equals chronological order (so daemon catch-up after downtime
 * processes oldest-first naturally).
 */
export function formatStopTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export const PERMISSION_REQUEST_PREFIX = '.PermissionRequest.';
export const PERMISSION_RESPONSE_PREFIX = '.PermissionResponse.';
/** Per [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md) — global IM-mode tombstone. */
export const IM_WORK_FILE_NAME = 'IMWork';
/** Per [DD: pane-keyed state](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md) — per-pane IM reply ctx. */
export const IM_ORIGIN_SUFFIX = '.IMOrigin';
/** Per [DD: daemon liveness](../../../docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md) — daemon PID lock file. */
export const DAEMON_PID_FILE_NAME = 'daemon.pid';

// ============================================================================
// Per-pane IO opts (double-keyed — for Stop + Permission files)
// ============================================================================

/** IO options used by `<paneId>_<sid>.<event>` files (Stop + PermissionRequest/Response). */
export interface PerPaneIO {
  stateDir: string;
  /** Wezterm pane id (numeric, from `process.env.WEZTERM_PANE`). */
  paneId: number;
  /** cc session id (UUID v4, from hook payload). */
  sessionId: string;
}

function paneSidPrefix(paneId: number, sessionId: string): string {
  return `${paneId}_${sessionId}`;
}

// ============================================================================
// Filename parsers
//
// Used by daemon (chokidar add events give absolute paths; daemon parses
// filename to extract paneId + sid + extra metadata for routing).
// ============================================================================

const PANE_SID_PATTERN =
  /^(\d+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export interface ParsedStopFilename {
  paneId: number;
  sessionId: string;
  /** Timestamp suffix verbatim (e.g. `2026-05-08T01-43-40-131Z`). */
  timestamp: string;
}

/**
 * Parse `<paneId>_<sid>.Stop.<ts>` filename. Returns null if the basename
 * doesn't match (caller should ignore — could be IMWork / daemon.pid /
 * unrelated file).
 *
 * Accepts either basename or absolute path.
 */
export function parseStopFilename(name: string): ParsedStopFilename | null {
  const base = name.includes('/') ? name.split('/').pop()! : name;
  const m = base.match(
    /^(\d+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.Stop\.(.+)$/,
  );
  if (!m) return null;
  return {
    paneId: Number(m[1]),
    sessionId: m[2]!,
    timestamp: m[3]!,
  };
}

export interface ParsedPermissionFilename {
  paneId: number;
  sessionId: string;
  /** 8-char hex request id. */
  requestId: string;
  kind: 'request' | 'response';
}

export function parsePermissionFilename(
  name: string,
): ParsedPermissionFilename | null {
  const base = name.includes('/') ? name.split('/').pop()! : name;
  const m = base.match(
    /^(\d+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.Permission(Request|Response)\.([0-9a-f]+)\.json$/,
  );
  if (!m) return null;
  return {
    paneId: Number(m[1]),
    sessionId: m[2]!,
    kind: m[3] === 'Request' ? 'request' : 'response',
    requestId: m[4]!,
  };
}

export interface ParsedIMOriginFilename {
  paneId: number;
}

export function parseIMOriginFilename(
  name: string,
): ParsedIMOriginFilename | null {
  const base = name.includes('/') ? name.split('/').pop()! : name;
  const m = base.match(/^(\d+)\.IMOrigin$/);
  if (!m) return null;
  return { paneId: Number(m[1]) };
}

/**
 * Generic "is this filename a pane-prefixed cc-hook file?" check.
 * Used by state-sweep to decide whether a file falls under "per-pane" cleanup
 * (vs top-level files like IMWork / daemon.pid / wechat-cursor).
 */
export function extractPaneIdFromFilename(name: string): number | null {
  const base = name.includes('/') ? name.split('/').pop()! : name;
  // <paneId>_<sid>.<event> (Stop / Permission*)
  const m1 = base.match(PANE_SID_PATTERN);
  if (m1) return Number(m1[1]);
  // <paneId>.IMOrigin
  const m2 = base.match(/^(\d+)\.IMOrigin$/);
  if (m2) return Number(m2[1]);
  return null;
}

// ============================================================================
// Stop file: per-turn transient queue (write → daemon forward → unlink)
// ============================================================================

export interface StopFile {
  /** cc's last assistant message text — bridge forwards verbatim to wechat. */
  last_assistant_message: string;
}

export function stopFilePath(opts: PerPaneIO & { timestamp: string }): string {
  return join(
    opts.stateDir,
    `${paneSidPrefix(opts.paneId, opts.sessionId)}${STOP_PREFIX}${opts.timestamp}`,
  );
}

export async function writeStopFile(
  opts: PerPaneIO & { timestamp: string; last_assistant_message: string },
): Promise<void> {
  const body: StopFile = { last_assistant_message: opts.last_assistant_message };
  await atomicWrite(stopFilePath(opts), JSON.stringify(body, null, 2));
}

/**
 * Read a Stop file by absolute path (chokidar 'add' event provides it).
 * Returns null on ENOENT — handles the daemon-double-event race.
 */
export async function readStopFile(filePath: string): Promise<StopFile | null> {
  return readJsonOrNull<StopFile>(filePath);
}

export async function deleteStopFile(filePath: string): Promise<void> {
  await unlinkOrIgnoreENOENT(filePath);
}

/**
 * List all `<paneId>_<sid>.Stop.*` files for a given pane+sid pair, sorted
 * by timestamp suffix (= chronological). Caller (hook subprocess) uses this
 * to clear stale Stop files before writing a new one.
 */
export async function listStopFiles(opts: PerPaneIO): Promise<string[]> {
  const prefix = `${paneSidPrefix(opts.paneId, opts.sessionId)}${STOP_PREFIX}`;
  let entries: string[];
  try {
    entries = await readdir(opts.stateDir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => join(opts.stateDir, name));
}

// ============================================================================
// Permission Request / Response: hook-subprocess ↔ daemon IPC for
// `@<tab> /1` (allow) / `/2` (deny) IM 审批.
//
// Per [DD: permission forward](../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md)
// + DD #61 (pane-keyed). Lifecycle:
//   1. cc PreToolUse → hook subprocess writes <paneId>_<sid>.PermissionRequest.<id>.json
//   2. daemon (chokidar add) parses paneId, looks up <paneId>.IMOrigin → forwards prompt to IM
//   3. IM user replies → daemon writes <paneId>_<sid>.PermissionResponse.<id>.json (copies pane+sid)
//   4. hook subprocess (polling) reads response → unlinks both files → exits with cc decision
//   5. On hook crash: daemon-side reaper backstop unlinks ~10s after Request appears
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
  opts: PerPaneIO & { requestId: string },
): string {
  return join(
    opts.stateDir,
    `${paneSidPrefix(opts.paneId, opts.sessionId)}${PERMISSION_REQUEST_PREFIX}${opts.requestId}.json`,
  );
}

export function permissionResponsePath(
  opts: PerPaneIO & { requestId: string },
): string {
  return join(
    opts.stateDir,
    `${paneSidPrefix(opts.paneId, opts.sessionId)}${PERMISSION_RESPONSE_PREFIX}${opts.requestId}.json`,
  );
}

export async function writePermissionRequestFile(
  opts: PerPaneIO & PermissionRequestFile,
): Promise<void> {
  const body: PermissionRequestFile = {
    requestId: opts.requestId,
    toolName: opts.toolName,
    toolInput: opts.toolInput,
    createdAt: opts.createdAt,
  };
  await atomicWrite(permissionRequestPath(opts), JSON.stringify(body, null, 2));
}

export async function readPermissionRequestFile(
  filePath: string,
): Promise<PermissionRequestFile | null> {
  return readJsonOrNull<PermissionRequestFile>(filePath);
}

export async function writePermissionResponseFile(
  opts: PerPaneIO & PermissionResponseFile,
): Promise<void> {
  const body: PermissionResponseFile = {
    requestId: opts.requestId,
    decision: opts.decision,
    reason: opts.reason,
  };
  await atomicWrite(permissionResponsePath(opts), JSON.stringify(body, null, 2));
}

export async function readPermissionResponseFile(
  filePath: string,
): Promise<PermissionResponseFile | null> {
  return readJsonOrNull<PermissionResponseFile>(filePath);
}

export async function deletePermissionRequestFile(
  opts: PerPaneIO & { requestId: string },
): Promise<void> {
  await unlinkOrIgnoreENOENT(permissionRequestPath(opts));
}

export async function deletePermissionResponseFile(
  opts: PerPaneIO & { requestId: string },
): Promise<void> {
  await unlinkOrIgnoreENOENT(permissionResponsePath(opts));
}

/**
 * Delete a permission Request/Response file by absolute path.
 * Used by daemon-side reaper + state-sweep — both have file paths from
 * chokidar / readdir, no need to re-derive paneId/sid/requestId.
 */
export async function deletePermissionFileByPath(
  filePath: string,
): Promise<void> {
  await unlinkOrIgnoreENOENT(filePath);
}

/**
 * List `<paneId>_<sid>.PermissionRequest.*` files for a given pane+sid pair.
 * Used by hook subprocess to sweep stale Requests before writing a new one
 * (mirrors Stop's "clear stale before write").
 */
export async function listPermissionRequestFiles(
  opts: PerPaneIO,
): Promise<string[]> {
  const prefix = `${paneSidPrefix(opts.paneId, opts.sessionId)}${PERMISSION_REQUEST_PREFIX}`;
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
  opts: PerPaneIO,
): Promise<string[]> {
  const prefix = `${paneSidPrefix(opts.paneId, opts.sessionId)}${PERMISSION_RESPONSE_PREFIX}`;
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
// IMWork: global IM-mode flag — file exists ⇔ user is in IM mode (manual
// switch via `@multi-cc-im /start /stop`).
//
// Per [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md)
// + [DD: PreToolUse auto-approve](../../../docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md):
//
// Schema evolution (compat-bridged):
//   - **0-byte tombstone** (legacy v1.3 schema): file exists = IM mode ON,
//     `auto = false`. Any old file written by pre-DD-#64 daemon parses as
//     `{auto:false}` — no migration code needed; daemon start always resets
//     IMWork → OFF (deletes the file) so legacy-content windows are short.
//   - **JSON `{"auto":boolean}`** (current): explicit auto-approve flag.
//     `/start` → `{auto:false}` (ask, default); `/start auto` → `{auto:true}`
//     (hook decision tree E1.5 fast-allows all PreToolUse).
//
// Read path returns `IMWorkFile | null`:
//   - null = ENOENT (IM mode OFF)
//   - `{auto:false}` = 0-byte file (legacy compat) OR JSON `{"auto":false}`
//   - `{auto:true}` = JSON `{"auto":true}`
//   - throws on JSON corruption (any non-empty body that isn't valid
//     IMWorkFile JSON) — bug indicator, fail loud
// ============================================================================

export const IMWorkFileSchema = z.object({
  auto: z.boolean(),
});

export type IMWorkFile = z.infer<typeof IMWorkFileSchema>;

export function imWorkPath(stateDir: string): string {
  return join(stateDir, IM_WORK_FILE_NAME);
}

/**
 * Write `IMWork` JSON. Default body `{auto:false}` keeps zero-arg callers
 * working unchanged (matches legacy "just enable IM mode" semantic).
 */
export async function writeIMWorkFile(
  stateDir: string,
  content: IMWorkFile = { auto: false },
): Promise<void> {
  IMWorkFileSchema.parse(content);
  await atomicWrite(imWorkPath(stateDir), JSON.stringify(content));
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

/**
 * Read + zod-validate `IMWork`. Returns null on ENOENT. Empty file (legacy
 * 0-byte tombstone) is treated as `{auto:false}` for back-compat. Throws on
 * malformed JSON or schema mismatch (corruption / future-version).
 */
export async function readIMWorkFile(
  stateDir: string,
): Promise<IMWorkFile | null> {
  let raw: string;
  try {
    raw = await readFile(imWorkPath(stateDir), 'utf-8');
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  if (raw.length === 0) return { auto: false }; // legacy 0-byte tombstone
  return IMWorkFileSchema.parse(JSON.parse(raw));
}

export async function deleteIMWorkFile(stateDir: string): Promise<void> {
  await unlinkOrIgnoreENOENT(imWorkPath(stateDir));
}

// ============================================================================
// IMOrigin: per-pane IMReplyContext snapshot. Filename is `<paneId>.IMOrigin`
// (single key — daemon writes it on inbound IM dispatch and at that point
// daemon doesn't know the cc sessionId).
//
// Contents: `IMReplyContext` JSON (discriminated union with `imType`
// discriminator, validated by `IMReplyContextSchema` from `@multi-cc-im/shared`).
//
// Lifecycle (per DD #58 / DD #61):
//   - daemon writes/overwrites on every IM dispatch to this pane (B2 — newest ctx wins)
//   - daemon deletes after cc Stop forward (one-shot)
//   - daemon start sweep (orphan cleanup — pane no longer alive)
// ============================================================================

export interface IMOriginIO {
  stateDir: string;
  paneId: number;
}

export function imOriginPath(opts: IMOriginIO): string {
  return join(opts.stateDir, `${opts.paneId}${IM_ORIGIN_SUFFIX}`);
}

export async function writeIMOriginFile(
  opts: IMOriginIO & { replyCtx: IMReplyContext },
): Promise<void> {
  // Defense-in-depth: validate the ctx shape before persisting so disk never
  // ends up with a malformed IMReplyContext that breaks future readers.
  IMReplyContextSchema.parse(opts.replyCtx);
  await atomicWrite(imOriginPath(opts), JSON.stringify(opts.replyCtx, null, 2));
}

/**
 * Read + zod-validate `<paneId>.IMOrigin`. Returns null on ENOENT.
 * Throws on JSON parse failure or schema mismatch (corruption, or a future
 * daemon wrote an `imType` an older client doesn't know).
 */
export async function readIMOriginFile(
  opts: IMOriginIO,
): Promise<IMReplyContext | null> {
  const raw = await readJsonOrNull<unknown>(imOriginPath(opts));
  if (raw === null) return null;
  return IMReplyContextSchema.parse(raw);
}

export async function existsIMOriginFile(opts: IMOriginIO): Promise<boolean> {
  try {
    await readFile(imOriginPath(opts));
    return true;
  } catch (err) {
    if (isENOENT(err)) return false;
    throw err;
  }
}

export async function deleteIMOriginFile(opts: IMOriginIO): Promise<void> {
  await unlinkOrIgnoreENOENT(imOriginPath(opts));
}

/** List all `<paneId>.IMOrigin` files in the state dir (daemon start sweep). */
export async function listIMOriginFiles(stateDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => parseIMOriginFilename(name) !== null)
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
// `startedAt` is the verbatim output of `ps -o lstart= -p <pid>`. Stored
// alongside PID specifically to defend against PID reuse.
// ============================================================================

export interface DaemonPidFile {
  pid: number;
  startedAt: string;
}

export function daemonPidPath(stateDir: string): string {
  return join(stateDir, DAEMON_PID_FILE_NAME);
}

export async function writeDaemonPidFile(
  opts: { stateDir: string } & DaemonPidFile,
): Promise<void> {
  const body: DaemonPidFile = { pid: opts.pid, startedAt: opts.startedAt };
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
 * any non-zero exit code.
 */
export async function captureProcessLstart(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { timeout: 5_000 },
      (err, stdout) => {
        if (err) {
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
 * alive. Two-step verification:
 *   1. `process.kill(pid, 0)` — fast existence test
 *   2. `ps -o lstart= -p <pid>` — verify PID-reuse hasn't happened
 *
 * Returns false if no daemon.pid OR PID dead OR lstart mismatch.
 */
export async function isDaemonAlive(stateDir: string): Promise<boolean> {
  const file = await readDaemonPidFile(stateDir);
  if (file === null) return false;

  try {
    process.kill(file.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw err;
  }

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
