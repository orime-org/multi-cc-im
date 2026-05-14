import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { AskUserQuestionToolInputSchema, type PaneId } from '@multi-cc-im/shared';
import { popInjection } from './injection-queue.js';
import {
  DEFAULT_DETECTORS,
  runDetectors,
  type PaneOrigin,
} from './pane-id-detectors.js';
import type { ParsedHookPayload } from './payloads.js';
import {
  deletePermissionDialogRequestFile,
  deletePermissionDialogResponseFile,
  deletePermissionFileByPath,
  deletePermissionRequestFile,
  deletePermissionResponseFile,
  deleteStopFile,
  existsIMOriginFile,
  existsIMWorkFile,
  formatStopTimestamp,
  isDaemonAlive,
  listPermissionDialogRequestFiles,
  listPermissionDialogResponseFiles,
  listPermissionRequestFiles,
  listPermissionResponseFiles,
  listStopFiles,
  permissionDialogResponsePath,
  permissionResponsePath,
  readIMWorkFile,
  readPermissionDialogResponseFile,
  readPermissionResponseFile,
  writePermissionDialogRequestFile,
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
 * cc PreToolUse hook stdout shape. Per the official
 * [hooks reference](https://code.claude.com/docs/en/hooks#pretooluse),
 * `hookSpecificOutput` fields for PreToolUse are:
 *
 * - `permissionDecision`: `'allow' | 'deny' | 'ask' | 'defer'`
 * - `permissionDecisionReason`: optional (required when `deny`)
 * - `updatedInput`: optional object that REWRITES the tool's input
 *   before execution
 *
 * For AskUserQuestion specifically, the
 * [agent-sdk/user-input docs](https://code.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions)
 * document `allow + updatedInput.answers` as the standard answer-inject
 * path: cc treats the tool as completed successfully with the user's
 * answers, transcript records `{questions, answers}` as the tool result.
 *
 * We split into a union to make the protocol invariants type-enforced:
 * `deny` must carry a reason; `allow` may carry `updatedInput` and/or
 * a reason (but neither is required for generic auto-allow).
 */
export type PreToolUseHookOutput = {
  hookSpecificOutput:
    | {
        hookEventName: 'PreToolUse';
        permissionDecision: 'allow';
        updatedInput?: Record<string, unknown>;
        permissionDecisionReason?: string;
      }
    | {
        hookEventName: 'PreToolUse';
        permissionDecision: 'deny' | 'ask' | 'defer';
        permissionDecisionReason: string;
      };
};

/**
 * cc PermissionRequest hook stdout shape. Per [DD: PermissionRequest hook
 * IM bridge §2.1](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md#21-hookspecificoutput-schema-for-permissionrequest)
 * source-verified against cc 2.1.88 (`types/hooks.ts:121-134`):
 *
 * ```json
 * {
 *   "hookSpecificOutput": {
 *     "hookEventName": "PermissionRequest",
 *     "decision": {
 *       "behavior": "allow" | "deny",
 *       "updatedInput": {...}?,           // allow only
 *       "updatedPermissions": [...]?,     // allow only — session-rule injection
 *       "message": "..."?                 // deny only
 *     }
 *   }
 * }
 * ```
 *
 * `interrupt: true` (deny variant) intentionally NOT exposed —
 * multi-cc-im never wants to abort the cc session as a whole.
 */
export type PermissionRequestHookOutput = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision:
      | {
          behavior: 'allow';
          updatedInput?: Record<string, unknown>;
          updatedPermissions?: readonly unknown[];
        }
      | {
          behavior: 'deny';
          message?: string;
        };
  };
};

/**
 * Polling cadence + max wait for the PermissionResponse file (= IM-reply
 * window for the user). Per [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md).
 *
 * **10s internal vs 20s cc-side** (configured in `apps/setup-hooks.ts`
 * `HOOK_TIMEOUTS.PreToolUse: 20`): cc kills the hook subprocess once its
 * own timeout elapses. The cc-side timeout MUST be greater than the
 * hook's internal poll deadline so the hook can deterministically write
 * its decision JSON to stdout before cc SIGKILLs it.
 *
 * The 10s margin (20s cc-side − 10s hook internal) covers:
 * 1. Hook writing stdout + cleanup (~ms)
 * 2. Daemon-side `apiPostFetch` transient retry on unhealthy iLink LB IPs
 *    (up to 2 retries with 200ms+500ms backoff + per-attempt timeoutMs)
 * 3. Any network jitter
 *
 * User-perceptible IM-reply window remains 10s — the same as before;
 * the extra 10s is daemon-side resilience budget that doesn't extend
 * the user's "act in N seconds" perception.
 */
const PERMISSION_POLL_INTERVAL_MS = 200;
const PERMISSION_TIMEOUT_MS = 10_000;

/**
 * AskUserQuestion-specific hook internal poll deadline. Per
 * [DD AskUserQuestion IM bridge §9.5](../../../docs/superpowers/specs/2026-05-12-askuserquestion-im-bridge-dd.md#95-revised-timeouts):
 * AUQ holds the hook polling for an IM-side reply (D2-B "hook holds
 * until IM reply"). User-side 2-min budget is enough per user direction
 * (originally 5 min).
 *
 * **110s internal vs 120s cc-side**: same 10s margin model as the
 * regular flow — preserves the `hook stdout deterministic` + daemon
 * retry budget + network jitter envelope.
 *
 * On timeout (user never replied): hook **self-constructs** an
 * `updatedInput` with empty `answers` per question and returns
 * `permissionDecision: 'allow'` — cc records the tool as completed
 * with empty answers; the model decides what to do next (retry,
 * rephrase, give up). Crucially we **do NOT use the deny channel** for
 * timeout; deny is not part of AUQ's documented response semantics.
 */
const ASK_USER_QUESTION_TIMEOUT_MS = 110_000;

const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

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

/**
 * PermissionRequest hook internal poll deadline. Per
 * [DD: PermissionRequest hook IM bridge §3 D8](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md#3-dimensions--user-decisions):
 * 110s internal + 120s cc-side setting (in setup-hooks) = mirror v1.9 AUQ
 * timing. Gives user up to 110s to answer in IM before hook self-handles
 * timeout (avoids cc 10-min default kicking in mid-flow).
 */
const PERMISSION_DIALOG_TIMEOUT_MS = 110_000;

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
   * Override the pane-origin detector chain. Tests inject a concrete
   * `{termId, paneId}` (or undefined to simulate "cc not in any
   * supported terminal" filter path). Default runs `DEFAULT_DETECTORS`
   * against `process.env`. The returned `termId` is load-bearing for
   * issue 378 fix: it selects which `IM<TermType>` file to read,
   * preventing wezterm cc hooks from being honored when the daemon is
   * configured for iterm2 (and vice versa).
   */
  resolvePaneOrigin?: () => PaneOrigin | undefined;
  /** Override PreToolUse poll interval (ms). Tests use a small value. */
  permissionPollIntervalMs?: number;
  /** Override PreToolUse total wait budget (ms). Tests use a small value. */
  permissionTimeoutMs?: number;
  /**
   * Override the AskUserQuestion-specific poll deadline (ms). Default
   * `ASK_USER_QUESTION_TIMEOUT_MS` (110s per DD §9.5). Tests use a small
   * value to exercise the timeout branch without waiting 110s.
   */
  askUserQuestionTimeoutMs?: number;
  /**
   * Override the PermissionRequest-specific poll deadline (ms). Default
   * `PERMISSION_DIALOG_TIMEOUT_MS` (110s per DD §3 D8). Tests use a small
   * value to exercise the timeout branch without waiting 110s.
   */
  permissionDialogTimeoutMs?: number;
}

/**
 * Default pane-origin resolver. Runs the `DEFAULT_DETECTORS` list
 * against the current process env; returns the first match as
 * `{termId, paneId}`, or undefined if no supported terminal is
 * detected.
 *
 * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)
 * this is the **filter** that gates whether the hook writes anything to
 * disk — undefined means cc is in ssh / VS Code terminal /
 * non-supported terminal, and multi-cc-im has nothing to do with it.
 *
 * Returning `termId` alongside `paneId` (issue 378 fix) lets the gate
 * pick the per-terminal `IM<TermType>` file directly, rather than
 * re-deriving terminal from `typeof paneId`. The branded `paneId` is
 * still `number | string`; downstream uses it as an opaque key (state
 * file naming, IMOrigin map, etc.).
 */
function defaultResolvePaneOrigin(): PaneOrigin | undefined {
  return runDetectors(DEFAULT_DETECTORS, process.env);
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
 *   1. read-only tool → emit `permissionDecision: allow` (no Request file written)
 *   2. read IMWork: null → **silent exit** (return undefined → no JSON in stdout).
 *      cc falls through to its native permission flow: user-configured `allow`/
 *      `ask`/`deny` rules apply, then default first-time prompt. **NOT `ask`** —
 *      `ask` overrides user-saved allow rules; silent exit respects them.
 *   3. IMWork.auto = true → emit `permissionDecision: allow`
 *      (per [DD: PreToolUse auto-approve](../../../docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md);
 *       user opted in via bare `/start` — default is auto since v1.7)
 *   4. !`<paneId>.IMOrigin` → silent exit (same reason as step 2)
 *   5. !daemon alive → silent exit (same reason as step 2)
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
): Promise<
  HookDecision | PreToolUseHookOutput | PermissionRequestHookOutput | void
> {
  const { stateDir, payload } = opts;
  const sessionId = payload.session_id;

  // Terminal-detector filter — gate everything before we touch disk.
  // Returns BOTH which terminal we're in (`termId`) AND the pane id
  // within it (`paneId`). The `termId` selects which `IM<TermType>`
  // file we read for the IM-mode gate, so a cc instance in the
  // non-active terminal silent-exits even if it has hooks installed.
  const resolvePaneOrigin =
    opts.resolvePaneOrigin ?? defaultResolvePaneOrigin;
  const origin = resolvePaneOrigin();
  if (origin === undefined) {
    // cc is running outside any supported terminal. Silently exit.
    return;
  }
  const { termId, paneId } = origin;

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

      // E1.5 + E2: load IMWork JSON.
      //
      // - null (IM mode OFF) → silent exit (no JSON output, no decision).
      //   cc treats this as "no opinion" and falls through to its native
      //   permission flow: user-configured allow rules apply (e.g. `Bash(cd:*)`
      //   from prior "Yes don't ask again"), then ask rules, then deny rules,
      //   then default first-time prompt. Anthropics' own `validate-bash.sh`
      //   example uses this same pattern.
      //
      //   Why NOT `permissionDecision: "ask"`: returning `ask` forces a
      //   prompt every time, **overriding user-saved allow rules**. The cc
      //   docs only guarantee that hook output cannot bypass user `deny` /
      //   `ask` rules — not user `allow` rules. Returning `ask` makes us
      //   strictly worse than not having a hook at all.
      //
      // - {auto:true} (IM mode ON, trust mode via `/start auto`) →
      //   `allow`, fast-path without IM round-trip (E1.5).
      //
      // - {auto:false} (IM mode ON, ask mode) → fall through to E3.
      const imWork = await readIMWorkFile(stateDir, termId);
      if (imWork === null) {
        return; // E2: silent exit, defer to cc native permission flow
      }
      // AskUserQuestion special-case (DD AskUserQuestion §6 P2, D1-B): the
      // auto-allow short-circuit applies to every other tool but NOT to
      // AskUserQuestion. cc widget questions must reach IM in both auto and
      // ask modes — auto-allow would render the widget in cc TUI without IM
      // visibility, which is exactly the UX failure the DD fixes.
      const isAskUserQuestion = payload.tool_name === ASK_USER_QUESTION_TOOL_NAME;
      if (!isAskUserQuestion && imWork.auto) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason:
              '[multi-cc-im] IMWork auto-approve, allow without IM prompt',
          },
        };
      }

      // E3: IMWork on but no IM thread bound (no recent inbound from user)
      // → silent exit so user's allow rules still apply; otherwise cc falls
      // back to its TUI first-time prompt. Per [DD: IMOrigin global](../../../docs/superpowers/specs/2026-05-08-imorigin-global-dd.md)
      // IMOrigin is daemon-global (no paneId).
      if (!(await existsIMOriginFile(stateDir))) {
        return; // E3: silent exit, defer to cc native permission flow
      }

      // E4: daemon not running. Order intentionally last: IMWork + IMOrigin
      // checks are cheap (read+stat ~0.5ms), daemon liveness costs spawn ps
      // (~10-30ms). Most hook calls short-circuit at E2 / E3.
      if (!(await isDaemonAlive(stateDir))) {
        return; // E4: silent exit, defer to cc native permission flow
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
      // AskUserQuestion gets the longer poll deadline (P1 settings.json
      // matched a 120s cc-side timeout for this tool — internal 110s leaves
      // the same 10s margin as the regular path's 20s/10s split).
      const timeoutMs = isAskUserQuestion
        ? opts.askUserQuestionTimeoutMs ?? ASK_USER_QUESTION_TIMEOUT_MS
        : opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      // Holds the hook output once we either receive a PermissionResponse
      // or finalize a timeout fallback. Stays undefined until the polling
      // loop / timeout branch fills it in.
      let hookOutput: PreToolUseHookOutput | undefined;
      // Delete-always semantics (user policy 2026-05-11): wrap the entire
      // polling loop in try/finally so the Request + Response files are
      // ALWAYS deleted on exit — success (break), timeout (deadline), or
      // throw (non-ENOENT filesystem error). The polling loop reads
      // Response BEFORE finally runs, so this doesn't race the read.
      try {
        while (Date.now() < deadline) {
          try {
            await stat(respPath);
            const resp = await readPermissionResponseFile(respPath);
            if (resp && resp.requestId === requestId) {
              if (resp.decision === 'allow') {
                // Forward `updatedInput` and/or `reason` if present.
                // AskUserQuestion answer-inject path sends `updatedInput:
                // {questions, answers}` per DD §9.3; generic AI-routed
                // allow may send just a reason. Neither is required.
                hookOutput = {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    ...(resp.updatedInput !== undefined
                      ? { updatedInput: resp.updatedInput }
                      : {}),
                    ...(resp.reason !== undefined
                      ? { permissionDecisionReason: resp.reason }
                      : {}),
                  },
                };
              } else {
                // decision === 'deny' — reason is required by schema.
                hookOutput = {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: resp.reason,
                  },
                };
              }
              break;
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
          await sleep(pollMs);
        }
      } finally {
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
      }

      if (hookOutput) return hookOutput;

      // Timeout fallback. AskUserQuestion gets a structured allow +
      // empty-answers updatedInput (per DD §9.5) so the tool records as
      // completed with empty user answers and cc decides what to do next;
      // generic tools default to a plain allow (existing v1.7 behavior).
      if (isAskUserQuestion) {
        const parsed = AskUserQuestionToolInputSchema.safeParse(
          payload.tool_input,
        );
        if (parsed.success) {
          const emptyAnswers: Record<string, string> = {};
          for (const q of parsed.data.questions) {
            emptyAnswers[q.question] = '';
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: {
                questions: parsed.data.questions,
                answers: emptyAnswers,
              },
              permissionDecisionReason:
                '[multi-cc-im] AskUserQuestion timed out (no IM reply); empty answers',
            },
          };
        }
        // tool_input shape unexpected — fall through to plain allow; cc
        // renders the widget in TUI as a defensive last resort.
      }

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `${Math.round(timeoutMs / 1000)}s timeout, default allow`,
        },
      };
    }

    case 'PermissionRequest': {
      // P4 handler per [DD: PermissionRequest hook IM bridge §4](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md#4-recommendation--safety-property).
      //
      // Decision tree (mirrors PreToolUse short-circuits):
      //   E1 IMWork null         → silent exit (cc falls back to TUI dialog)
      //   E2 !IMOrigin           → silent exit (no IM thread to forward to)
      //   E3 !daemon alive       → silent exit (no listener for our Request)
      //   E4 forward path        → write PermissionDialogRequest file with
      //                            permission_suggestions, poll matching
      //                            Response file for ≤110s, emit cc stdout
      //                            JSON based on Response decision.
      //
      // Note: BOTH `/start auto` (D2-A: silent single-yes) AND `/start off`
      // (D3-A: IM forward) flow through the daemon for unified handling.
      // The auto vs off branching happens in the daemon (orchestrator) so
      // it can emit IM audit log (D5-B) consistently. Hook-side stays simple.

      if ((await readIMWorkFile(stateDir, termId)) === null) return; // E1
      if (!(await existsIMOriginFile(stateDir))) return; // E2
      if (!(await isDaemonAlive(stateDir))) return; // E3

      // Sweep stale Request/Response files for this pane+sid before writing
      // the new Request (defends against prior hook subprocess killed
      // mid-cleanup). Mirrors PreToolUse path.
      const staleReq = await listPermissionDialogRequestFiles({
        stateDir,
        paneId,
        sessionId,
      });
      for (const f of staleReq) await deletePermissionFileByPath(f);
      const staleResp = await listPermissionDialogResponseFiles({
        stateDir,
        paneId,
        sessionId,
      });
      for (const f of staleResp) await deletePermissionFileByPath(f);

      const requestId = randomBytes(4).toString('hex');
      await writePermissionDialogRequestFile({
        stateDir,
        paneId,
        sessionId,
        requestId,
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        permissionSuggestions: payload.permission_suggestions ?? [],
        createdAt: Date.now(),
      });

      const respPath = permissionDialogResponsePath({
        stateDir,
        paneId,
        sessionId,
        requestId,
      });
      const pollMs =
        opts.permissionPollIntervalMs ?? PERMISSION_POLL_INTERVAL_MS;
      const timeoutMs =
        opts.permissionDialogTimeoutMs ?? PERMISSION_DIALOG_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      let hookOutput: PermissionRequestHookOutput | undefined;

      // Delete-always semantics: wrap polling in try/finally so Request +
      // Response are ALWAYS deleted on exit (success / timeout / throw).
      // Same pattern as PreToolUse + AskUserQuestion paths.
      try {
        while (Date.now() < deadline) {
          try {
            await stat(respPath);
            const resp = await readPermissionDialogResponseFile(respPath);
            if (resp && resp.requestId === requestId) {
              if (resp.decision.behavior === 'allow') {
                hookOutput = {
                  hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: {
                      behavior: 'allow',
                      ...(resp.decision.updatedInput !== undefined
                        ? { updatedInput: resp.decision.updatedInput }
                        : {}),
                      ...(resp.decision.updatedPermissions !== undefined
                        ? {
                            updatedPermissions: resp.decision.updatedPermissions,
                          }
                        : {}),
                    },
                  },
                };
              } else {
                hookOutput = {
                  hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: {
                      behavior: 'deny',
                      ...(resp.decision.message !== undefined
                        ? { message: resp.decision.message }
                        : {}),
                    },
                  },
                };
              }
              break;
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
          await sleep(pollMs);
        }
      } finally {
        await deletePermissionDialogRequestFile({
          stateDir,
          paneId,
          sessionId,
          requestId,
        });
        await deletePermissionDialogResponseFile({
          stateDir,
          paneId,
          sessionId,
          requestId,
        });
      }

      if (hookOutput) return hookOutput;

      // Timeout fallback — emit a plain `allow` (no `updatedPermissions`
      // so cc still gates subsequent same-session sensitive paths). This
      // aligns with D2-A "single-yes, don't silently grant session-wide
      // bypass" but applied to the timeout case where user simply didn't
      // answer. cc TUI dialog won't re-render (allow = dialog never
      // renders per source §2.4); cc proceeds with the tool.
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      };
    }

    case 'Stop': {
      // 3-step short-circuit guards mirror PreToolUse. Order:
      //   E1 !IMWork → return void (local mode)
      //   E2 !IMOrigin → return void (no IM thread)
      //   E3 !daemon alive → return void (no listener)

      if (!(await existsIMWorkFile(stateDir, termId))) return;
      // IMOrigin is daemon-global (DD: IMOrigin global) — no paneId.
      if (!(await existsIMOriginFile(stateDir))) return;
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
        termId,
      });
      if (payload.stop_hook_active === false) {
        const reason = await popInjection({ stateDir, sessionId });
        if (reason !== null) return { decision: 'block', reason };
      }
      return;
    }
  }
}
