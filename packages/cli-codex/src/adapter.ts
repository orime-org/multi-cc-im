import { createCcCliAdapter, type CreateCcCliAdapterOpts } from '@multi-cc-im/cli-cc';
import type { CLIAdapter } from '@multi-cc-im/shared';
import { createCodexQuestionClient, type CodexQuestionClientOpts } from './question-client.js';

/** Shared hook watcher plus optional native Codex question transport. */
export interface CreateCodexCliAdapterOpts extends CreateCcCliAdapterOpts {
  /** Active terminal identity/liveness and separate nonfatal transport diagnostics. */
  nativeQuestions?: CodexQuestionClientOpts;
}

/**
 * Create one shared hook watcher and a native local question client when enabled.
 * Both Claude and Codex hook files retain the existing state-file protocol.
 * @param opts State watcher and optional title-derived thread discovery dependencies.
 * @returns CLI adapter; native questions never enter permission hook responses.
 */
export function createCodexCliAdapter(opts: CreateCodexCliAdapterOpts): CLIAdapter {
  const base = createCcCliAdapter(opts);
  const questions = opts.nativeQuestions ? createCodexQuestionClient(opts.nativeQuestions) : undefined;
  return {
    ...base,
    name: 'codex',
    questions,
    async start(handler) {
      await base.start(handler);
      await questions?.start(handler);
    },
    async stop() {
      await questions?.stop();
      await base.stop();
    },
  };
}
