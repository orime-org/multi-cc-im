import type { CwdAbs, PaneId, SessionId, TranscriptPath } from '../types.js';
import type { TerminalId } from './storage.js';

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
 * Hook fired right before cc actually executes a tool (Bash / Edit / Write /
 * Read / WebFetch / etc.). Used by multi-cc-im as the **permission gate**
 * per [DD: permission forward](../../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md):
 * hook subprocess writes `<paneId>_<sid>.PermissionRequest.<id>.json`,
 * daemon forwards to IM, IM user replies `#<tabname> /1` (allow) / `/2`
 * (deny), daemon writes `<paneId>_<sid>.PermissionResponse.<id>.json`,
 * hook subprocess reads it + writes stdout
 * `{permissionDecision:"allow"|"deny"}` + exits.
 *
 * 10s timeout (per `setup-hooks.ts` `timeout: 10`); on timeout cc treats
 * as allow by default per cc PreToolUse hook protocol semantics.
 */
export interface PreToolUsePayload extends BaseHookPayload {
  hook_event_name: 'PreToolUse';
  permission_mode: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

/**
 * Hook fired when cc decides to render a permission dialog (after all
 * cc-internal gates: deny rules, ask rules, safety check incl. the
 * `.claude/* / .git/* / .env*` sensitive-file gate). Per
 * [DD: PermissionRequest hook IM bridge](../../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md):
 * multi-cc-im subscribes to intercept these dialogs so user can answer
 * from IM instead of being trapped at the cc TUI.
 *
 * `permission_suggestions` is cc's own array of `PermissionUpdate`
 * objects representing the dialog's "Yes, and always allow X" suggestion
 * buttons. multi-cc-im forwards these verbatim to IM and round-trips the
 * user's choice back into `decision.updatedPermissions` (DD §2.2).
 * The exact PermissionUpdate shape lives in cc source and isn't stable
 * across cc versions; we treat entries as opaque payloads.
 */
export interface PermissionRequestPayload extends BaseHookPayload {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: readonly unknown[];
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

/** Discriminated union of every cc hook payload multi-cc-im subscribes to. */
export type HookPayload = PreToolUsePayload | PermissionRequestPayload | StopPayload;

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
 * Per [DD: pane-keyed state files](../../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)
 * + [DD: PermissionRequest hook IM bridge](../../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md),
 * multi-cc-im subscribes to **3 hook events**: `PreToolUse`, `PermissionRequest`,
 * and `Stop`. SessionStart / SessionEnd were dropped because daemon now uses
 * `wezterm cli list` as the live source of truth for "which panes have cc"
 * and trusts user-side knowledge from the IM `/start` listing for cc
 * lifecycle.
 *
 * Adapter passes `paneId` (parsed from `<paneId>_<sid>.<event>` filename)
 * into each handler call so bridge orchestrator can route without
 * maintaining its own paneId↔sid map.
 */
export interface Handler {
  /**
   * On PreToolUse: adapter sees fresh `<paneId>_<sid>.PermissionRequest.<id>.json`
   * land in state/. Daemon forwards to IM and writes a matching Response
   * file once the user replies (or the hook subprocess hits its 10s
   * timeout — daemon doesn't drive timeouts).
   */
  onPreToolUse(
    p: PreToolUsePayload & { requestId: string; paneId: PaneId },
  ): Promise<void>;
  /**
   * On PermissionRequest: adapter sees fresh
   * `<paneId>_<sid>.PermissionDialogRequest.<id>.json` land in state/.
   * Daemon's handler decides per IMWork mode whether to silent-allow
   * (auto) or forward to IM (off), then writes a matching
   * `PermissionDialogResponse` file. Optional because not every CLIHandler
   * impl wires it (tests / minimal adapters may skip).
   *
   * Per [DD: PermissionRequest hook IM bridge](../../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md).
   */
  onPermissionDialog?(
    p: PermissionRequestPayload & { requestId: string; paneId: PaneId },
  ): Promise<void>;
  /**
   * On Stop, the handler may return a `HookDecision` to inject a follow-up
   * prompt. Return `void` (or undefined) to let cc end the turn normally.
   *
   * Implementations MUST guard `p.stop_hook_active === true` and return
   * `void` in that case to avoid infinite block loops.
   */
  onStop(
    p: StopPayload & { paneId: PaneId; termId?: TerminalId },
  ): Promise<HookDecision | void>;
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
