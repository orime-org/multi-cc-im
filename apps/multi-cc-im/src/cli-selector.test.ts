import { describe, it, expect } from 'vitest';
import type { CLIId } from '@multi-cc-im/shared';
import { selectCLIs } from './cli-selector.js';
import type {
  WizardPromptIO,
  WizardMultiselectPromptOpts,
} from './wizard/io.js';

const CANCEL = Symbol('cancel');

function makeIO(opts: {
  pick?: readonly CLIId[] | symbol;
  capture?: { last?: WizardMultiselectPromptOpts<CLIId> };
}): WizardPromptIO {
  return {
    intro: () => {},
    outro: () => {},
    info: () => {},
    error: () => {},
    message: () => {},
    text: async () => {
      throw new Error('cli-selector should not call text');
    },
    password: async () => {
      throw new Error('cli-selector should not call password');
    },
    confirm: async () => {
      throw new Error('cli-selector should not call confirm');
    },
    select: async () => {
      throw new Error('cli-selector should not call select');
    },
    multiselect: async <V extends string>(
      mopts: WizardMultiselectPromptOpts<V>,
    ): Promise<readonly V[] | symbol> => {
      if (opts.capture) {
        opts.capture.last = mopts as unknown as WizardMultiselectPromptOpts<CLIId>;
      }
      return (opts.pick ?? ['cc']) as readonly V[] | symbol;
    },
    isCancel: (v): v is symbol => v === CANCEL,
  };
}

function makeDeps(installed: Record<string, boolean>) {
  return {
    detectInstalled: async (bin: string): Promise<boolean> =>
      installed[bin] ?? false,
  };
}

describe('selectCLIs', () => {
  it('returns configured with the user-picked ids', async () => {
    const result = await selectCLIs({
      io: makeIO({ pick: ['cc'] }),
      deps: makeDeps({ claude: true, codex: true }),
    });
    expect(result).toEqual({ status: 'configured', ids: ['cc'] });
  });

  it('returns configured with both ids when user picks both', async () => {
    const result = await selectCLIs({
      io: makeIO({ pick: ['cc', 'codex'] }),
      deps: makeDeps({ claude: true, codex: true }),
    });
    expect(result.status).toBe('configured');
    if (result.status === 'configured') {
      expect(result.ids).toEqual(['cc', 'codex']);
    }
  });

  it('errors when NO supported CLI is installed', async () => {
    const result = await selectCLIs({
      io: makeIO({ pick: ['cc'] }),
      deps: makeDeps({ claude: false, codex: false }),
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('no supported CLI installed');
      expect(result.message).toContain('Claude Code');
      expect(result.message).toContain('OpenAI Codex');
    }
  });

  it('returns cancelled on Ctrl-C', async () => {
    const result = await selectCLIs({
      io: makeIO({ pick: CANCEL }),
      deps: makeDeps({ claude: true, codex: true }),
    });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('rejects picks for CLIs that are not installed', async () => {
    const result = await selectCLIs({
      io: makeIO({ pick: ['cc', 'codex'] }),
      deps: makeDeps({ claude: true, codex: false }),
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('not installed');
      expect(result.message).toContain('OpenAI Codex');
    }
  });

  it('pre-checks persisted entries that are still installed', async () => {
    const capture: { last?: WizardMultiselectPromptOpts<CLIId> } = {};
    await selectCLIs({
      io: makeIO({ pick: ['codex'], capture }),
      deps: makeDeps({ claude: false, codex: true }),
      currentEnabled: ['codex'],
    });
    expect(capture.last?.initialValues).toEqual(['codex']);
  });

  it('drops persisted entries that are no longer installed', async () => {
    const capture: { last?: WizardMultiselectPromptOpts<CLIId> } = {};
    await selectCLIs({
      io: makeIO({ pick: ['cc'], capture }),
      // codex was previously enabled but is now uninstalled
      deps: makeDeps({ claude: true, codex: false }),
      currentEnabled: ['codex'],
    });
    // Persisted ['codex'] is dropped (not installed); fallback pre-checks
    // first installed candidate (cc).
    expect(capture.last?.initialValues).toEqual(['cc']);
  });

  it('falls back to first installed candidate when no persisted state', async () => {
    const capture: { last?: WizardMultiselectPromptOpts<CLIId> } = {};
    await selectCLIs({
      io: makeIO({ pick: ['cc'], capture }),
      deps: makeDeps({ claude: true, codex: true }),
    });
    // No currentEnabled → fallback to first installed (cc per CLI_REGISTRY order)
    expect(capture.last?.initialValues).toEqual(['cc']);
  });

  it('option hints reflect installed status', async () => {
    const capture: { last?: WizardMultiselectPromptOpts<CLIId> } = {};
    await selectCLIs({
      io: makeIO({ pick: ['cc'], capture }),
      deps: makeDeps({ claude: true, codex: false }),
    });
    const opts = capture.last?.options;
    expect(opts?.[0]?.hint).toContain('✓ installed');
    expect(opts?.[1]?.hint).toContain('not installed');
    expect(opts?.[1]?.hint).toContain('https://');
  });

  it('multiselect required=true (clack will block submit on empty)', async () => {
    const capture: { last?: WizardMultiselectPromptOpts<CLIId> } = {};
    await selectCLIs({
      io: makeIO({ pick: ['cc'], capture }),
      deps: makeDeps({ claude: true, codex: true }),
    });
    expect(capture.last?.required).toBe(true);
  });
});
