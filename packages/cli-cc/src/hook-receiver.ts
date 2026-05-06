import { execFile } from 'node:child_process';
import { popInjection } from './injection-queue.js';
import type { ParsedHookPayload } from './payloads.js';
import {
  deleteSessionEndFile,
  deleteStopFile,
  formatStopTimestamp,
  listStopFiles,
  writeSessionEndFile,
  writeSessionStartFile,
  writeStopFile,
} from './state-files.js';

/**
 * The single allowed `stdout` payload for cc hooks per CLAUDE.md "Key
 * conventions" exception "controlled JSON `{decision:"block",...}` only".
 * Returned by `runHookReceiver` (Stop branch with non-empty queue +
 * `stop_hook_active=false`); CLI caller writes it to stdout. Mirrors
 * `HookDecision` in `@multi-cc-im/shared`.
 */
export interface HookDecision {
  decision: 'block';
  reason: string;
}

/**
 * Capture cc parent process info at SessionStart hook fire:
 * - `pid` = `process.ppid` (cc invoked the hook script which invoked
 *   `multi-cc-im hook`, so ppid = cc)
 * - `startedAt` = `ps -o lstart= -p <pid>` output (stable start-time string;
 *   stored verbatim for exact-string-match PID-reuse defense)
 * - `paneId` = `process.env.WEZTERM_PANE` (cc inherits env from wezterm;
 *   undefined when cc runs outside wezterm — session not routable)
 *
 * `lstart` format example: `Tue May  4 16:38:00 2026`. Caller can inject a
 * stub via `RunHookReceiverOpts.capturePid` for tests.
 */
async function defaultCapturePid(): Promise<{
  pid: number;
  startedAt: string;
  paneId: number | undefined;
}> {
  const ppid = process.ppid;
  const paneEnv = process.env.WEZTERM_PANE;
  const paneId =
    paneEnv && /^\d+$/.test(paneEnv) ? Number(paneEnv) : undefined;
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(ppid)],
      { timeout: 5_000 },
      (err, stdout, stderr) => {
        if (err) {
          const stderrTrim = (stderr ?? '').trim();
          reject(
            new Error(
              `ps -o lstart= failed for pid=${ppid}: ${err.message}${stderrTrim ? ` — ${stderrTrim}` : ''}`,
            ),
          );
          return;
        }
        resolve({ pid: ppid, startedAt: stdout.trim(), paneId });
      },
    );
  });
}

export interface RunHookReceiverOpts {
  /**
   * Directory where state files live (e.g. `~/.multi-cc-im/state/`). Caller
   * (CLI / bridge) decides; package itself stays IM-agnostic.
   */
  stateDir: string;
  /** Already-parsed + validated stdin payload (see `parseHookPayload`). */
  payload: ParsedHookPayload;
  /**
   * Override PID + lstart + paneId capture (default: `process.ppid` +
   * `ps -o lstart=` + `process.env.WEZTERM_PANE`). Tests pass a stub to avoid
   * spawning `ps` and to control paneId.
   */
  capturePid?: () => Promise<{
    pid: number;
    startedAt: string;
    paneId?: number | undefined;
  }>;
  /**
   * Override the timestamp used for the Stop file suffix. Tests inject a
   * fixed timestamp for deterministic file naming. Default: `new Date()`
   * formatted via `formatStopTimestamp`.
   */
  now?: () => Date;
}

/**
 * Process a single cc hook event into the per-event-type file model:
 *
 * - **SessionStart**: write `<sid>.SessionStart` with pid / startedAt /
 *   paneId / cwd / transcript_path. Before writing, **clean stale state
 *   from a prior lifecycle** (resume case) — delete any existing
 *   `<sid>.SessionEnd` (cc came back to life) and any leftover
 *   `<sid>.Stop.*` files (stale unprocessed Stop signals from before the
 *   exit). This guarantees the daemon never sees a contradictory state
 *   like `SessionStart + SessionEnd` simultaneously present.
 *
 * - **Stop**: write `<sid>.Stop.<timestamp>` with the assistant reply.
 *   Per-event new file (timestamp suffix) — daemon down can't lose msgs;
 *   they accumulate and process in order on next start. If
 *   `stop_hook_active === false` AND queue has pending injection, pop the
 *   oldest line and **return** `{ decision:'block', reason }` for the CLI
 *   caller to print as the hook's stdout response. `stop_hook_active=true`
 *   skips the queue entirely (CLAUDE.md "Key conventions" hard rule "use
 *   `stop_hook_active` for idle wakeup to prevent infinite loops"). The
 *   Stop file write happens regardless of injection-queue outcome.
 *
 * - **SessionEnd**: write empty `<sid>.SessionEnd` tombstone. File
 *   existence IS the death signal — content is intentionally not
 *   persisted.
 *
 * **The returned `HookDecision` is the only allowed stdout payload** per
 * CLAUDE.md "Key conventions" exception "controlled JSON
 * `{decision:"block",...}` only"; CLI caller writes it to stdout (other
 * hook output goes to stderr / state files).
 *
 * Throws on partial failure (e.g. `ps -o lstart=` fails at SessionStart).
 * Hook caller is expected to: log error to stderr, `process.exit(1)` — cc
 * treats non-zero exit as hook failure but doesn't fail the session.
 */
export async function runHookReceiver(
  opts: RunHookReceiverOpts,
): Promise<HookDecision | void> {
  const { stateDir, payload } = opts;
  const sessionId = payload.session_id;

  switch (payload.hook_event_name) {
    case 'SessionStart': {
      // Resume cleanup: same sid coming back to life means any prior
      // SessionEnd + Stop.* files are stale. Delete before writing fresh
      // SessionStart so daemon never observes "alive + ended" simultaneously.
      await deleteSessionEndFile({ stateDir, sessionId });
      const stalestop = await listStopFiles({ stateDir, sessionId });
      for (const f of stalestop) await deleteStopFile(f);

      const capture = opts.capturePid ?? defaultCapturePid;
      const captured = await capture();
      await writeSessionStartFile({
        stateDir,
        sessionId,
        pid: captured.pid,
        startedAt: captured.startedAt,
        ...(captured.paneId !== undefined ? { paneId: captured.paneId } : {}),
        cwd: payload.cwd,
        transcript_path: payload.transcript_path,
      });
      return;
    }

    case 'Stop': {
      const now = opts.now ?? (() => new Date());
      const timestamp = formatStopTimestamp(now());
      await writeStopFile({
        stateDir,
        sessionId,
        timestamp,
        last_assistant_message: payload.last_assistant_message,
      });
      if (payload.stop_hook_active === false) {
        const reason = await popInjection({ stateDir, sessionId });
        if (reason !== null) return { decision: 'block', reason };
      }
      return;
    }

    case 'SessionEnd': {
      await writeSessionEndFile({ stateDir, sessionId });
      return;
    }
  }
}
