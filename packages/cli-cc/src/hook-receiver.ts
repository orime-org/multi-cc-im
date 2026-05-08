import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { popInjection } from './injection-queue.js';
import type { ParsedHookPayload } from './payloads.js';
import {
  deletePermissionFileByPath,
  deletePermissionRequestFile,
  deletePermissionResponseFile,
  deleteStopFile,
  existsIMOriginFile,
  existsIMWorkFile,
  formatStopTimestamp,
  isDaemonAlive,
  listPermissionRequestFiles,
  listPermissionResponseFiles,
  listStopFiles,
  permissionResponsePath,
  readIMWorkFile,
  readPermissionResponseFile,
  writePermissionRequestFile,
  writeStopFile,
} from './state-files.js';

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
 * cc PreToolUse hook stdout shape:
 *
 * ```json
 * { "hookSpecificOutput": {
 *     "hookEventName": "PreToolUse",
 *     "permissionDecision": "allow" | "deny" | "ask" | "defer",
 *     "permissionDecisionReason": "human-readable reason"
 *   } }
 * ```
 */
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask' | 'defer';
    permissionDecisionReason: string;
  };
}

/**
 * Polling cadence + max wait for the PermissionResponse file. Per
 * [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md).
 */
const PERMISSION_POLL_INTERVAL_MS = 200;
const PERMISSION_TIMEOUT_MS = 10_000;

/**
 * cc tools that are read-only by design — Read / Grep / Glob / NotebookRead.
 * cc itself does NOT show a TUI permission menu for these, so forwarding a
 * PreToolUse approval prompt to IM for these is pure noise. Per
 * [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md)
 * the hook fast-allows them and skips the IM round-trip.
 *
 * NOT included: `Bash`. cc has its own internal allow-list of read-only Bash
 * commands but the list is not public; we forward all `Bash` invocations
 * (over-noisy, never under-asks).
 */
const READ_ONLY_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

export interface RunHookReceiverOpts {
  /**
   * Directory where state files live (e.g. `~/.multi-cc-im/state/`).
   */
  stateDir: string;
  /** Already-parsed + validated stdin payload (see `parseHookPayload`). */
  payload: ParsedHookPayload;
  /**
   * Override the timestamp used for the Stop file suffix. Tests inject a
   * fixed timestamp for deterministic file naming.
   */
  now?: () => Date;
  /**
   * Override `process.env.WEZTERM_PANE` lookup. Tests inject a numeric paneId
   * (or undefined to simulate "not in wezterm" filter path). Default reads
   * the env directly.
   */
  resolvePaneId?: () => number | undefined;
  /** Override PreToolUse poll interval (ms). Tests use a small value. */
  permissionPollIntervalMs?: number;
  /** Override PreToolUse total wait budget (ms). Tests use a small value. */
  permissionTimeoutMs?: number;
}

/**
 * Read `process.env.WEZTERM_PANE` as a numeric paneId. Returns undefined
 * when env is unset (cc not running in wezterm) or non-numeric (corrupt env).
 *
 * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)
 * this is the **filter** that gates whether the hook writes anything to
 * disk — undefined means cc is in ssh / VS Code terminal / non-wezterm
 * environment, and multi-cc-im has nothing to do with it.
 */
function defaultResolvePaneId(): number | undefined {
  const env = process.env.WEZTERM_PANE;
  if (env && /^\d+$/.test(env)) return Number(env);
  return undefined;
}

/**
 * Process a single cc hook event. Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)
 * (refines [DD: IMWork+IMOrigin] + [DD: daemon liveness]):
 *
 * **WEZTERM_PANE filter (entry gate)**: if `process.env.WEZTERM_PANE` is
 * undefined, hook silently exits without writing anything. cc is running
 * outside wezterm (ssh / VS Code terminal / etc.) — multi-cc-im does not
 * interact with such cc instances.
 *
 * **PreToolUse**: 5-step decision tree (cheapest check first):
 *   1. read-only tool → emit `permissionDecision: allow` exit (no Request file written)
 *   2. read IMWork: null → emit `ask` exit (cc TUI takes over with native menu)
 *   3. IMWork.auto = true → emit `permissionDecision: allow` exit
 *      (per [DD: PreToolUse auto-approve](../../../docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md);
 *       user opted in via `@multi-cc-im /start auto`)
 *   4. !`<paneId>.IMOrigin` → emit `ask` exit (no IM thread bound for this pane)
 *   5. !daemon alive → emit `ask` exit (forward target gone)
 *   6. otherwise: write `<paneId>_<sid>.PermissionRequest.<id>.json`,
 *      poll matching `<paneId>_<sid>.PermissionResponse.<id>.json` for
 *      `PERMISSION_TIMEOUT_MS`, return cc decision (default-allow on timeout).
 *
 * **Stop**: 3-step short-circuit guard mirroring PreToolUse:
 *   1. !IMWork → return void
 *   2. !`<paneId>.IMOrigin` → return void
 *   3. !daemon alive → return void
 *   Otherwise: clear stale `<paneId>_<sid>.Stop.*`, write fresh
 *   `<paneId>_<sid>.Stop.<ts>`. If `stop_hook_active=false` and injection
 *   queue has a pending entry, return `{ decision: 'block', reason }`.
 *
 * **The returned `HookDecision` / `PreToolUseHookOutput` is the only
 * allowed stdout payload** per CLAUDE.md "multi-cc-im hook must not write
 * non-protocol stdout"; CLI caller writes it to stdout (other hook output
 * goes to stderr / state files).
 */
export async function runHookReceiver(
  opts: RunHookReceiverOpts,
): Promise<HookDecision | PreToolUseHookOutput | void> {
  const { stateDir, payload } = opts;
  const sessionId = payload.session_id;

  // WEZTERM_PANE filter — gate everything before we touch disk
  const resolvePaneId = opts.resolvePaneId ?? defaultResolvePaneId;
  const paneId = resolvePaneId();
  if (paneId === undefined) {
    // cc is running outside wezterm. Silently exit; multi-cc-im does not
    // bridge non-wezterm cc instances.
    return;
  }

  switch (payload.hook_event_name) {
    case 'PreToolUse': {
      // E1: read-only tool whitelist
      if (READ_ONLY_TOOL_NAMES.has(payload.tool_name)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason:
              '[multi-cc-im] read-only tool, auto-allow',
          },
        };
      }

      // E1.5 + E2: load IMWork JSON. null → IM mode OFF (E2 — cc TUI takes
      // over). {auto:true} → user opted into trust mode via `/start auto` →
      // fast-allow without IM round-trip (E1.5). {auto:false} → fall through
      // to E3 forward path.
      const imWork = await readIMWorkFile(stateDir);
      if (imWork === null) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: '[multi-cc-im] local mode',
          },
        };
      }
      if (imWork.auto) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason:
              '[multi-cc-im] IMWork auto-approve, allow without IM prompt',
          },
        };
      }

      // E3: IMWork on but no IM thread bound for this pane → cc TUI takes over
      if (!(await existsIMOriginFile({ stateDir, paneId }))) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason:
              '[multi-cc-im] no IM thread for this cc',
          },
        };
      }

      // E4: daemon not running. Order intentionally last: IMWork + IMOrigin
      // checks are cheap (stat ~0.1ms), daemon liveness costs spawn ps
      // (~10-30ms). Most hook calls short-circuit at E2 / E3.
      if (!(await isDaemonAlive(stateDir))) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: '[multi-cc-im] daemon not running',
          },
        };
      }

      // Sweep stale Request/Response files for this pane+sid before writing
      // the new Request (defends against prior hook subprocess killed
      // mid-cleanup).
      const staleReq = await listPermissionRequestFiles({
        stateDir,
        paneId,
        sessionId,
      });
      for (const f of staleReq) await deletePermissionFileByPath(f);
      const staleResp = await listPermissionResponseFiles({
        stateDir,
        paneId,
        sessionId,
      });
      for (const f of staleResp) await deletePermissionFileByPath(f);

      // 8-char hex requestId — sufficient since single pane+sid has ≤1
      // Request in flight (cc serializes its hooks).
      const requestId = randomBytes(4).toString('hex');
      await writePermissionRequestFile({
        stateDir,
        paneId,
        sessionId,
        requestId,
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        createdAt: Date.now(),
      });

      const respPath = permissionResponsePath({
        stateDir,
        paneId,
        sessionId,
        requestId,
      });
      const pollMs =
        opts.permissionPollIntervalMs ?? PERMISSION_POLL_INTERVAL_MS;
      const timeoutMs = opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      let decision: 'allow' | 'deny' = 'allow';
      let reason = `${Math.round(timeoutMs / 1000)}s timeout, default allow`;
      while (Date.now() < deadline) {
        try {
          await stat(respPath);
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

      // Cleanup both Request + Response files regardless of timeout / decision.
      await deletePermissionRequestFile({
        stateDir,
        paneId,
        sessionId,
        requestId,
      });
      await deletePermissionResponseFile({
        stateDir,
        paneId,
        sessionId,
        requestId,
      });

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: reason,
        },
      };
    }

    case 'Stop': {
      // 3-step short-circuit guards mirror PreToolUse. Order:
      //   E1 !IMWork → return void (local mode)
      //   E2 !IMOrigin → return void (no IM thread)
      //   E3 !daemon alive → return void (no listener)

      if (!(await existsIMWorkFile(stateDir))) return;
      if (!(await existsIMOriginFile({ stateDir, paneId }))) return;
      if (!(await isDaemonAlive(stateDir))) return;

      // Clear stale Stop.* for this pane+sid before writing fresh.
      // (E3 ensures daemon is alive — if it's catching up we still don't
      // want to accumulate; daemon's chokidar will pick up the newest.)
      const stalestop = await listStopFiles({ stateDir, paneId, sessionId });
      for (const f of stalestop) await deleteStopFile(f);

      const now = opts.now ?? (() => new Date());
      const timestamp = formatStopTimestamp(now());
      await writeStopFile({
        stateDir,
        paneId,
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
  }
}
