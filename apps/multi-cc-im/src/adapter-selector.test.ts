import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AdapterSetupSchema } from '@multi-cc-im/shared';
import {
  selectAndConfigureAdapter,
  type SelectAdapterDeps,
} from './adapter-selector.js';
import type { AdapterRegistryEntry } from './adapters.js';
import type {
  WizardPromptIO,
  WizardSelectPromptOpts,
  WizardTextPromptOpts,
  WizardPasswordPromptOpts,
  WizardConfirmPromptOpts,
} from './wizard/io.js';
import type { RunWizardOpts, RunWizardResult } from './wizard/run-wizard.js';

const CANCEL = Symbol('clack.cancel');

interface ScriptedSelect {
  method: 'select';
  /** Asserted against the actual options' `value` array. */
  expectedValues: readonly string[];
  /** Returned to the caller as the user's pick. */
  pick: string | symbol;
}
interface ScriptedConfirm {
  method: 'confirm';
  pick: boolean | symbol;
}
type ScriptedResponse = ScriptedSelect | ScriptedConfirm;

interface SelectorIOCalls {
  errors: string[];
  infos: string[];
  intros: string[];
  outros: string[];
  selectCalls: WizardSelectPromptOpts[];
  confirmCalls: WizardConfirmPromptOpts[];
}

function makeIO(scripted: ScriptedResponse[]): {
  io: WizardPromptIO;
  calls: SelectorIOCalls;
} {
  const calls: SelectorIOCalls = {
    errors: [],
    infos: [],
    intros: [],
    outros: [],
    selectCalls: [],
    confirmCalls: [],
  };
  const remaining = [...scripted];
  return {
    calls,
    io: {
      intro: (m) => {
        calls.intros.push(m);
      },
      outro: (m) => {
        calls.outros.push(m);
      },
      info: (m) => {
        calls.infos.push(m);
      },
      error: (m) => {
        calls.errors.push(m);
      },
      message: vi.fn(),
      text: vi.fn() as unknown as WizardPromptIO['text'],
      password: vi.fn() as unknown as WizardPromptIO['password'],
      confirm: async (opts: WizardConfirmPromptOpts) => {
        calls.confirmCalls.push(opts);
        const next = remaining.shift();
        if (!next || next.method !== 'confirm') {
          throw new Error(
            `IO scripted mismatch: confirm called but next is ${next?.method ?? 'undefined'}`,
          );
        }
        return next.pick;
      },
      select: (async <V extends string>(opts: WizardSelectPromptOpts<V>) => {
        calls.selectCalls.push(opts as unknown as WizardSelectPromptOpts);
        const next = remaining.shift();
        if (!next || next.method !== 'select') {
          throw new Error(
            `IO scripted mismatch: select called but next is ${next?.method ?? 'undefined'}`,
          );
        }
        const actualValues = opts.options.map((o) => o.value);
        expect(actualValues).toEqual(next.expectedValues);
        return next.pick as V | symbol;
      }) as WizardPromptIO['select'],
      multiselect: async () => {
        throw new Error(
          'adapter-selector tests do not exercise multiselect; cli-selector tests do',
        );
      },
      isCancel: (v): v is symbol => v === CANCEL,
    },
  };
}

const fakeLarkSchema: AdapterSetupSchema = {
  id: 'lark',
  displayName: 'Lark / 飞书',
  fields: [
    { key: 'appId', label: 'App ID', secret: false, schema: z.string() },
    { key: 'appSecret', label: 'App Secret', secret: true, schema: z.string() },
  ],
};
const fakeTgSchema: AdapterSetupSchema = {
  id: 'tg',
  displayName: 'Telegram',
  fields: [
    { key: 'botToken', label: 'Bot Token', secret: true, schema: z.string() },
  ],
};

function fakeEntry(id: string, schema: AdapterSetupSchema): AdapterRegistryEntry {
  return {
    id,
    setupSchema: schema,
    buildPersistShape: (values) => ({ ...values, savedAt: 'fixed-ts' }),
    persist: async () => {
      throw new Error('persist not called in selector tests (deps stubs persistCredentials)');
    },
    buildAdapterRuntime: () => {
      throw new Error('runtime adapter not built in selector tests');
    },
  };
}

const larkEntry = fakeEntry('lark', fakeLarkSchema);
const tgEntry = fakeEntry('tg', fakeTgSchema);
const registry = [larkEntry, tgEntry];

function makeDeps(overrides: Partial<SelectAdapterDeps> = {}): SelectAdapterDeps {
  return {
    isFile: async () => false,
    persistCredentials: vi.fn(async () => {}),
    runWizard: vi.fn(async (_opts: RunWizardOpts): Promise<RunWizardResult> => ({
      status: 'completed',
      values: { appId: 'cli_x', appSecret: 'sec' },
    })),
    isTTY: true,
    ...overrides,
  };
}

describe('selectAndConfigureAdapter (W5 — adapter selection + creds branch)', () => {
  // ============================================================================
  // With argument — direct selection, no menu
  // ============================================================================

  it('with-arg: known id + creds present → returns configured', async () => {
    const isFile = vi.fn(async () => true);
    const { io, calls } = makeIO([]);
    const result = await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry,
      io,
      deps: makeDeps({ isFile }),
    });
    expect(result).toEqual({ status: 'configured', adapter: larkEntry });
    expect(calls.selectCalls).toHaveLength(0);
  });

  it('with-arg: unknown id → status error with available ids listed', async () => {
    const { io } = makeIO([]);
    const result = await selectAndConfigureAdapter({
      adapterArg: 'wechat',
      registry,
      io,
      deps: makeDeps(),
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.message).toContain("'wechat'");
    expect(result.message).toContain('lark');
    expect(result.message).toContain('tg');
  });

  it('with-arg + creds missing + user picks 开始配置 → wizard runs → persist → configured', async () => {
    let isFileCount = 0;
    const isFile = vi.fn(async () => {
      // First call: pre-wizard creds check → false (missing)
      // Second call (if any): not expected in this flow
      isFileCount++;
      return false;
    });
    const persist = vi.fn(async () => {});
    const { io } = makeIO([
      // unconfigured menu: [开始配置, 返回]
      { method: 'select', expectedValues: ['configure', 'back'], pick: 'configure' },
    ]);
    const result = await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry,
      io,
      deps: makeDeps({ isFile, persistCredentials: persist }),
    });
    expect(result).toEqual({ status: 'configured', adapter: larkEntry });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(
      larkEntry,
      { appId: 'cli_x', appSecret: 'sec' },
    );
    expect(isFileCount).toBe(1);
  });

  it('with-arg + creds missing + user picks 返回 → status error (no re-prompt for with-arg path)', async () => {
    const { io } = makeIO([
      { method: 'select', expectedValues: ['configure', 'back'], pick: 'back' },
    ]);
    const result = await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry,
      io,
      deps: makeDeps({ isFile: async () => false }),
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.message).toContain('not configured');
    expect(result.exitCode).toBe(1);
  });

  it('with-arg + creds missing + 开始配置 + wizard cancelled → status cancelled', async () => {
    const { io } = makeIO([
      { method: 'select', expectedValues: ['configure', 'back'], pick: 'configure' },
    ]);
    const persist = vi.fn(async () => {});
    const result = await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry,
      io,
      deps: makeDeps({
        isFile: async () => false,
        runWizard: async () => ({ status: 'cancelled' }),
        persistCredentials: persist,
      }),
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('W6: when entry.guideDocPath is set + file exists, wizard receives a rendered guide', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'selector-guide-'));
    const guidePath = join(dir, 'setup.md');
    writeFileSync(guidePath, '# Setup heading\n\nplain body');

    const entryWithGuide: AdapterRegistryEntry = {
      ...larkEntry,
      guideDocPath: guidePath,
    };
    const runWizardSpy = vi.fn(async (_opts: RunWizardOpts): Promise<RunWizardResult> => ({
      status: 'completed',
      values: { appId: 'cli_x', appSecret: 'sec' },
    }));
    const { io } = makeIO([
      { method: 'select', expectedValues: ['configure', 'back'], pick: 'configure' },
    ]);
    await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry: [entryWithGuide, tgEntry],
      io,
      deps: makeDeps({
        isFile: async () => false,
        runWizard: runWizardSpy,
      }),
    });
    expect(runWizardSpy).toHaveBeenCalledOnce();
    const wizardArgs = runWizardSpy.mock.calls[0]![0];
    expect(wizardArgs.guide).toBeDefined();
    expect(wizardArgs.guide).toContain('Setup heading');
    expect(wizardArgs.guide).toContain('plain body');
    // Heading rendered through bold ANSI (renderGuide default)
    expect(wizardArgs.guide).toContain('\x1b[1m');
  });

  it('W6: when entry.guideDocPath is unset, wizard receives guide=undefined', async () => {
    const runWizardSpy = vi.fn(async (_opts: RunWizardOpts): Promise<RunWizardResult> => ({
      status: 'completed',
      values: { appId: 'cli_x', appSecret: 'sec' },
    }));
    const { io } = makeIO([
      { method: 'select', expectedValues: ['configure', 'back'], pick: 'configure' },
    ]);
    await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry,
      io,
      deps: makeDeps({
        isFile: async () => false,
        runWizard: runWizardSpy,
      }),
    });
    expect(runWizardSpy.mock.calls[0]![0].guide).toBeUndefined();
  });

  it('W6: guide file missing → wizard receives guide=undefined (silent fallback)', async () => {
    const entryWithBadGuide: AdapterRegistryEntry = {
      ...larkEntry,
      guideDocPath: '/nonexistent-W6-fallback-test.md',
    };
    const runWizardSpy = vi.fn(async (_opts: RunWizardOpts): Promise<RunWizardResult> => ({
      status: 'completed',
      values: { appId: 'cli_x', appSecret: 'sec' },
    }));
    const { io } = makeIO([
      { method: 'select', expectedValues: ['configure', 'back'], pick: 'configure' },
    ]);
    await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry: [entryWithBadGuide, tgEntry],
      io,
      deps: makeDeps({
        isFile: async () => false,
        runWizard: runWizardSpy,
      }),
    });
    expect(runWizardSpy.mock.calls[0]![0].guide).toBeUndefined();
  });

  it('with-arg + creds missing + select cancelled (Ctrl-C) → status cancelled', async () => {
    const { io } = makeIO([
      { method: 'select', expectedValues: ['configure', 'back'], pick: CANCEL },
    ]);
    const result = await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry,
      io,
      deps: makeDeps({ isFile: async () => false }),
    });
    expect(result).toEqual({ status: 'cancelled' });
  });

  // ============================================================================
  // No argument — interactive menu
  // ============================================================================

  it('no-arg + multiple adapters all unconfigured → menu shown with no initialValue', async () => {
    const { io, calls } = makeIO([
      { method: 'select', expectedValues: ['lark', 'tg'], pick: 'lark' },
      { method: 'select', expectedValues: ['configure', 'back'], pick: 'configure' },
    ]);
    const result = await selectAndConfigureAdapter({
      adapterArg: undefined,
      registry,
      io,
      deps: makeDeps({ isFile: async () => false }),
    });
    expect(result.status).toBe('configured');
    expect(calls.selectCalls[0]?.initialValue).toBeUndefined();
  });

  it('no-arg + one adapter already configured → menu cursor defaults to that adapter', async () => {
    const isFile = vi.fn(async (path: string) => path.endsWith('lark.json'));
    const { io, calls } = makeIO([
      { method: 'select', expectedValues: ['lark', 'tg'], pick: 'lark' },
    ]);
    const result = await selectAndConfigureAdapter({
      adapterArg: undefined,
      registry,
      io,
      deps: makeDeps({ isFile }),
    });
    expect(result.status).toBe('configured');
    expect(calls.selectCalls[0]?.initialValue).toBe('lark');
  });

  it('no-arg + adapter menu shows ✓ configured hint for already-configured', async () => {
    const isFile = vi.fn(async (path: string) => path.endsWith('lark.json'));
    const { io, calls } = makeIO([
      { method: 'select', expectedValues: ['lark', 'tg'], pick: 'lark' },
    ]);
    await selectAndConfigureAdapter({
      adapterArg: undefined,
      registry,
      io,
      deps: makeDeps({ isFile }),
    });
    const adapterMenu = calls.selectCalls[0]!;
    const larkOption = adapterMenu.options.find((o) => o.value === 'lark')!;
    const tgOption = adapterMenu.options.find((o) => o.value === 'tg')!;
    expect(larkOption.hint).toContain('✓ configured');
    expect(tgOption.hint ?? '').not.toContain('configured');
  });

  it('no-arg + cancel at adapter menu (Ctrl-C) → status cancelled', async () => {
    const { io } = makeIO([
      { method: 'select', expectedValues: ['lark', 'tg'], pick: CANCEL },
    ]);
    const result = await selectAndConfigureAdapter({
      adapterArg: undefined,
      registry,
      io,
      deps: makeDeps(),
    });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('no-arg + creds missing + 返回 → re-shows adapter menu (this time user cancels)', async () => {
    const { io, calls } = makeIO([
      { method: 'select', expectedValues: ['lark', 'tg'], pick: 'lark' },
      { method: 'select', expectedValues: ['configure', 'back'], pick: 'back' },
      { method: 'select', expectedValues: ['lark', 'tg'], pick: CANCEL },
    ]);
    const result = await selectAndConfigureAdapter({
      adapterArg: undefined,
      registry,
      io,
      deps: makeDeps({ isFile: async () => false }),
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(calls.selectCalls).toHaveLength(3);
  });

  it('no-arg + creds present → skips configure menu, returns configured directly', async () => {
    const { io, calls } = makeIO([
      { method: 'select', expectedValues: ['lark', 'tg'], pick: 'lark' },
    ]);
    const result = await selectAndConfigureAdapter({
      adapterArg: undefined,
      registry,
      io,
      deps: makeDeps({ isFile: async (path: string) => path.endsWith('lark.json') }),
    });
    expect(result).toEqual({ status: 'configured', adapter: larkEntry });
    expect(calls.selectCalls).toHaveLength(1);
  });

  // ============================================================================
  // TTY guard
  // ============================================================================

  it('not-TTY + no-arg → status error with hint to pass adapter id', async () => {
    const { io, calls } = makeIO([]);
    const result = await selectAndConfigureAdapter({
      adapterArg: undefined,
      registry,
      io,
      deps: makeDeps({ isTTY: false }),
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.message).toContain('not a TTY');
    expect(result.message).toContain('start lark');
    expect(calls.selectCalls).toHaveLength(0);
  });

  it('not-TTY + with-arg + creds present → returns configured (TTY only required for prompts)', async () => {
    const { io } = makeIO([]);
    const result = await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry,
      io,
      deps: makeDeps({ isTTY: false, isFile: async () => true }),
    });
    expect(result.status).toBe('configured');
  });

  it('not-TTY + with-arg + creds missing → status error (cannot run wizard without TTY)', async () => {
    const { io } = makeIO([]);
    const result = await selectAndConfigureAdapter({
      adapterArg: 'lark',
      registry,
      io,
      deps: makeDeps({ isTTY: false, isFile: async () => false }),
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.message).toContain('not configured');
    expect(result.message).toContain('login lark');
  });
});
