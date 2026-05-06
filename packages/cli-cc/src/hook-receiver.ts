import { execFile } from 'node:child_process';
import { appendEvent } from './events-log.js';
import { popInjection } from './injection-queue.js';
import type { ParsedHookPayload } from './payloads.js';
import {
  touchLastHookAt,
  writeCcPid,
  writeEnded,
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
}

/**
 * Process a single cc hook event:
 * - Always: touch `<sid>.last-hook-at` (PaneAlive idle-timeout signal) +
 *   append payload to `<sid>.events.jsonl` (CLIAdapter file-watcher consumes).
 * - SessionStart: also write `<sid>.cc-pid` with `process.ppid` + `ps -o
 *   lstart=` (PaneAlive PID + reuse defense).
 * - SessionEnd: also write `<sid>.ended` with `reason` + `endedAt` (PaneAlive
 *   flips to dead immediately on graceful exit).
 * - Stop: if `stop_hook_active === false` AND queue has pending injection,
 *   pop the oldest line and **return** `{ decision:'block', reason }` for the
 *   CLI caller to print as the hook's stdout response. `stop_hook_active=true`
 *   skips the queue entirely (CLAUDE.md "Key conventions" hard rule "use
 *   `stop_hook_active` for idle wakeup to prevent infinite loops"). Other
 *   events return `void`.
 *
 * **The returned `HookDecision` is the only allowed stdout payload** per
 * CLAUDE.md "Key conventions" exception "controlled JSON
 * `{decision:"block",...}` only"; CLI caller writes it to stdout (other hook
 * output goes to stderr / state files).
 *
 * Throws on partial failure (e.g. `ps -o lstart=` fails). Hook caller is
 * expected to: log error to stderr, `process.exit(1)` — cc treats non-zero
 * exit as hook failure but doesn't fail the session.
 */
export async function runHookReceiver(
  opts: RunHookReceiverOpts,
): Promise<HookDecision | void> {
  const { stateDir, payload } = opts;
  const sessionId = payload.session_id;

  if (payload.hook_event_name === 'SessionStart') {
    const capture = opts.capturePid ?? defaultCapturePid;
    const captured = await capture();
    await writeCcPid({
      stateDir,
      sessionId,
      pid: captured.pid,
      startedAt: captured.startedAt,
      ...(captured.paneId !== undefined ? { paneId: captured.paneId } : {}),
      cwd: payload.cwd,
    });
  } else if (payload.hook_event_name === 'SessionEnd') {
    await writeEnded({ stateDir, sessionId, reason: payload.reason });
  }

  await appendEvent({ stateDir, sessionId, payload });
  await touchLastHookAt({ stateDir, sessionId });

  if (
    payload.hook_event_name === 'Stop' &&
    payload.stop_hook_active === false
  ) {
    const reason = await popInjection({ stateDir, sessionId });
    if (reason !== null) return { decision: 'block', reason };
  }
}
