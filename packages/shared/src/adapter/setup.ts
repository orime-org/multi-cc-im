import type { z } from 'zod';

/**
 * Per-field metadata that drives the wizard's prompt rendering for a single
 * credential field. Combines a zod schema (validates input format) with UX
 * hints (label, hint text, secret-flag for masking).
 *
 * Per [DD: interactive start wizard §9.D5](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#9d5).
 *
 * @example
 *   const appId: SetupField = {
 *     key: 'appId',
 *     label: 'App ID',
 *     hint: 'From Feishu Open Platform → Credentials & Basic Info',
 *     secret: false,
 *     schema: z.string().min(1).startsWith('cli_'),
 *   };
 */
export interface SetupField<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /**
   * Stable key used both as the prompt's input identifier and as the
   * persisted JSON object key. Must be a valid JS identifier and unique
   * within the same `AdapterSetupSchema.fields` array.
   */
  key: string;

  /**
   * Human-readable label shown next to the prompt. e.g. `App ID`,
   * `App Secret`. Free text; not used as a JSON key.
   */
  label: string;

  /**
   * Optional one-line guidance shown beneath the label. Use to point users
   * to where the value is found (e.g. "From Feishu Open Platform →
   * Credentials & Basic Info").
   */
  hint?: string;

  /**
   * When true, the wizard masks the value at input (no echo on type) and
   * uses AWS-style `'*'*16 + last_4` as the default-display when the user
   * is editing a previously-saved credential. When false, the value is
   * shown in full when editing — non-secret IDs (App ID, chat ID) want
   * this so the user can recognize which entry they're touching.
   *
   * Per [DD §9.D4](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#9d4).
   */
  secret: boolean;

  /**
   * Zod schema that validates the field's value. The wizard runs
   * `.parse()` (or `.safeParse()`) against the user's input; on failure
   * it re-prompts with the zod error. Schemas can use `.refine()` for
   * format-level checks (e.g. App ID must start with `cli_`); heavier
   * cross-field / live-API validation belongs in
   * `AdapterSetupSchema.validate`.
   */
  schema: S;
}

/**
 * Whole-form setup contract for one IM adapter. Bundles the ordered field
 * list with adapter identity, display name, and an optional adapter-level
 * validation callback that runs after every per-field zod parse passes.
 *
 * Per [DD §9.D5 hybrid pattern](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#9d5):
 * 90% of adapter setup is "ask field, mask if secret, persist" — covered
 * by `fields`. The 10% adapter-specific verification (e.g. Lark calls
 * `tenantAccessToken.internal`, TG calls `getMe`) lives in `validate`.
 *
 * Adapter packages export an instance of this type; the generic wizard
 * (W4) consumes it without knowing what IM it's setting up.
 */
export interface AdapterSetupSchema {
  /**
   * Adapter identifier — alphanumeric, lowercase, used both as the
   * persisted file name `~/.multi-cc-im/credentials/<id>.json` and as
   * the `multi-cc-im start <id>` argument.
   */
  id: string;

  /**
   * Display name for the wizard's adapter-selection menu.
   * e.g. `Lark / 飞书`, `Telegram`.
   */
  displayName: string;

  /**
   * Ordered field list. The wizard renders prompts in this order; later
   * fields can refer to earlier values via the `validate` callback if
   * cross-field invariants matter, but each individual prompt only sees
   * its own value.
   */
  fields: readonly SetupField[];

  /**
   * Optional whole-form validation hook. Runs once after every field's
   * zod parse succeeds. Throw or reject with a user-facing message on
   * failure; the wizard catches and surfaces the message back to the
   * prompt loop, letting the user retry without losing already-entered
   * values.
   *
   * Use for live-API checks (e.g. Feishu `tenantAccessToken.internal`)
   * that require the credential to actually authenticate against the
   * provider — pure-format checks belong in field-level zod schemas.
   *
   * @param values  Parsed values keyed by `SetupField.key`. Typed as
   *                `Record<string, unknown>` because the schema is
   *                heterogeneous; adapters narrow with their own types.
   * @throws        Any error; the wizard surfaces `error.message`.
   */
  validate?: (values: Record<string, unknown>) => Promise<void>;
}
