import { describe, it, expect } from 'vitest';
import type { CLIId } from '@multi-cc-im/shared';
import { selectAIRouter } from './ai-router-selector.js';
import type {
  WizardPromptIO,
  WizardSelectPromptOpts,
} from './wizard/io.js';

const CANCEL = Symbol('cancel');

function makeIO(opts: {
  pick?: CLIId | symbol;
  capture?: { last?: WizardSelectPromptOpts<CLIId> };
}): WizardPromptIO {
  return {
    intro: () => {},
    outro: () => {},
    info: () => {},
    error: () => {},
    message: () => {},
    text: async () => {
      throw new Error('ai-router-selector should not call text');
    },
    password: async () => {
      throw new Error('ai-router-selector should not call password');
    },
    confirm: async () => {
      throw new Error('ai-router-selector should not call confirm');
    },
    select: async <V extends string>(
      sopts: WizardSelectPromptOpts<V>,
    ): Promise<V | symbol> => {
      if (opts.capture) {
        opts.capture.last = sopts as unknown as WizardSelectPromptOpts<CLIId>;
      }
      return (opts.pick ?? 'cc') as V | symbol;
    },
    multiselect: async () => {
      throw new Error('ai-router-selector should not call multiselect');
    },
    isCancel: (v): v is symbol => v === CANCEL,
  };
}

describe('selectAIRouter', () => {
  it('returns configured with the user-picked id', async () => {
    const result = await selectAIRouter({
      io: makeIO({ pick: 'cc' }),
      enabledCLIs: ['cc', 'codex'],
    });
    expect(result).toEqual({ status: 'configured', id: 'cc' });
  });

  it('asks the user even when only one CLI is enabled (no auto-skip)', async () => {
    const capture: { last?: WizardSelectPromptOpts<CLIId> } = {};
    const result = await selectAIRouter({
      io: makeIO({ pick: 'codex', capture }),
      enabledCLIs: ['codex'],
    });
    // The IO's select() was actually invoked (capture.last set).
    expect(capture.last).toBeDefined();
    expect(capture.last?.options.map((o) => o.value)).toEqual(['codex']);
    expect(result).toEqual({ status: 'configured', id: 'codex' });
  });

  it('returns cancelled on Ctrl-C', async () => {
    const result = await selectAIRouter({
      io: makeIO({ pick: CANCEL }),
      enabledCLIs: ['cc', 'codex'],
    });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('errors out when enabledCLIs is empty (callers should never pass this)', async () => {
    const result = await selectAIRouter({
      io: makeIO({ pick: 'cc' }),
      enabledCLIs: [],
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('empty enabledCLIs');
    }
  });

  it('pre-selects persisted aiRouter if still in enabledCLIs', async () => {
    const capture: { last?: WizardSelectPromptOpts<CLIId> } = {};
    await selectAIRouter({
      io: makeIO({ pick: 'codex', capture }),
      enabledCLIs: ['cc', 'codex'],
      currentAIRouter: 'codex',
    });
    expect(capture.last?.initialValue).toBe('codex');
  });

  it('falls back to first enabled CLI when persisted aiRouter no longer enabled', async () => {
    const capture: { last?: WizardSelectPromptOpts<CLIId> } = {};
    await selectAIRouter({
      io: makeIO({ pick: 'cc', capture }),
      enabledCLIs: ['cc'],
      // user previously had codex as router but unchecked it in step 1
      currentAIRouter: 'codex',
    });
    expect(capture.last?.initialValue).toBe('cc');
  });

  it('options only include CLIs from enabledCLIs', async () => {
    const capture: { last?: WizardSelectPromptOpts<CLIId> } = {};
    await selectAIRouter({
      io: makeIO({ pick: 'cc', capture }),
      enabledCLIs: ['cc'],
    });
    expect(capture.last?.options.map((o) => o.value)).toEqual(['cc']);
  });

  it('options carry human-readable label + flag-set hint', async () => {
    const capture: { last?: WizardSelectPromptOpts<CLIId> } = {};
    await selectAIRouter({
      io: makeIO({ pick: 'cc', capture }),
      enabledCLIs: ['cc', 'codex'],
    });
    const ccOpt = capture.last?.options.find((o) => o.value === 'cc');
    const codexOpt = capture.last?.options.find((o) => o.value === 'codex');
    expect(ccOpt?.label).toContain('Claude Code');
    expect(codexOpt?.label).toContain('Codex');
    expect(ccOpt?.hint).toContain('disableAllHooks');
    expect(codexOpt?.hint).toContain('--ephemeral');
  });
});
