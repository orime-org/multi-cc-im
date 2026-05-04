import { execFile } from 'node:child_process';
import type { ParsedHookPayload } from './payloads.js';
import {
  touchLastHookAt,
  writeCcPid,
  writeEnded,
} from './state-files.js';

/**
 * Capture cc parent process PID + start time for PID-reuse defense.
 *
 * Default impl reads `process.ppid` (cc invoked the hook script which invoked
 * `multi-cc-im hook`, so ppid = cc) + spawns `ps -o lstart= -p <pid>` to get
 * a stable start-time string (macOS / Linux compatible). Caller can inject a
 * stub via `RunHookReceiverOpts.capturePid` for tests.
 *
 * `lstart` format example: `Tue May  4 16:38:00 2026`. Stored verbatim — the
 * comparison is exact-string-match, no parsing.
 */
async function defaultCapturePid(): Promise<{
  pid: number;
  startedAt: string;
}> {
  const ppid = process.ppid;
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
        resolve({ pid: ppid, startedAt: stdout.trim() });
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
   * Override PID + lstart capture (default: `process.ppid` + `ps -o lstart=`).
   * Tests pass a stub to avoid spawning `ps`.
   */
  capturePid?: () => Promise<{ pid: number; startedAt: string }>;
}

/**
 * Process a single cc hook event:
 * - Always: touch `<sid>.last-hook-at` with current ms (PaneAlive idle-timeout
 *   fallback signal).
 * - SessionStart: write `<sid>.cc-pid` with `process.ppid` + `ps -o lstart=`
 *   (PaneAlive PID + reuse defense).
 * - SessionEnd: write `<sid>.ended` with `reason` + `endedAt` (PaneAlive flips
 *   to dead immediately on graceful exit).
 * - Other events (UserPromptSubmit / PreToolUse / PostToolUse / Stop): only
 *   the last-hook-at touch — bridge router consumes them via separate
 *   file-watching CLIAdapter (follow-up PR).
 *
 * **No protocol output to stdout**. Per CLAUDE.md「关键规范」"multi-cc-im hook
 * 不许写非协议 stdout"; Stop hook injection (`{decision:"block",...}`) is the
 * sole allowed output and lives in the future CLIAdapter PR (queue-based, not
 * receiver state).
 *
 * Throws on partial failure (e.g. `ps -o lstart=` fails). Hook caller is
 * expected to: log error to stderr, `process.exit(1)` — cc treats non-zero
 * exit as hook failure but doesn't fail the session.
 */
export async function runHookReceiver(
  opts: RunHookReceiverOpts,
): Promise<void> {
  const { stateDir, payload } = opts;
  const sessionId = payload.session_id;

  if (payload.hook_event_name === 'SessionStart') {
    const capture = opts.capturePid ?? defaultCapturePid;
    const { pid, startedAt } = await capture();
    await writeCcPid({ stateDir, sessionId, pid, startedAt });
  } else if (payload.hook_event_name === 'SessionEnd') {
    await writeEnded({ stateDir, sessionId, reason: payload.reason });
  }

  await touchLastHookAt({ stateDir, sessionId });
}
