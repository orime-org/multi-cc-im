import { z } from 'zod';

/**
 * zod schemas for Codex CLI hook stdin payloads. Source of truth: codex
 * source `codex-rs/hooks/schema/generated/*.command.input.schema.json`
 * (generated from JsonSchema-derived Rust structs). Schemas verified
 * 2026-05-22 against local checkout
 * `/Users/songxiulei/Desktop/Unit_Agent_Competitive/codex/`.
 *
 * multi-cc-im subscribes to **4 hook events** (mirrors cli-cc's 3 plus
 * SessionStart which codex makes useful via the `source` field that lets
 * the daemon distinguish a fresh startup from resume/clear/compact):
 *
 * | Event | Why |
 * |---|---|
 * | `SessionStart` | Pane registration on `source='startup'`; ignored on resume/clear/compact |
 * | `PreToolUse` | Permission gate forward (mirror cli-cc PreToolUse) |
 * | `PermissionRequest` | Codex-native permission dialog (no cc analog; cc overloads PreToolUse) |
 * | `Stop` | Forward `last_assistant_message` to IM (mirror cli-cc Stop) |
 *
 * `PostToolUse` / `UserPromptSubmit` / `PreCompact` / `PostCompact` /
 * `SubagentStart` / `SubagentStop` are intentionally not subscribed in
 * v0.2.0; codex's own transcript records that data and multi-cc-im has
 * no UX surface for it yet. Open follow-ups when a user need surfaces.
 *
 * Notable codex-vs-cc differences embedded in these schemas:
 * - `session_id` is a plain string (codex ThreadId), not a UUID v4 (cc rule).
 * - `transcript_path` is `string | null` (codex NullableString), not a
 *   required string (cc rule).
 * - PreToolUse + PermissionRequest carry `agent_id` / `agent_type`
 *   (empty strings outside subagent context); cc has no subagent concept.
 * - PreToolUse / PermissionRequest / Stop carry a `turn_id` codex
 *   extension that cc has no equivalent for; multi-cc-im uses it for
 *   per-turn debug log correlation but not for routing decisions.
 * - `permission_mode` is a closed enum (default | acceptEdits | plan |
 *   dontAsk | bypassPermissions) in codex; cc treats it as free string.
 * - `PermissionRequest` does NOT carry `permission_suggestions`
 *   (cc-specific "Yes always X" array — codex has no analog). The IM
 *   forward path renders a simpler allow/deny ask without quick-rules.
 */

const PermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]);

const NullableStringSchema = z.string().nullable();

const baseCodexPayload = {
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  transcript_path: NullableStringSchema,
  model: z.string().min(1),
  permission_mode: PermissionModeSchema,
};

/**
 * `SessionStart` fires on startup / resume / clear / compact. multi-cc-im
 * only acts on `source='startup'` (pane registry registration); other
 * sources are no-ops at the hook level (the daemon's wezterm cli list
 * polling already covers resume/clear lifecycle for cli-cc, and codex
 * inherits the same WEZTERM_PANE env so the same approach works).
 */
export const SessionStartPayloadSchema = z.object({
  ...baseCodexPayload,
  hook_event_name: z.literal('SessionStart'),
  source: z.enum(['startup', 'resume', 'clear', 'compact']),
});

/**
 * `PreToolUse` fires right before codex executes a tool. multi-cc-im
 * uses this as the permission gate (forward to IM when IMWork is on
 * in ask-mode, auto-allow in auto-mode, mirroring the cli-cc gate).
 *
 * Codex extension: `tool_use_id` is **non-empty at this event** (cli-cc
 * sees empty string here — see [[feedback_dont_rely_on_upstream_pre_exec_ids]]).
 * multi-cc-im uses codex's real tool_use_id as the PermissionRequest map
 * key, avoiding the self-generated UUID fallback cli-cc requires.
 */
export const PreToolUsePayloadSchema = z.object({
  ...baseCodexPayload,
  hook_event_name: z.literal('PreToolUse'),
  turn_id: z.string().min(1),
  agent_id: z.string(),
  agent_type: z.string(),
  tool_name: z.string().min(1),
  tool_input: z.unknown(),
  tool_use_id: z.string().min(1),
});

/**
 * `PermissionRequest` fires when codex needs explicit approval for a
 * sensitive action (shell escalation, managed-network access). Distinct
 * from `PreToolUse` — codex separates "intercept tool" (PreToolUse) from
 * "ask for approval" (PermissionRequest). multi-cc-im forwards the ask
 * to IM via a `[Permission]` card with allow/deny buttons.
 */
export const PermissionRequestPayloadSchema = z.object({
  ...baseCodexPayload,
  hook_event_name: z.literal('PermissionRequest'),
  turn_id: z.string().min(1),
  agent_id: z.string(),
  agent_type: z.string(),
  tool_name: z.string().min(1),
  tool_input: z.unknown(),
});

/**
 * `Stop` fires when a codex conversation turn completes. multi-cc-im
 * forwards `last_assistant_message` to the IM `replyCtx` recorded at
 * inbound time, completing the IM ↔ codex round-trip.
 */
export const StopPayloadSchema = z.object({
  ...baseCodexPayload,
  hook_event_name: z.literal('Stop'),
  turn_id: z.string().min(1),
  stop_hook_active: z.boolean(),
  last_assistant_message: NullableStringSchema,
});

/**
 * Discriminated union over `hook_event_name` for the 4 events
 * multi-cc-im consumes. Downstream code branches on
 * `payload.hook_event_name`.
 */
export const HookPayloadSchema = z.discriminatedUnion('hook_event_name', [
  SessionStartPayloadSchema,
  PreToolUsePayloadSchema,
  PermissionRequestPayloadSchema,
  StopPayloadSchema,
]);

export type ParsedHookPayload = z.infer<typeof HookPayloadSchema>;
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;
export type PreToolUsePayload = z.infer<typeof PreToolUsePayloadSchema>;
export type PermissionRequestPayload = z.infer<typeof PermissionRequestPayloadSchema>;
export type StopPayload = z.infer<typeof StopPayloadSchema>;

/**
 * Parse raw stdin JSON into a typed codex hook payload. Throws ZodError
 * on validation failure or SyntaxError on malformed JSON; caller
 * (`hook-receiver` runner) MUST log to stderr + exit non-zero. stdout
 * is reserved for the JSON HookResponse protocol output that codex
 * reads back to decide allow/deny/passthrough — same convention as
 * cli-cc and per multi-cc-im hook protocol contract.
 *
 * Events outside the subscribed 4 (PostToolUse / UserPromptSubmit /
 * PreCompact / PostCompact / SubagentStart / SubagentStop) fail at the
 * discriminator step — caller should treat that as a "not our event,
 * silently exit 0" rather than a parse error log (a user may register
 * unrelated codex hooks for other tools that share the same script
 * path; we don't want our hook to noisy-log on every fire).
 */
export function parseHookPayload(rawStdin: string): ParsedHookPayload {
  return HookPayloadSchema.parse(JSON.parse(rawStdin));
}
