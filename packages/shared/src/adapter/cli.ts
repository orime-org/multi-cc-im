import type { CwdAbs, SessionId, TranscriptPath } from '../types.js';

/**
 * Common fields present on every cc hook stdin payload.
 * Source: hook+wezterm DD H1 observed schema (2026-04-27).
 */
interface BaseHookPayload {
  session_id: SessionId;
  transcript_path: TranscriptPath;
  cwd: CwdAbs;
  hook_event_name: string;
}

/**
 * Hook fired when a cc session starts up.
 * `source` is open enum — known values `'startup'`; others reserved for
 * future cc behaviors (resume / restart) per H1 observation.
 */
export interface SessionStartPayload extends BaseHookPayload {
  hook_event_name: 'SessionStart';
  source: string;
  /** e.g. `'claude-opus-4-7[1m]'` — model with optional context-mode suffix. */
  model: string;
}

/**
 * Hook fired right before cc actually executes a tool (Bash / Edit / Write /
 * Read / WebFetch / etc.). Used by multi-cc-im as the **permission gate**
 * per [DD: permission forward](../../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md):
 * hook subprocess writes a `<sid>.PermissionRequest.<id>.json`, daemon
 * forwards to IM, IM user replies `@<tabname> /1` (allow) / `/2` (deny),
 * daemon writes `<sid>.PermissionResponse.<id>.json`, hook subprocess reads
 * it + writes stdout `{permissionDecision:"allow"|"deny"}` + exits.
 *
 * 30s timeout (custom per `setup-hooks.ts`); on timeout cc treats as allow
 * by default per cc PreToolUse hook protocol semantics.
 */
export interface PreToolUsePayload extends BaseHookPayload {
  hook_event_name: 'PreToolUse';
  permission_mode: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

/**
 * Hook fired when cc finishes a single assistant turn (NOT session end).
 * - `stop_hook_active: true` means the current Stop is being invoked inside
 *   a `decision:'block'` injection chain. multi-cc-im MUST `return` early
 *   when this is true — see CLAUDE.md "Key conventions": "use
 *   stop_hook_active to guard idle wakeups against infinite loops".
 * - `last_assistant_message` contains the assistant's reply text — bridge
 *   can forward this to IM directly without tailing the jsonl.
 */
export interface StopPayload extends BaseHookPayload {
  hook_event_name: 'Stop';
  permission_mode: string;
  stop_hook_active: boolean;
  last_assistant_message: string;
}

/**
 * Hook fired when a cc session terminates (clean `/exit`, logout, etc.).
 * Drives multi-cc-im's PaneAlive "graceful exit" signal.
 */
export interface SessionEndPayload extends BaseHookPayload {
  hook_event_name: 'SessionEnd';
  /** e.g. `'clear'`, `'logout'`, `'/exit'`, `'prompt_input_exit'`. */
  reason: string;
}

/** Discriminated union of every cc hook payload multi-cc-im subscribes to. */
export type HookPayload =
  | SessionStartPayload
  | PreToolUsePayload
  | StopPayload
  | SessionEndPayload;

/**
 * Stdout response shape that cc's Stop hook treats as an injection request.
 * Returning this from `Handler.onStop` causes cc to re-process `reason` as
 * if the user had typed it (`stop_hook_active` will be `true` on the
 * resulting Stop hook fire).
 */
export interface HookDecision {
  decision: 'block';
  reason: string;
}

/**
 * Handler an CLIAdapter pushes hook events into. The bridge implements this
 * to wire cc → router → IM.
 *
 * multi-cc-im subscribes to only 3 hook events. Earlier versions also
 * subscribed to `UserPromptSubmit` / `PreToolUse` / `PostToolUse` for
 * analytics, but cc's own transcript jsonl
 * (`~/.claude/projects/<dir>/<sid>.jsonl`) already records that data —
 * future analytics work should read cc's transcript directly via the
 * `transcript_path` exposed in each `SessionStart` payload.
 */
export interface Handler {
  onSessionStart(p: SessionStartPayload): Promise<void>;
  /**
   * On PreToolUse, called by adapter when daemon sees a fresh
   * `<sid>.PermissionRequest.<id>.json` arrive in state/. Daemon forwards
   * to IM and waits for user response. Adapter dispatches to bridge
   * orchestrator's onPreToolUse, which manages the IM forward + response
   * write. The actual hook subprocess that triggered this is asleep
   * polling for the response file — it doesn't return anything to cc here;
   * the response file does.
   */
  onPreToolUse(p: PreToolUsePayload & { requestId: string }): Promise<void>;
  /**
   * On Stop, the handler may return a `HookDecision` to inject a follow-up
   * prompt. Return `void` (or undefined) to let cc end the turn normally.
   *
   * Implementations MUST guard `p.stop_hook_active === true` and return
   * `void` in that case to avoid infinite block loops.
   */
  onStop(p: StopPayload): Promise<HookDecision | void>;
  onSessionEnd(p: SessionEndPayload): Promise<void>;
}

/**
 * Core CLIAdapter interface — covers cc / codex / gemini / aider.
 *
 * Outbound to a running cc process happens lazily via the Stop hook block
 * mechanism: `enqueueInjection` queues a prompt that the next non-active
 * Stop will return as `decision:'block'` reason.
 */
export interface Adapter {
  /** Stable identifier (e.g. `'claude-code'`). */
  readonly name: string;
  /** Subscribe to hook events from running cc processes. */
  start(handler: Handler): Promise<void>;
  /** Queue a prompt to be injected on the next normal Stop fire. */
  enqueueInjection(sessionId: SessionId, content: string): Promise<void>;
  /** Stop subscribing; release any IPC sockets. */
  stop(): Promise<void>;
}
