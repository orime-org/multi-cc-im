import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TerminalId } from '@multi-cc-im/shared';
import {
  type PaneOrigin,
  existsIMOriginFile,
  existsIMWorkFile,
  formatStopTimestamp,
  isDaemonAlive,
  writeSessionReplyFile,
  readIMWorkFile,
  listPermissionRequestFiles,
  listPermissionResponseFiles,
  deletePermissionFileByPath,
  writePermissionRequestFile,
  readPermissionResponseFile,
  deletePermissionRequestFile,
  deletePermissionResponseFile,
  permissionResponsePath,
  listPermissionDialogRequestFiles,
  listPermissionDialogResponseFiles,
  writePermissionDialogRequestFile,
  readPermissionDialogResponseFile,
  deletePermissionDialogRequestFile,
  deletePermissionDialogResponseFile,
  permissionDialogResponsePath,
} from '@multi-cc-im/cli-cc';

/** Poll interval for Permission Request/Dialog Response files (ms). */
const PERMISSION_POLL_INTERVAL_MS = 200;
/** PreToolUse poll deadline (ms) before falling back to default-allow. */
const PERMISSION_TIMEOUT_MS = 10_000;
/** PermissionRequest poll deadline (ms) — matches cli-cc DD §3 D8. */
const PERMISSION_DIALOG_TIMEOUT_MS = 110_000;
import {
  parseHookPayload,
  type ParsedHookPayload,
  type StopPayload,
  type SessionStartPayload,
  type PreToolUsePayload,
  type PermissionRequestPayload,
} from './payloads.js';

/**
 * Codex hook subprocess entry point. Mirrors the dispatch shape of
 * `@multi-cc-im/cli-cc`'s `runHookReceiver` but speaks codex's stdin
 * payload + stdout response shapes (see `payloads.ts` TSDoc for the
 * cc-vs-codex field differences).
 *
 * Native hooks may execute in a shared App Server environment. Permission
 * events use the injected official-title pane resolver. Stop events use native
 * session metadata and carry their source name in the session reply queue.
 *
 * **Stdout protocol per codex docs**:
 *
 * - Empty stdout (silent exit) → codex falls through to its native
 *   approval / Stop / SessionStart flow. multi-cc-im uses this for
 *   all gate-failed paths (IMWork off, no IMOrigin, daemon dead).
 * - Stop branch may return `{decision: 'block', reason}` to keep the
 *   turn running (codex spec same as cc).
 * - PreToolUse branch returns
 *   `{hookSpecificOutput: {permissionDecision: 'allow'|'deny',
 *    permissionDecisionReason?: string, updatedInput?: {...}}}`.
 * - PermissionRequest branch returns
 *   `{hookSpecificOutput: {hookEventName: 'PermissionRequest',
 *    decision: {behavior: 'allow'|'deny', message?: string}}}`.
 *
 */

/**
 * Stop-branch return shape (matches cc per codex docs convention).
 * `block` keeps the turn running and the `reason` becomes the next
 * user prompt — multi-cc-im does not use this currently but the
 * type is here for completeness so downstream can pattern-match.
 */
export interface StopBlockOutput {
  decision: 'block';
  reason: string;
}

/**
 * PreToolUse stdout shape per codex
 * `https://developers.openai.com/codex/hooks` (event "PreToolUse").
 * Mirrors cc shape: top-level `hookSpecificOutput` with
 * `permissionDecision` + optional `updatedInput` + optional
 * `permissionDecisionReason`.
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
        permissionDecision: 'deny';
        permissionDecisionReason: string;
      };
};

/**
 * PermissionRequest stdout shape per codex docs (event
 * "PermissionRequest"). The event-specific decision must be nested under
 * `hookSpecificOutput` and tagged with its event name.
 */
export type PermissionRequestHookOutput = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: {
      behavior: 'allow' | 'deny';
      message?: string;
    };
  };
};

export type HookReceiverOutput =
  | StopBlockOutput
  | PreToolUseHookOutput
  | PermissionRequestHookOutput
  | void;

export interface RunHookReceiverOpts {
  /** Directory where state files live (e.g. `~/.multi-cc-im/state/`). */
  stateDir: string;
  /** Already-parsed + validated stdin payload (see `parseHookPayload`). */
  payload: ParsedHookPayload;
  /**
   * Override the timestamp factory used for Stop file naming. Tests
   * inject a fixed Date for deterministic file naming; production
   * code passes nothing (defaults to `new Date()`).
   */
  now?: () => Date;
  /**
   * Resolve the native thread through fresh official terminal titles and
   * loaded ids. Tests inject explicit origins; production uses hook-origin.
   */
  resolvePaneOrigin?: (threadId: string) => PaneOrigin | undefined | Promise<PaneOrigin | undefined>;
  /** Selected IM gate and bounded native name lookup for Stop replies. */
  stop?: {
    termId: TerminalId;
    resolveSessionName(threadId: string): Promise<string | undefined>;
  };
  /** Override PreToolUse poll interval (ms). Tests inject a small value. */
  permissionPollIntervalMs?: number;
  /** Override PreToolUse total wait budget (ms). Tests inject a small value. */
  permissionTimeoutMs?: number;
  /** Override PermissionRequest total wait budget (ms). Tests inject a small value. */
  permissionDialogTimeoutMs?: number;
  /** Diagnostic trace callback; same swallowing semantics as cli-cc's. */
  trace?: (line: string) => void;
}

/**
 * Process a single codex hook event. The gate sequence is parallel
 * to cli-cc's, with the only difference being which event variants
 * carry which fields (see `payloads.ts`).
 *
 * Stop checks reply eligibility before native name lookup. Permission events
 * resolve their official pane origin before the event-specific gate sequence.
 */
export async function runHookReceiver(
  opts: RunHookReceiverOpts,
): Promise<HookReceiverOutput> {
  const { stateDir, payload } = opts;
  const trace = (line: string): void => {
    try {
      opts.trace?.(line);
    } catch {
      /* swallow */
    }
  };

  if (payload.hook_event_name === 'SessionStart') return handleSessionStart(payload, trace);
  if (payload.hook_event_name === 'Stop') {
    if (!opts.stop) { trace('Codex Stop name resolver unavailable'); return; }
    return handleStop({ stateDir, payload, ...opts.stop,
      now: opts.now ?? ((): Date => new Date()), trace });
  }
  const origin = await opts.resolvePaneOrigin?.(payload.session_id);
  if (origin === undefined) {
    trace('Codex thread origin unavailable; defer to native terminal handling');
    return;
  }
  const { termId, paneId } = origin;
  trace(
    `detector: termId=${termId} paneId=${String(paneId)} event=${payload.hook_event_name}`,
  );

  switch (payload.hook_event_name) {
    case 'PreToolUse':
      return handlePreToolUse({
        stateDir,
        payload,
        paneId,
        termId,
        pollIntervalMs: opts.permissionPollIntervalMs ?? PERMISSION_POLL_INTERVAL_MS,
        timeoutMs: opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS,
        trace,
      });
    case 'PermissionRequest':
      return handlePermissionRequest({
        stateDir,
        payload,
        paneId,
        termId,
        pollIntervalMs: opts.permissionPollIntervalMs ?? PERMISSION_POLL_INTERVAL_MS,
        timeoutMs: opts.permissionDialogTimeoutMs ?? PERMISSION_DIALOG_TIMEOUT_MS,
        trace,
      });
  }
}

/**
 * SessionStart is a trace-only lifecycle no-op. Discovery uses current official
 * title ids, so no hook pane registration or cleanup is needed after restart.
 */
function handleSessionStart(
  payload: SessionStartPayload,
  trace: (line: string) => void,
): void {
  trace(`SessionStart source=${payload.source}: no pane registration`);
  return;
}

interface HandlePreToolUseOpts {
  stateDir: string;
  payload: PreToolUsePayload;
  paneId: PaneOrigin['paneId'];
  termId: PaneOrigin['termId'];
  pollIntervalMs: number;
  timeoutMs: number;
  trace: (line: string) => void;
}

/**
 * PreToolUse — full IM forward + poll. Mirrors cli-cc PreToolUse
 * gate cascade (IMWork null → silent / auto → allow / no IMOrigin →
 * silent / daemon dead → silent), writes a PermissionRequest file
 * keyed by `<paneId>_<sid>.PermissionRequest.<requestId>.json`,
 * polls the matching `<paneId>_<sid>.PermissionResponse.<requestId>`
 * file written by the daemon after IM user replies, returns the
 * decision back to codex via the `PreToolUseHookOutput` shape.
 *
 * Codex-vs-cc differences embedded:
 * - No `AskUserQuestion` special-case (codex routes those through
 *   PermissionRequest event instead, see handlePermissionRequest).
 * - No read-only tool allowlist (codex tool set differs — Bash /
 *   apply_patch / MCP — and the user-facing tool name regex matchers
 *   in setup-hooks already pre-filter; downstream auto-allow logic
 *   is moot for the codex tool surface).
 * - `tool_use_id` is non-empty here, so we use it verbatim in the
 *   trace line (cli-cc emits its own short hex id since cc's
 *   `tool_use_id` is empty pre-execution).
 *
 * Delete-always: PermissionRequest + Response files are removed in
 * `finally` regardless of success / timeout / throw, so a crashed
 * hook subprocess never leaves stale files. Daemon-side reaper is
 * the safety net for the crash case where this `finally` doesn't run.
 */
async function handlePreToolUse(
  opts: HandlePreToolUseOpts,
): Promise<PreToolUseHookOutput | void> {
  const { stateDir, payload, paneId, termId, pollIntervalMs, timeoutMs, trace } = opts;
  const sessionId = payload.session_id;

  const imWork = await readIMWorkFile(stateDir, termId);
  if (imWork === null) {
    trace(`PreToolUse gate: !IMWork(${termId}), silent-exit (defer to codex native)`);
    return;
  }
  if (imWork.auto) {
    trace(`PreToolUse auto-mode: allow without IM prompt`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          '[multi-cc-im] IMWork auto-approve, allow without IM prompt',
      },
    };
  }
  if (!(await existsIMOriginFile(stateDir))) {
    trace(`PreToolUse gate: !IMOrigin, silent-exit`);
    return;
  }
  if (!(await isDaemonAlive(stateDir))) {
    trace(`PreToolUse gate: !daemon-alive, silent-exit`);
    return;
  }

  // Clean stale Request/Response files for this pane+sid before writing fresh.
  const staleReq = await listPermissionRequestFiles({ stateDir, paneId, sessionId });
  for (const f of staleReq) await deletePermissionFileByPath(f);
  const staleResp = await listPermissionResponseFiles({ stateDir, paneId, sessionId });
  for (const f of staleResp) await deletePermissionFileByPath(f);

  const requestId = randomBytes(4).toString('hex');
  trace(
    `PreToolUse forward: tool=${payload.tool_name} turn_id=${payload.turn_id} ` +
      `tool_use_id=${payload.tool_use_id} requestId=${requestId}`,
  );
  // Coerce tool_input (unknown per codex schema — `tool_input: true` allows
  // arbitrary JSON) to a Record for our writer signature. zod parsed it as
  // `unknown` so we narrow defensively before passing along.
  const toolInputRecord =
    payload.tool_input !== null && typeof payload.tool_input === 'object'
      ? (payload.tool_input as Record<string, unknown>)
      : {};
  await writePermissionRequestFile({
    stateDir,
    paneId,
    sessionId,
    requestId,
    toolName: payload.tool_name,
    toolInput: toolInputRecord,
    createdAt: Date.now(),
  });

  const respPath = permissionResponsePath({ stateDir, paneId, sessionId, requestId });
  const deadline = Date.now() + timeoutMs;
  let hookOutput: PreToolUseHookOutput | undefined;
  try {
    while (Date.now() < deadline) {
      try {
        await stat(respPath);
        const resp = await readPermissionResponseFile(respPath);
        if (resp && resp.requestId === requestId) {
          if (resp.decision === 'allow') {
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
      await sleep(pollIntervalMs);
    }
  } finally {
    await deletePermissionRequestFile({ stateDir, paneId, sessionId, requestId });
    await deletePermissionResponseFile({ stateDir, paneId, sessionId, requestId });
  }

  if (hookOutput) return hookOutput;

  // Timeout default-allow — same convention cli-cc uses for generic
  // (non-AskUserQuestion) tools. Codex sees an allow rather than
  // being blocked indefinitely if the user never answers IM.
  trace(`PreToolUse timeout (${timeoutMs}ms): default-allow`);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `${Math.round(timeoutMs / 1000)}s timeout, default allow`,
    },
  };
}

interface HandlePermissionRequestOpts {
  stateDir: string;
  payload: PermissionRequestPayload;
  paneId: PaneOrigin['paneId'];
  termId: PaneOrigin['termId'];
  pollIntervalMs: number;
  timeoutMs: number;
  trace: (line: string) => void;
}

/**
 * PermissionRequest — codex-native escalation dialog. Mirrors cli-cc
 * PermissionRequest dispatch but emits codex's stdout shape:
 * `{hookSpecificOutput: {hookEventName: 'PermissionRequest', decision: ...}}`.
 *
 * Gate sequence identical to PreToolUse (IMWork / IMOrigin /
 * daemon-alive). Forwards via the `PermissionDialogRequest` /
 * `PermissionDialogResponse` file pair (distinct from PreToolUse's
 * `PermissionRequest` files — cc DD §6 C.1 keeps them separate so
 * concurrent PreToolUse + PermissionRequest fires don't race on
 * the same response file).
 *
 * `permission_suggestions` is omitted — codex doesn't surface a
 * "Yes always X" suggestion array the way cc does, so the IM card
 * shown to the user is simpler (just allow/deny, no quick-rules).
 * Daemon-side rendering already handles `permission_suggestions: []`
 * fine (empty array → no quick-rule buttons in the IM card).
 */
async function handlePermissionRequest(
  opts: HandlePermissionRequestOpts,
): Promise<PermissionRequestHookOutput | void> {
  const { stateDir, payload, paneId, termId, pollIntervalMs, timeoutMs, trace } = opts;
  const sessionId = payload.session_id;

  if ((await readIMWorkFile(stateDir, termId)) === null) {
    trace(`PermissionRequest gate: !IMWork, silent-exit`);
    return;
  }
  if (!(await existsIMOriginFile(stateDir))) {
    trace(`PermissionRequest gate: !IMOrigin, silent-exit`);
    return;
  }
  if (!(await isDaemonAlive(stateDir))) {
    trace(`PermissionRequest gate: !daemon-alive, silent-exit`);
    return;
  }

  const staleReq = await listPermissionDialogRequestFiles({ stateDir, paneId, sessionId });
  for (const f of staleReq) await deletePermissionFileByPath(f);
  const staleResp = await listPermissionDialogResponseFiles({ stateDir, paneId, sessionId });
  for (const f of staleResp) await deletePermissionFileByPath(f);

  const requestId = randomBytes(4).toString('hex');
  trace(
    `PermissionRequest forward: tool=${payload.tool_name} turn_id=${payload.turn_id} ` +
      `requestId=${requestId}`,
  );
  const toolInputRecord =
    payload.tool_input !== null && typeof payload.tool_input === 'object'
      ? (payload.tool_input as Record<string, unknown>)
      : {};
  await writePermissionDialogRequestFile({
    stateDir,
    paneId,
    sessionId,
    requestId,
    toolName: payload.tool_name,
    toolInput: toolInputRecord,
    permissionSuggestions: [],
    createdAt: Date.now(),
  });

  const respPath = permissionDialogResponsePath({ stateDir, paneId, sessionId, requestId });
  const deadline = Date.now() + timeoutMs;
  let hookOutput: PermissionRequestHookOutput | undefined;
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
                decision: { behavior: 'allow' },
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
      await sleep(pollIntervalMs);
    }
  } finally {
    await deletePermissionDialogRequestFile({ stateDir, paneId, sessionId, requestId });
    await deletePermissionDialogResponseFile({ stateDir, paneId, sessionId, requestId });
  }

  if (hookOutput) return hookOutput;

  // Timeout default-allow — same convention as cli-cc PermissionRequest
  // (D2-A "single-yes, don't silently grant session-wide bypass" applies
  // to the answered case; timeout falls through to plain allow without
  // suggestions so codex proceeds with the tool but no session rule).
  trace(`PermissionRequest timeout (${timeoutMs}ms): default-allow`);
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  };
}

interface HandleStopOpts {
  stateDir: string;
  payload: StopPayload;
  termId: TerminalId;
  resolveSessionName(threadId: string): Promise<string | undefined>;
  now: () => Date;
  trace: (line: string) => void;
}

/**
 * Stop eligibility is checked before reading the native session name. The
 * session reply queue carries the source label and text to the shared watcher.
 */
async function handleStop(opts: HandleStopOpts): Promise<void> {
  const { stateDir, payload, termId, now, trace } = opts;
  const sessionId = payload.session_id;

  if (payload.stop_hook_active || !payload.last_assistant_message) {
    trace('Stop gate: active stop hook or empty assistant message');
    return;
  }

  // Gate 1: IMWork file exists (= daemon is in IM mode for this terminal)
  if (!(await existsIMWorkFile(stateDir, termId))) {
    trace(`Stop gate: !IMWork(${termId}), silent-exit`);
    return;
  }
  // Gate 2: IMOrigin file exists (= last IM inbound context is on disk).
  // Per cli-cc DD: IMOrigin is global (one file per daemon, not per pane);
  // every IM inbound overwrites it. We only need to check existence.
  if (!(await existsIMOriginFile(stateDir))) {
    trace(`Stop gate: !IMOrigin (global), silent-exit`);
    return;
  }
  // Gate 3: daemon is alive
  if (!(await isDaemonAlive(stateDir))) {
    trace(`Stop gate: !daemon-alive, silent-exit`);
    return;
  }

  const sessionName = await opts.resolveSessionName(sessionId);
  if (sessionName === undefined) return;
  const timestamp = formatStopTimestamp(now());
  await writeSessionReplyFile({
    stateDir, timestamp,
    reply: { cli: 'codex', sessionId, sessionName, termId,
      last_assistant_message: payload.last_assistant_message },
  });
  trace(
    `Stop wrote: SessionReply.codex.${sessionId}.${timestamp}.json ` +
      `(msg_len=${payload.last_assistant_message?.length ?? 0})`,
  );
  return;
}

/**
 * Convenience entry: read JSON from stdin string, parse, dispatch.
 * Hosts supply native name lookup for Stop and pane origin lookup for
 * permission events. The binary injects its configured capabilities.
 * Errors propagate; callers log diagnostics and reserve stdout for native JSON.
 */
export async function runFromStdin(
  rawStdin: string,
  opts: Omit<RunHookReceiverOpts, 'payload'>,
): Promise<HookReceiverOutput> {
  const payload = parseHookPayload(rawStdin);
  return runHookReceiver({ ...opts, payload });
}
