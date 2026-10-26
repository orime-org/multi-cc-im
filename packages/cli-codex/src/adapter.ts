import { createCcCliAdapter, type CreateCcCliAdapterOpts } from '@multi-cc-im/cli-cc';
import type { CLIAdapter } from '@multi-cc-im/shared';
import { createCodexQuestionClient, type CodexQuestionClientOpts } from './question-client.js';

/** Shared hook watcher plus optional native Codex question transport. */
export interface CreateCodexCliAdapterOpts extends CreateCcCliAdapterOpts {
  /** Native session-name discovery and separate nonfatal transport diagnostics. */
  nativeQuestions?: CodexQuestionClientOpts;
}

/**
 * Create one shared hook watcher and a native local question client when enabled.
 * The watcher dispatches pane hook events and native session-name replies.
 * @param opts State watcher and optional native session-name discovery dependencies.
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
