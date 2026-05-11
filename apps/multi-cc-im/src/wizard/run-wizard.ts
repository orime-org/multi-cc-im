import type { AdapterSetupSchema, SetupField } from '@multi-cc-im/shared';
import {
  realClackIO,
  type WizardPromptIO,
  type WizardTextPromptOpts,
  type WizardPasswordPromptOpts,
  type PromptValidationResult,
} from './io.js';
import { maskSecret } from './mask.js';

export interface RunWizardOpts {
  /**
   * The adapter's setup contract (per W2). The wizard renders one
   * prompt per field in declaration order, then runs the adapter-level
   * validate callback if present.
   */
  schema: AdapterSetupSchema;

  /**
   * Optional pre-existing values from a prior `~/.multi-cc-im/credentials/<id>.json`.
   * When set, each prompt offers the existing value as a default — the
   * user presses Enter to keep, types to override. Non-secret fields
   * show the value verbatim; secret fields show an AWS-style mask
   * (`'*' * 16 + last_4`) per [DD §9.D4](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#9d4).
   */
  existing?: Record<string, unknown>;

  /**
   * Override the prompt IO for testing. Default uses `realClackIO`
   * which forwards to `@clack/prompts`. Tests pass a stub that scripts
   * user responses without spawning a real terminal.
   */
  io?: WizardPromptIO;

  /**
   * Optional pre-rendered guide text (markdown→ANSI from `renderGuide`
   * in W6's `guide.ts`). When set, the wizard prints it after the intro
   * and before the first field prompt, so the user sees the per-IM
   * configuration steps before typing credentials.
   *
   * Per [DD §10.1 W6](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
   */
  guide?: string;
}

export type RunWizardResult =
  | { status: 'completed'; values: Record<string, unknown> }
  | { status: 'cancelled' };

/**
 * Run a single-adapter setup wizard end-to-end:
 *
 *   1. Print intro with the adapter's display name.
 *   2. For each field: prompt (text or password depending on `secret`),
 *      with default-display + zod validation in the prompt's validate
 *      callback. Empty submit + existing value = keep existing.
 *   3. After all fields parse, run `schema.validate(values)` if the
 *      adapter declared one. On failure, show the error and ask
 *      "Retry?" — yes restarts the prompt loop, no/cancel exits with
 *      `status: 'cancelled'`.
 *   4. On success, print outro and return `{ status: 'completed', values }`.
 *      The wizard does NOT persist anything; the caller (start.ts) is
 *      responsible for writing to the credential store using the
 *      schema's `id` to choose the file name.
 *
 * Per [DD §10.1 W4](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
 *
 * @returns `{ status: 'completed', values }` when every prompt + the
 *  adapter validation passes, or `{ status: 'cancelled' }` when the
 *  user cancels at any prompt or declines retry after a validate
 *  failure. Never throws.
 */
export async function runWizard(
  opts: RunWizardOpts,
): Promise<RunWizardResult> {
  const io = opts.io ?? realClackIO;
  const existing = opts.existing ?? {};

  io.intro(`Setup ${opts.schema.displayName}`);

  if (opts.guide) io.message(opts.guide);

  while (true) {
    const values: Record<string, unknown> = {};
    let cancelled = false;

    for (const field of opts.schema.fields) {
      const fieldValue = await promptField(field, existing[field.key], io);
      if (io.isCancel(fieldValue)) {
        cancelled = true;
        break;
      }
      values[field.key] = fieldValue;
    }

    if (cancelled) {
      io.outro('Cancelled');
      return { status: 'cancelled' };
    }

    if (opts.schema.validate) {
      try {
        await opts.schema.validate(values);
      } catch (err) {
        io.error(err instanceof Error ? err.message : String(err));
        const retry = await io.confirm({
          message: 'Retry?',
          initialValue: true,
        });
        if (io.isCancel(retry) || retry === false) {
          io.outro('Cancelled');
          return { status: 'cancelled' };
        }
        continue;
      }
    }

    io.outro(`✓ ${opts.schema.displayName} configured`);
    return { status: 'completed', values };
  }
}

async function promptField(
  field: SetupField,
  existingValue: unknown,
  io: WizardPromptIO,
): Promise<string | symbol> {
  const hasExisting =
    existingValue !== undefined && typeof existingValue === 'string';
  const validate = buildFieldValidator(field, hasExisting);

  if (field.secret) {
    return promptSecret(field, hasExisting ? (existingValue as string) : null, validate, io);
  }
  return promptNonSecret(field, hasExisting ? (existingValue as string) : null, validate, io);
}

async function promptNonSecret(
  field: SetupField,
  existing: string | null,
  validate: (value: string | undefined) => PromptValidationResult,
  io: WizardPromptIO,
): Promise<string | symbol> {
  const message = formatPromptMessage(field);
  const opts: WizardTextPromptOpts = {
    message,
    validate,
  };
  if (existing !== null) {
    opts.placeholder = existing;
    opts.defaultValue = existing;
  }
  const raw = await io.text(opts);
  if (io.isCancel(raw)) return raw;
  // Empty input + existing = keep existing (clack already returns
  // defaultValue, but be defensive in case the IO behaves differently).
  if (raw === '' && existing !== null) return existing;
  return raw;
}

async function promptSecret(
  field: SetupField,
  existing: string | null,
  validate: (value: string | undefined) => PromptValidationResult,
  io: WizardPromptIO,
): Promise<string | symbol> {
  const baseMessage = formatPromptMessage(field);
  const message =
    existing !== null
      ? `${baseMessage} [${maskSecret(existing)}; Enter to keep, or type new]`
      : baseMessage;
  const opts: WizardPasswordPromptOpts = { message, validate };
  const raw = await io.password(opts);
  if (io.isCancel(raw)) return raw;
  if (raw === '' && existing !== null) return existing;
  return raw;
}

function formatPromptMessage(field: SetupField): string {
  return field.hint ? `${field.label} — ${field.hint}` : field.label;
}

function buildFieldValidator(
  field: SetupField,
  hasExisting: boolean,
): (value: string | undefined) => PromptValidationResult {
  return (value) => {
    // Empty submit + existing value = caller substitutes existing, skip
    // zod (the existing value already satisfied zod when first written).
    if ((value === undefined || value === '') && hasExisting) return undefined;
    if (value === undefined || value === '') return 'required';
    const parsed = field.schema.safeParse(value);
    if (parsed.success) return undefined;
    const issue = parsed.error.errors[0];
    return issue?.message ?? 'invalid value';
  };
}
