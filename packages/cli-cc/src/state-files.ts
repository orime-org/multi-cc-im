import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@multi-cc-im/storage-files';

/**
 * State file IO for cc session lifecycle. All files live under
 * `<stateDir>/<sessionId>.<suffix>` where `stateDir` defaults to
 * `~/.multi-cc-im/state/` (caller decides exact path).
 *
 * - `<sid>.cc-pid`         — written by SessionStart hook with cc parent
 *                            process pid + startTime (`ps -o lstart=`) for PID
 *                            reuse defense
 * - `<sid>.ended`          — written by SessionEnd hook with reason + endedAt
 *                            ms (PaneAlive flips to dead immediately)
 * - `<sid>.last-hook-at`   — touched by every hook with current ms timestamp;
 *                            PaneAlive idle-timeout fallback signal
 *
 * All writes go through `@multi-cc-im/storage-files`'s `atomicWrite` (mode 0600
 * + same-dir tmp + fsync + rename). Reads are plain `readFile`; ENOENT → null.
 *
 * Per [pane-alive strategy DD](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md)
 * + Storage DD pattern A (state files persist to `~/.multi-cc-im/state/` +
 * atomic write, no SQL DB).
 */

function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

// ============================================================================
// cc-pid: SessionStart writes pid + ps lstart string
// ============================================================================

export interface CcPidEntry {
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
   * `paneId → sessionId` reverse map (term-wezterm PaneAlive consumes via DI).
   * Optional: cc may run outside wezterm (no env), in which case the session
   * isn't routable from bridge.
   */
  paneId?: number;
  /**
   * `cwd` from SessionStart payload (already realpath'd by cc). Bridge
   * SessionRegistry stores so the session can be displayed / filtered by
   * project root without re-reading the payload.
   */
  cwd?: string;
}

export interface CcPidIO {
  stateDir: string;
  sessionId: string;
}

export async function writeCcPid(
  opts: CcPidIO & CcPidEntry,
): Promise<void> {
  const filePath = join(opts.stateDir, `${opts.sessionId}.cc-pid`);
  const body: CcPidEntry = {
    pid: opts.pid,
    startedAt: opts.startedAt,
    ...(opts.paneId !== undefined ? { paneId: opts.paneId } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  };
  await atomicWrite(filePath, JSON.stringify(body, null, 2));
}

export async function readCcPid(opts: CcPidIO): Promise<CcPidEntry | null> {
  return readJsonOrNull<CcPidEntry>(
    join(opts.stateDir, `${opts.sessionId}.cc-pid`),
  );
}

// ============================================================================
// ended: SessionEnd writes reason + endedAt
// ============================================================================

export interface EndedEntry {
  /** SessionEnd payload `reason` field, stored verbatim. */
  reason: string;
  /** Wall-clock ms when ended file was written. */
  endedAt: number;
}

export interface EndedIO {
  stateDir: string;
  sessionId: string;
}

export async function writeEnded(
  opts: EndedIO & { reason: string },
): Promise<void> {
  const filePath = join(opts.stateDir, `${opts.sessionId}.ended`);
  await atomicWrite(
    filePath,
    JSON.stringify(
      { reason: opts.reason, endedAt: Date.now() } satisfies EndedEntry,
      null,
      2,
    ),
  );
}

export async function readEnded(opts: EndedIO): Promise<EndedEntry | null> {
  return readJsonOrNull<EndedEntry>(
    join(opts.stateDir, `${opts.sessionId}.ended`),
  );
}

// ============================================================================
// last-hook-at: any hook touches with current ms
// ============================================================================

export interface LastHookIO {
  stateDir: string;
  sessionId: string;
}

export async function touchLastHookAt(opts: LastHookIO): Promise<void> {
  const filePath = join(opts.stateDir, `${opts.sessionId}.last-hook-at`);
  await atomicWrite(filePath, String(Date.now()));
}

/** Returns the persisted ms timestamp, or `null` if no hook has fired yet. */
export async function readLastHookAt(opts: LastHookIO): Promise<number | null> {
  const filePath = join(opts.stateDir, `${opts.sessionId}.last-hook-at`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

// ============================================================================
// shared helper
// ============================================================================

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}
