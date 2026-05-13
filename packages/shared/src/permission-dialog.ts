import { z } from 'zod';

/**
 * Schemas for cc's `PermissionRequest` hook event — daemon forwards
 * sensitive-path dialogs to IM and parses user reply via AI router.
 *
 * Per [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md).
 *
 * Two schemas live here:
 *
 * 1. `PermissionDialogAnswerSchema` — the structured shape the AI router
 *    produces when triaging an IM reply. The daemon then resolves
 *    `appliedSuggestionIndex` (if set) into `permission_suggestions[i]`
 *    from the pending Request file and writes it back to cc as
 *    `decision.updatedPermissions`. The `permission_suggestions` payload
 *    is opaque (`unknown`) on both ends — we round-trip cc's own
 *    PermissionUpdate objects without re-deriving them.
 *
 * 2. `PermissionDialogAIOutputSchema` — AI envelope: target tab +
 *    short reason trace + the answer shape above.
 *
 * Why these are NOT in `state-files.ts`:
 * `state-files.ts` (in cli-cc) owns the on-disk IPC schema
 * (`PermissionDialogResponseFileSchema`) — cc-protocol-mirroring shape.
 * The AI router has a different schema with `appliedSuggestionIndex`
 * (1-based reference into `permission_suggestions` so the AI doesn't
 * have to re-emit opaque cc PermissionUpdate objects). Daemon resolves
 * the index into the actual cc payload before writing the file.
 */

const PermissionDialogAllowSchema = z.object({
  behavior: z.literal('allow'),
  /**
   * 1-based index into the pending Request's `permission_suggestions`
   * array. When set, daemon copies `permission_suggestions[index-1]`
   * into the on-disk Response's `decision.updatedPermissions: [...]`
   * so cc applies the session-level allow rule.
   *
   * Unset (undefined) = single-yes (this call only, no session rule).
   * Per DD §3 D6: AI MUST NOT synthesize an always-allow suggestion
   * that wasn't in `permission_suggestions` — index points into the
   * existing array only.
   */
  appliedSuggestionIndex: z.number().int().min(1).optional(),
});

const PermissionDialogDenySchema = z.object({
  behavior: z.literal('deny'),
  /**
   * Short human-readable explanation written into the cc Response's
   * `decision.message` field. cc shows this string to the model so
   * the model knows why the tool was denied. Defaults to a generic
   * "User denied via IM" string if AI doesn't set one.
   */
  message: z.string().optional(),
});

export const PermissionDialogAnswerSchema = z.discriminatedUnion('behavior', [
  PermissionDialogAllowSchema,
  PermissionDialogDenySchema,
]);

export type PermissionDialogAnswer = z.infer<
  typeof PermissionDialogAnswerSchema
>;

/**
 * AI envelope output for PermissionRequest-mode triage call.
 */
export const PermissionDialogAIOutputSchema = z.object({
  target: z.string().min(1),
  reason: z.string().nullable().optional(),
  answer: PermissionDialogAnswerSchema,
});

export type PermissionDialogAIOutput = z.infer<
  typeof PermissionDialogAIOutputSchema
>;
