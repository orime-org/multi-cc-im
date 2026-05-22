import {
  DEFAULT_DETECTORS,
  runDetectors,
  type PaneOrigin,
} from '@multi-cc-im/cli-cc';
import {
  existsIMOriginFile,
  existsIMWorkFile,
  formatStopTimestamp,
  isDaemonAlive,
  listStopFiles,
  deleteStopFile,
  writeStopFile,
} from '@multi-cc-im/cli-cc';
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
 * Codex hook subprocess inherits the parent codex process's env, so
 * `WEZTERM_PANE` / `ITERM_SESSION_ID` (set by the user's wezterm /
 * iTerm tab) are visible here exactly as they are to cli-cc — no new
 * detector logic needed; we re-export `DEFAULT_DETECTORS` from cli-cc.
 *
 * **State file protocol parity**: codex hooks write to the same
 * `<paneId>_<sid>.Stop.<ts>` / `<paneId>_<sid>.PermissionRequest.<id>`
 * filenames the daemon's chokidar watcher already consumes. The daemon
 * is CLI-agnostic at this layer — Stop file body content
 * (`last_assistant_message`) is identical structure across cc and
 * codex, so dispatch downstream works without changes.
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
 *   `{decision: {behavior: 'allow'|'deny', message?: string}}`.
 *
 * **Incremental rollout note (2026-05-22)**: this commit lands the
 * full Stop + SessionStart paths and the dispatch frame for
 * PreToolUse / PermissionRequest. The latter two currently silent-exit
 * — codex falls through to its native TUI approval, preserving the
 * user's ability to use codex normally while multi-cc-im learns
 * codex's response shape via real-account smoke. The next commit on
 * this same branch wires IM forward + poll for those two events,
 * fully replacing native TUI approval with IM-side cards.
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
 * "PermissionRequest"). `decision.behavior` is the codex spec — distinct
 * from cc which uses `permissionDecision`. Either `allow` or `deny`.
 */
export type PermissionRequestHookOutput = {
  decision: {
    behavior: 'allow' | 'deny';
    message?: string;
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
   * Override the pane-origin detector. Default re-uses cli-cc's
   * `DEFAULT_DETECTORS` against `process.env` (codex inherits env
   * from its parent tab; WEZTERM_PANE / ITERM_SESSION_ID flow through
   * transparently).
   */
  resolvePaneOrigin?: () => PaneOrigin | undefined;
  /** Diagnostic trace callback; same swallowing semantics as cli-cc's. */
  trace?: (line: string) => void;
}

function defaultResolvePaneOrigin(): PaneOrigin | undefined {
  return runDetectors(DEFAULT_DETECTORS, process.env);
}

/**
 * Process a single codex hook event. The gate sequence is parallel
 * to cli-cc's, with the only difference being which event variants
 * carry which fields (see `payloads.ts`).
 *
 * Gate ordering (cheapest first):
 *   1. Terminal detector — silent-exit when no supported terminal
 *      env (cc launched outside wezterm / iTerm; nothing to do).
 *   2. Event-specific dispatch (Stop / SessionStart / PreToolUse /
 *      PermissionRequest).
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

  const resolvePaneOrigin =
    opts.resolvePaneOrigin ?? defaultResolvePaneOrigin;
  const origin = resolvePaneOrigin();
  if (origin === undefined) {
    trace(`detector: no supported terminal env, silent-exit`);
    return;
  }
  const { termId, paneId } = origin;
  trace(
    `detector: termId=${termId} paneId=${String(paneId)} event=${payload.hook_event_name}`,
  );

  switch (payload.hook_event_name) {
    case 'SessionStart':
      return handleSessionStart(payload, trace);
    case 'PreToolUse':
      return handlePreToolUse(payload, trace);
    case 'PermissionRequest':
      return handlePermissionRequest(payload, trace);
    case 'Stop':
      return handleStop({
        stateDir,
        payload,
        paneId,
        termId,
        now: opts.now ?? ((): Date => new Date()),
        trace,
      });
  }
}

/**
 * SessionStart fires on startup / resume / clear / compact. multi-cc-im
 * has nothing to do here in v0.2.0 — the daemon uses `wezterm cli
 * list` polling as the live source of truth for which panes contain
 * codex, same approach as cli-cc which dropped SessionStart per DD #61.
 *
 * The hook is registered (matcher `^startup$` only — see setup-hooks)
 * solely so a future revision can hang per-startup state on it (e.g.
 * persisting pane registry across daemon restarts) without
 * requiring users to re-run setup-hooks.
 */
function handleSessionStart(
  payload: SessionStartPayload,
  trace: (line: string) => void,
): void {
  trace(`SessionStart source=${payload.source}: silent-exit (no-op in v0.2.0)`);
  return;
}

/**
 * PreToolUse — silent-exit in this commit (see file header note). Codex
 * falls through to its native TUI approval flow. The next commit on
 * this same branch will land the full gate sequence cli-cc uses
 * (read-only allowlist / IMWork lookup / IMOrigin check / daemon-alive
 * probe / write PermissionRequest file / poll PermissionResponse) so
 * permissions forward to IM cards instead of TUI.
 */
function handlePreToolUse(
  payload: PreToolUsePayload,
  trace: (line: string) => void,
): void {
  trace(
    `PreToolUse tool=${payload.tool_name} turn_id=${payload.turn_id} ` +
      `tool_use_id=${payload.tool_use_id}: silent-exit (IM forward TBD next commit)`,
  );
  return;
}

/**
 * PermissionRequest — silent-exit in this commit (see file header
 * note). Codex falls through to its native TUI approval. Next commit
 * adds the IM card forward + poll PermissionDialogResponse using the
 * same state file protocol cli-cc established.
 */
function handlePermissionRequest(
  payload: PermissionRequestPayload,
  trace: (line: string) => void,
): void {
  trace(
    `PermissionRequest tool=${payload.tool_name} turn_id=${payload.turn_id}: ` +
      `silent-exit (IM forward TBD next commit)`,
  );
  return;
}

interface HandleStopOpts {
  stateDir: string;
  payload: StopPayload;
  paneId: PaneOrigin['paneId'];
  termId: PaneOrigin['termId'];
  now: () => Date;
  trace: (line: string) => void;
}

/**
 * Stop — mirror of cli-cc's Stop branch. 3-step gate then write the
 * `<paneId>_<sid>.Stop.<ts>` state file the daemon's chokidar reader
 * consumes to forward `last_assistant_message` to the IM `replyCtx`
 * recorded at inbound time.
 *
 * codex Stop payload has `last_assistant_message` as nullable string
 * (cli-cc has it as required string). When null, we serialize empty
 * string — the daemon-side dispatch treats that as a no-op forward
 * (nothing useful to send to IM), but still writes the file so
 * downstream debug logs see the event.
 */
async function handleStop(opts: HandleStopOpts): Promise<void> {
  const { stateDir, payload, paneId, termId, now, trace } = opts;
  const sessionId = payload.session_id;

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

  // Clear stale Stop files for this pane+sid before writing fresh one.
  // Multiple Stop files for the same pane+sid would let the daemon's
  // watcher fire forwards out of order; cleanup ensures one-file
  // semantics per turn.
  const stale = await listStopFiles({ stateDir, paneId, sessionId });
  for (const path of stale) {
    await deleteStopFile(path);
  }

  const timestamp = formatStopTimestamp(now());
  await writeStopFile({
    stateDir,
    paneId,
    sessionId,
    timestamp,
    last_assistant_message: payload.last_assistant_message ?? '',
    termId,
  });
  trace(
    `Stop wrote: ${String(paneId)}_${sessionId}.Stop.${timestamp} ` +
      `(msg_len=${payload.last_assistant_message?.length ?? 0})`,
  );
  return;
}

/**
 * Convenience entry: read JSON from stdin string, parse, dispatch.
 * Caller (binary) typically does `await runFromStdin(rawStdin,
 * { stateDir })` and writes the return value (if any) as JSON to
 * stdout. Errors propagate; caller handles logging.
 */
export async function runFromStdin(
  rawStdin: string,
  opts: Omit<RunHookReceiverOpts, 'payload'>,
): Promise<HookReceiverOutput> {
  const payload = parseHookPayload(rawStdin);
  return runHookReceiver({ ...opts, payload });
}
