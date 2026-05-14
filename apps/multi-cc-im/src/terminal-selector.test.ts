import { describe, it, expect } from 'vitest';
import { selectTerminal } from './terminal-selector.js';
import type { WizardPromptIO } from './wizard/io.js';

/**
 * Scripted I/O surface for deterministic wizard tests — replaces
 * @clack/prompts with an in-memory state machine. Each method's queue
 * is consumed FIFO; unknown calls throw to surface drift.
 */
interface ScriptedIO extends WizardPromptIO {
  messages: string[];
  infos: string[];
  errors: string[];
}

function makeScripted(opts: {
  selects?: ReadonlyArray<string | symbol>;
  confirms?: ReadonlyArray<boolean | symbol>;
}): ScriptedIO {
  const cancelSym = Symbol('cancel');
  const selectsQ = [...(opts.selects ?? [])];
  const confirmsQ = [...(opts.confirms ?? [])];
  const messages: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    intro: () => {},
    outro: () => {},
    info: (m) => infos.push(m),
    error: (m) => errors.push(m),
    message: (m) => messages.push(m),
    text: async () => {
      throw new Error('text prompt not scripted');
    },
    password: async () => {
      throw new Error('password prompt not scripted');
    },
    confirm: async () => {
      if (confirmsQ.length === 0) throw new Error('confirm queue exhausted');
      return confirmsQ.shift()!;
    },
    select: async <V extends string>() => {
      if (selectsQ.length === 0) throw new Error('select queue exhausted');
      return selectsQ.shift() as V;
    },
    isCancel: (v: unknown): v is symbol => v === cancelSym,
    messages,
    infos,
    errors,
  };
}

describe('selectTerminal', () => {
  it('wezterm pick → returns configured without invoking iterm2 setup', async () => {
    const io = makeScripted({ selects: ['wezterm'] });
    const result = await selectTerminal({
      io,
      deps: {
        resolvePython3: async () => {
          throw new Error('should not resolve python3 for wezterm');
        },
        exec: async () => {
          throw new Error('should not exec for wezterm');
        },
      },
    });
    expect(result).toEqual({ status: 'configured', id: 'wezterm' });
  });

  it('iterm2 happy path: pref confirmed + install + smoke import OK', async () => {
    const execCalls: Array<{ cmd: string; args: string[] }> = [];
    const io = makeScripted({
      selects: ['iterm2'],
      confirms: [true, true], // prefs confirmed + install confirmed
    });
    const result = await selectTerminal({
      io,
      deps: {
        resolvePython3: async () => '/opt/homebrew/bin/python3',
        exec: async (cmd, args) => {
          execCalls.push({ cmd, args });
          return { stdout: '', stderr: '' };
        },
      },
    });
    expect(result).toEqual({
      status: 'configured',
      id: 'iterm2',
      python3: '/opt/homebrew/bin/python3',
    });
    // First exec: pip install. Second exec: import smoke.
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]!.args).toEqual([
      '-m', 'pip', 'install', '--user', 'iterm2',
    ]);
    expect(execCalls[1]!.args).toEqual(['-c', 'import iterm2']);
  });

  it('iterm2 user declines pref enable → error with retry hint', async () => {
    const io = makeScripted({ selects: ['iterm2'], confirms: [false] });
    const result = await selectTerminal({
      io,
      deps: {
        resolvePython3: async () => '/opt/homebrew/bin/python3',
        exec: async () => ({ stdout: '', stderr: '' }),
      },
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/enable Python API/);
    }
  });

  it('iterm2 user declines install + import succeeds (pre-installed) → configured', async () => {
    const io = makeScripted({
      selects: ['iterm2'],
      confirms: [true, false], // prefs ok, but skip install
    });
    const result = await selectTerminal({
      io,
      deps: {
        resolvePython3: async () => '/opt/homebrew/bin/python3',
        exec: async (_cmd, args) => {
          // Skip-install path only runs the smoke import.
          expect(args).toEqual(['-c', 'import iterm2']);
          return { stdout: '', stderr: '' };
        },
      },
    });
    expect(result).toEqual({
      status: 'configured',
      id: 'iterm2',
      python3: '/opt/homebrew/bin/python3',
    });
  });

  it('iterm2 python3 missing → error with install hint', async () => {
    const io = makeScripted({ selects: ['iterm2'], confirms: [true] });
    const result = await selectTerminal({
      io,
      deps: {
        resolvePython3: async () => {
          throw new Error('python3 not found on PATH');
        },
        exec: async () => ({ stdout: '', stderr: '' }),
      },
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toMatch(/python3 not found/);
    }
  });

  it('iterm2 import smoke fails (pip install silently broken) → error', async () => {
    const io = makeScripted({
      selects: ['iterm2'],
      confirms: [true, true],
    });
    let calls = 0;
    const result = await selectTerminal({
      io,
      deps: {
        resolvePython3: async () => '/opt/homebrew/bin/python3',
        exec: async () => {
          calls += 1;
          if (calls === 2) {
            throw new Error('ModuleNotFoundError: No module named iterm2');
          }
          return { stdout: '', stderr: '' };
        },
      },
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toMatch(/cannot import.*iterm2/);
    }
  });

  it('cancel at terminal select → cancelled', async () => {
    const cancelSym = Symbol('cancel');
    const io: WizardPromptIO = {
      ...makeScripted({}),
      select: async () => cancelSym,
      isCancel: (v: unknown): v is symbol => v === cancelSym,
    };
    const result = await selectTerminal({
      io,
      deps: {
        resolvePython3: async () => {
          throw new Error('should not reach');
        },
        exec: async () => {
          throw new Error('should not reach');
        },
      },
    });
    expect(result).toEqual({ status: 'cancelled' });
  });
});
