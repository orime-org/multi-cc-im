import { z } from 'zod';

/**
 * zod schemas for cc hook stdin payloads. Source of truth: hook+wezterm DD H1
 * verified (2026-04-27). Mirrors the type-only definitions in
 * `@multi-cc-im/shared/adapter/cli.ts`; concrete runtime validation lives here
 * because cc-hook stdin is **external input** (CLAUDE.md "TypeScript strict,
 * no `any`" rule "validate external input via zod at runtime").
 *
 * Note: the runtime schemas validate the **same constraints** as shared's
 * branded schemas (UUID for `session_id`, absolute path for `cwd` / ending in
 * `.jsonl` for `transcript_path`) but **don't apply the `Brand<>` transform**.
 * Branded types live at the type level only — re-emitting branded types
 * across packages collides with `unique symbol` declaration-emit
 * constraints, so packages downstream of cli-cc cast at the boundary if they
 * need branded values.
 *
 * multi-cc-im subscribes to only 3 hook events: `SessionStart`, `Stop`,
 * `SessionEnd`. Earlier versions also parsed `UserPromptSubmit` /
 * `PreToolUse` / `PostToolUse` for analytics in `events.jsonl`; those have
 * been dropped because cc's own transcript jsonl already records that data.
 */

const baseHookPayload = {
  session_id: z.string().uuid(),
  transcript_path: z.string().startsWith('/').endsWith('.jsonl'),
  cwd: z.string().min(1).startsWith('/'),
};

export const SessionStartPayloadSchema = z.object({
  ...baseHookPayload,
  hook_event_name: z.literal('SessionStart'),
  source: z.string(),
  model: z.string(),
});

/**
 * Hook fired right before cc executes a tool. Used by multi-cc-im as the
 * permission gate per [DD: permission forward](../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md).
 */
export const PreToolUsePayloadSchema = z.object({
  ...baseHookPayload,
  hook_event_name: z.literal('PreToolUse'),
  permission_mode: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string(),
});

export const StopPayloadSchema = z.object({
  ...baseHookPayload,
  hook_event_name: z.literal('Stop'),
  permission_mode: z.string(),
  stop_hook_active: z.boolean(),
  last_assistant_message: z.string(),
});

/**
 * Hook fired when cc session ends (graceful `/exit`, `/clear`, or other reasons
 * documented at https://docs.anthropic.com/en/docs/claude-code/hooks#sessionend).
 * Required by [pane-alive strategy DD](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md):
 * receiver flips term-wezterm PaneAlive to dead immediately on graceful exit
 * (vs. polling for PID death).
 */
export const SessionEndPayloadSchema = z.object({
  ...baseHookPayload,
  hook_event_name: z.literal('SessionEnd'),
  /**
   * Termination reason — open enum per Anthropic docs (`/exit` / `/clear` /
   * `logout` / `prompt_input_exit` / `other`). Stored verbatim.
   */
  reason: z.string(),
});

/**
 * Discriminated union over `hook_event_name`. Use this for the generic stdin
 * → typed payload entry path; downstream branch on `payload.hook_event_name`.
 */
export const HookPayloadSchema = z.discriminatedUnion('hook_event_name', [
  SessionStartPayloadSchema,
  PreToolUsePayloadSchema,
  StopPayloadSchema,
  SessionEndPayloadSchema,
]);

export type ParsedHookPayload = z.infer<typeof HookPayloadSchema>;

/**
 * Raw stdin entry point: JSON.parse + zod validate. Throws ZodError /
 * SyntaxError on invalid input (caller decides whether to log + exit non-zero
 * vs. swallow — multi-cc-im hook scripts MUST log to stderr + exit non-zero;
 * `process.stdout` is reserved for protocol output per CLAUDE.md "Key
 * conventions" rule "multi-cc-im hooks must not write non-protocol stdout").
 */
export function parseHookPayload(rawStdin: string): ParsedHookPayload {
  return HookPayloadSchema.parse(JSON.parse(rawStdin));
}
