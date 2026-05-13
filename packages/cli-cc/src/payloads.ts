import { z } from 'zod';

/**
 * zod schemas for cc hook stdin payloads. Source of truth: hook+wezterm DD H1
 * verified (2026-04-27). Mirrors the type-only definitions in
 * `@multi-cc-im/shared/adapter/cli.ts`; concrete runtime validation lives here
 * because cc-hook stdin is **external input** (CLAUDE.md "TypeScript strict,
 * no `any`" rule "validate external input via zod at runtime").
 *
 * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)
 * + [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md),
 * multi-cc-im subscribes to **3 hook events**: `PreToolUse` + `PermissionRequest`
 * + `Stop`. SessionStart / SessionEnd were dropped because:
 *   - daemon doesn't track cc lifecycle separately (wezterm cli list is the
 *     live source of truth for "which panes have cc")
 *   - PaneAlive verification was eliminated (daemon trusts user-side
 *     knowledge from `/start` IM listing)
 *
 * Earlier versions also parsed `UserPromptSubmit` / `PostToolUse` for
 * analytics in `events.jsonl`; those have been dropped because cc's own
 * transcript jsonl already records that data.
 */

const baseHookPayload = {
  session_id: z.string().uuid(),
  transcript_path: z.string().startsWith('/').endsWith('.jsonl'),
  cwd: z.string().min(1).startsWith('/'),
};

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
 * Hook fired when cc decides to render a permission dialog (after all
 * cc-internal gates — deny rules, ask rules, safety check). Per
 * [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md).
 * Carries the dialog's `permission_suggestions` (cc's own "Yes always X"
 * suggestion array as `PermissionUpdate[]`) so daemon can forward verbatim
 * to IM without re-deriving them.
 *
 * `permission_suggestions` shape: each entry is a `PermissionUpdate` object
 * (cc-side type). We parse it loosely (`z.array(z.unknown())`) because the
 * full PermissionUpdate union schema lives in cc's source and isn't
 * stable across cc versions; downstream code treats entries as opaque
 * payloads to round-trip back into `decision.updatedPermissions`.
 */
export const PermissionRequestPayloadSchema = z.object({
  ...baseHookPayload,
  hook_event_name: z.literal('PermissionRequest'),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  permission_suggestions: z.array(z.unknown()).optional(),
});

/**
 * Discriminated union over `hook_event_name`. Use this for the generic stdin
 * → typed payload entry path; downstream branch on `payload.hook_event_name`.
 */
export const HookPayloadSchema = z.discriminatedUnion('hook_event_name', [
  PreToolUsePayloadSchema,
  PermissionRequestPayloadSchema,
  StopPayloadSchema,
]);

export type ParsedHookPayload = z.infer<typeof HookPayloadSchema>;

/**
 * Raw stdin entry point: JSON.parse + zod validate. Throws ZodError /
 * SyntaxError on invalid input (caller decides whether to log + exit non-zero
 * vs. swallow — multi-cc-im hook scripts MUST log to stderr + exit non-zero;
 * `process.stdout` is reserved for protocol output per CLAUDE.md "Key
 * conventions" rule "multi-cc-im hooks must not write non-protocol stdout").
 *
 * Inputs from `SessionStart` / `SessionEnd` events (which multi-cc-im no
 * longer subscribes to) will fail to parse with a discriminator error —
 * caller's `runHookCommand` should treat such failures as "not our hook,
 * silently exit 0" rather than logging an error (the user may have unrelated
 * SessionStart/End hooks running in parallel that share the same binary).
 */
export function parseHookPayload(rawStdin: string): ParsedHookPayload {
  return HookPayloadSchema.parse(JSON.parse(rawStdin));
}
