import * as clack from '@clack/prompts';

/**
 * Validation result for prompt-level zod / format checks. `undefined`
 * means valid; `string` is the error message rendered next to the prompt;
 * `Error` is the same but as an object (clack supports both).
 */
export type PromptValidationResult = string | Error | undefined;

export interface WizardTextPromptOpts {
  message: string;
  /** Grayed-out hint shown until the user types. */
  placeholder?: string;
  /** Returned if the user presses Enter without typing. */
  defaultValue?: string;
  validate?: (value: string | undefined) => PromptValidationResult;
}

export interface WizardPasswordPromptOpts {
  message: string;
  validate?: (value: string | undefined) => PromptValidationResult;
}

export interface WizardConfirmPromptOpts {
  message: string;
  initialValue?: boolean;
}

/**
 * Thin abstraction over `@clack/prompts` so the wizard logic can be
 * unit-tested with a stub that scripts user responses without spawning a
 * real terminal. Production wires `realClackIO`; tests inject their own
 * `WizardPromptIO`.
 *
 * Per [DD §9.D2](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#9d2)
 * — clack's sentinel-symbol cancel semantics are preserved verbatim;
 * `isCancel` is the user-facing cancel check.
 */
export interface WizardPromptIO {
  intro: (msg: string) => void;
  outro: (msg: string) => void;
  info: (msg: string) => void;
  error: (msg: string) => void;
  text: (opts: WizardTextPromptOpts) => Promise<string | symbol>;
  password: (opts: WizardPasswordPromptOpts) => Promise<string | symbol>;
  confirm: (opts: WizardConfirmPromptOpts) => Promise<boolean | symbol>;
  /**
   * Test against the sentinel symbol returned by `text` / `password` /
   * `confirm` when the user hits Ctrl-C. Wraps `@clack/core`'s `isCancel`.
   */
  isCancel: (value: unknown) => value is symbol;
}

/**
 * Production `WizardPromptIO` backed by the real `@clack/prompts`
 * package. Direct passthrough — no formatting / wrapping; clack owns
 * the visual style.
 */
export const realClackIO: WizardPromptIO = {
  intro: (msg) => clack.intro(msg),
  outro: (msg) => clack.outro(msg),
  info: (msg) => clack.log.info(msg),
  error: (msg) => clack.log.error(msg),
  text: (opts) => clack.text(opts),
  password: (opts) => clack.password(opts),
  confirm: (opts) => clack.confirm(opts),
  isCancel: clack.isCancel,
};
