import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { popInjection } from './injection-queue.js';
import type { ParsedHookPayload } from './payloads.js';
import {
  deletePermissionFileByPath,
  deletePermissionRequestFile,
  deletePermissionResponseFile,
  deleteSessionEndFile,
  deleteStopFile,
  formatStopTimestamp,
  listPermissionRequestFiles,
  listPermissionResponseFiles,
  listStopFiles,
  permissionResponsePath,
  readPermissionResponseFile,
  writePermissionRequestFile,
  writeSessionEndFile,
  writeSessionStartFile,
  writeStopFile,
} from './state-files.js';
import { stat } from 'node:fs/promises';

/**
 * cc Stop hook injection-queue response: `{"decision":"block","reason":"..."}`.
 * Returned by `runHookReceiver` (Stop branch with non-empty injection
 * queue + `stop_hook_active=false`); CLI caller writes it to stdout.
 *
 * cc PreToolUse hook uses a different shape (`hookSpecificOutput.permissionDecision`)
 * — see `PreToolUseHookOutput`.
 */
export interface HookDecision {
  decision: 'block';
  reason: string;
}

/**
 * cc PreToolUse hook stdout shape (cc current schema as of 2026-05-07):
 *
 * ```json
 * { "hookSpecificOutput": {
 *     "hookEventName": "PreToolUse",
 *     "permissionDecision": "allow" | "deny" | "ask" | "defer",
 *     "permissionDecisionReason": "human-readable reason"
 *   } }
 * ```
 *
 * Returned by `runHookReceiver` PreToolUse branch after the user's IM
 * decision arrives or the 30s timeout fires. CLI caller writes it to
 * stdout.
 */
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask' | 'defer';
    permissionDecisionReason: string;
  };
}

/** Polling cadence + max wait for the PermissionResponse file. */
const PERMISSION_POLL_INTERVAL_MS = 200;
const PERMISSION_TIMEOUT_MS = 30_000;

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
  /**
   * Override PreToolUse poll interval (ms). Tests use a small value to
   * keep timeout tests fast. Default 200ms.
   */
  permissionPollIntervalMs?: number;
  /**
   * Override PreToolUse total wait budget (ms). Tests use a small value to
   * exercise the timeout default-allow branch without sleeping 30s.
   * Default 30_000ms.
   */
  permissionTimeoutMs?: number;
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
): Promise<HookDecision | PreToolUseHookOutput | void> {
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

    case 'PreToolUse': {
      // Permission gate per [DD: permission forward](../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md):
      //   0. Sweep stale Request/Response files for this sid (mirrors Stop's
      //      "clear stale before write" pattern — defends against the prior
      //      hook subprocess being killed mid-cleanup).
      //   1. Generate short request id
      //   2. Write <sid>.PermissionRequest.<id>.json
      //   3. Poll <sid>.PermissionResponse.<id>.json every 200ms, max 30s
      //   4. On response: read decision → cleanup files → return hook output
      //   5. On timeout: cleanup request file → return allow (default)
      const staleReq = await listPermissionRequestFiles({
        stateDir,
        sessionId,
      });
      for (const f of staleReq) await deletePermissionFileByPath(f);
      const staleResp = await listPermissionResponseFiles({
        stateDir,
        sessionId,
      });
      for (const f of staleResp) await deletePermissionFileByPath(f);

      const requestId = randomBytes(4).toString('hex'); // 8-char hex (sufficient — single sid has ≤1 pending)
      await writePermissionRequestFile({
        stateDir,
        sessionId,
        requestId,
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        createdAt: Date.now(),
      });

      const respPath = permissionResponsePath({
        stateDir,
        sessionId,
        requestId,
      });
      const pollMs = opts.permissionPollIntervalMs ?? PERMISSION_POLL_INTERVAL_MS;
      const timeoutMs = opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      let decision: 'allow' | 'deny' = 'allow';
      let reason = `${Math.round(timeoutMs / 1000)}s timeout, default allow`;
      while (Date.now() < deadline) {
        try {
          await stat(respPath);
          // File exists — read it
          const resp = await readPermissionResponseFile(respPath);
          if (resp && resp.requestId === requestId) {
            decision = resp.decision;
            reason = resp.reason || `IM user ${decision}`;
            break;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        await sleep(pollMs);
      }

      // Cleanup both Request + Response files (regardless of timeout / decision)
      await deletePermissionRequestFile({ stateDir, sessionId, requestId });
      await deletePermissionResponseFile({ stateDir, sessionId, requestId });

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: reason,
        },
      };
    }

    case 'Stop': {
      // Symmetric with SessionStart: clear stale Stop.* before writing the
      // fresh one so state/ never accumulates more than one Stop file per
      // sid. Daemon-up case: prior Stop was already unlinked by daemon
      // after forwarding (~100ms). This loop is a no-op there. Daemon-down
      // case: previous Stop file(s) lingered; we drop them — the daemon
      // can't forward them on restart anyway (lastReplyCtxBySession is
      // in-memory only and was lost). Keeps state/ clean for users
      // running `ls ~/.multi-cc-im/state/` to inspect.
      const stalestop = await listStopFiles({ stateDir, sessionId });
      for (const f of stalestop) await deleteStopFile(f);

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
