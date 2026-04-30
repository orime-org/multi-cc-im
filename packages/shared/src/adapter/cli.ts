import type { CwdAbs, SessionId, TranscriptPath } from '../types.js';

/**
 * Common fields present on every cc hook stdin payload.
 * Source: hook+wezterm DD H1 实测 schema (2026-04-27).
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

/** Hook fired right before cc submits a user prompt to the model. */
export interface UserPromptSubmitPayload extends BaseHookPayload {
  hook_event_name: 'UserPromptSubmit';
  permission_mode: string;
  /** Full user input text (multi-cc-im does NOT need to tail jsonl for this). */
  prompt: string;
}

/** Hook fired right before a cc tool call executes. */
export interface PreToolUsePayload extends BaseHookPayload {
  hook_event_name: 'PreToolUse';
  permission_mode: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

/** Hook fired right after a cc tool call returns. */
export interface PostToolUsePayload extends BaseHookPayload {
  hook_event_name: 'PostToolUse';
  permission_mode: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: {
    stdout: string;
    stderr: string;
    interrupted: boolean;
    isImage: boolean;
    noOutputExpected: boolean;
  };
  tool_use_id: string;
  duration_ms: number;
}

/**
 * Hook fired when cc finishes a single assistant turn (NOT session end).
 * - `stop_hook_active: true` means the current Stop is being invoked inside
 *   a `decision:'block'` injection chain. multi-cc-im MUST `return` early
 *   when this is true — see CLAUDE.md「关键规范」"idle 唤醒用 stop_hook_active
 *   防死循环".
 * - `last_assistant_message` contains the assistant's reply text — bridge
 *   can forward this to IM directly without tailing the jsonl.
 */
export interface StopPayload extends BaseHookPayload {
  hook_event_name: 'Stop';
  permission_mode: string;
  stop_hook_active: boolean;
  last_assistant_message: string;
}

/** Discriminated union of every cc hook payload multi-cc-im observes. */
export type HookPayload =
  | SessionStartPayload
  | UserPromptSubmitPayload
  | PreToolUsePayload
  | PostToolUsePayload
  | StopPayload;

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
 */
export interface Handler {
  onSessionStart(p: SessionStartPayload): Promise<void>;
  onUserPromptSubmit(p: UserPromptSubmitPayload): Promise<void>;
  onPreToolUse(p: PreToolUsePayload): Promise<void>;
  onPostToolUse(p: PostToolUsePayload): Promise<void>;
  /**
   * On Stop, the handler may return a `HookDecision` to inject a follow-up
   * prompt. Return `void` (or undefined) to let cc end the turn normally.
   *
   * Implementations MUST guard `p.stop_hook_active === true` and return
   * `void` in that case to avoid infinite block loops.
   */
  onStop(p: StopPayload): Promise<HookDecision | void>;
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
