import { describe, it, expect } from 'vitest';
import { selectTerminal } from './terminal-selector.js';
import type { SelectTerminalDeps } from './terminal-selector.js';
import type { WizardPromptIO } from './wizard/io.js';

/**
 * Per-test deps base — both terminals reported installed by default so
 * the select-prompt detection doesn't interfere with the prompt scripts.
 * Individual tests override fields as needed.
 */
function baseDeps(over: Partial<SelectTerminalDeps>): SelectTerminalDeps {
  return {
    resolvePython3: async () => '/usr/bin/python3',
    exec: async () => ({ stdout: '', stderr: '' }),
    detectWezTermInstalled: async () => true,
    detectIterm2Installed: async () => true,
    ...over,
  };
}

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
    // Signature must match WizardPromptIO.select exactly — Promise<V | symbol>.
    // Returning `as V` alone is rejected by stricter TS resolutions (CI vs
    // local) because the queue holds `string | symbol`, not a narrowed V.
    select: async <V extends string>(): Promise<V | symbol> => {
      if (selectsQ.length === 0) throw new Error('select queue exhausted');
      const v = selectsQ.shift();
      return v as V | symbol;
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
      deps: baseDeps({
        resolvePython3: async () => {
          throw new Error('should not resolve python3 for wezterm');
        },
        exec: async () => {
          throw new Error('should not exec for wezterm');
        },
      }),
    });
    expect(result).toEqual({ status: 'configured', id: 'wezterm' });
  });

  it('iterm2 happy path: install + empirical connect smoke OK', async () => {
    const execCalls: Array<{ cmd: string; args: string[] }> = [];
    const io = makeScripted({
      selects: ['iterm2'],
      confirms: [true], // install confirmed (no more prefs-done confirm)
    });
    const result = await selectTerminal({
      io,
      deps: baseDeps({
        resolvePython3: async () => '/opt/homebrew/bin/python3',
        exec: async (cmd, args) => {
          execCalls.push({ cmd, args });
          return { stdout: '', stderr: '' };
        },
      }),
    });
    expect(result).toEqual({
      status: 'configured',
      id: 'iterm2',
      python3: '/opt/homebrew/bin/python3',
    });
    // First exec: pip install. Second exec: connect smoke (run_until_complete).
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]!.args).toEqual([
      '-m', 'pip', 'install', '--user', '--break-system-packages', 'iterm2',
    ]);
    expect(execCalls[1]!.args[0]).toBe('-c');
    expect(execCalls[1]!.args[1]).toContain('iterm2.run_until_complete');
    expect(execCalls[1]!.args[1]).toContain('async_get_app');
  });

  it('iterm2 user declines install + connect smoke succeeds (pre-installed) → configured', async () => {
    const io = makeScripted({
      selects: ['iterm2'],
      confirms: [false], // skip install
    });
    const result = await selectTerminal({
      io,
      deps: baseDeps({
        resolvePython3: async () => '/opt/homebrew/bin/python3',
        exec: async (_cmd, args) => {
          // Skip-install path only runs the empirical connect smoke.
          expect(args[0]).toBe('-c');
          expect(args[1]).toContain('iterm2.run_until_complete');
          return { stdout: '', stderr: '' };
        },
      }),
    });
    expect(result).toEqual({
      status: 'configured',
      id: 'iterm2',
      python3: '/opt/homebrew/bin/python3',
    });
  });

  it('iterm2 python3 missing → error with install hint', async () => {
    // python3 resolution happens before any confirm, so confirms queue is empty.
    const io = makeScripted({ selects: ['iterm2'] });
    const result = await selectTerminal({
      io,
      deps: baseDeps({
        resolvePython3: async () => {
          throw new Error('python3 not found on PATH');
        },
      }),
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toMatch(/python3 not found/);
    }
  });

  it('iterm2 connect smoke fails (API off) → error with Settings hint', async () => {
    const io = makeScripted({
      selects: ['iterm2'],
      confirms: [true],
    });
    let calls = 0;
    const result = await selectTerminal({
      io,
      deps: baseDeps({
        resolvePython3: async () => '/opt/homebrew/bin/python3',
        exec: async () => {
          calls += 1;
          if (calls === 2) {
            // Mimic iterm2 lib's actual stderr when the API server is off.
            throw new Error('There was a problem connecting to iTerm2.');
          }
          return { stdout: '', stderr: '' };
        },
      }),
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.exitCode).toBe(1);
      // Surface the actionable hint, not a generic "smoke failed".
      expect(result.message).toMatch(/cannot connect to iTerm2 Python API/);
      expect(result.message).toContain('Settings → General → Magic');
      expect(result.message).toContain('Enable Python API');
      // Underlying detail surfaced verbatim so users see the iterm2-lib
      // error too (helps debugging unrelated causes — e.g. cookie path).
      expect(result.message).toContain('There was a problem connecting to iTerm2');
    }
  });

  it('select prompt hints reflect installed status (both installed)', async () => {
    // The hint text only flows through io.select's options; we capture by
    // intercepting the select call. Both terminals reported installed.
    let capturedHints: string[] = [];
    const io: WizardPromptIO = {
      ...makeScripted({}),
      select: async (opts) => {
        capturedHints = opts.options.map((o) => o.hint ?? '');
        return 'wezterm' as never;
      },
    };
    await selectTerminal({
      io,
      deps: baseDeps({
        detectWezTermInstalled: async () => true,
        detectIterm2Installed: async () => true,
      }),
    });
    expect(capturedHints[0]).toContain('✓ installed');
    expect(capturedHints[1]).toContain('✓ installed');
  });

  it('select prompt hints show install commands when terminals are missing', async () => {
    let capturedHints: string[] = [];
    const io: WizardPromptIO = {
      ...makeScripted({}),
      select: async (opts) => {
        capturedHints = opts.options.map((o) => o.hint ?? '');
        return 'wezterm' as never;
      },
    };
    await selectTerminal({
      io,
      deps: baseDeps({
        detectWezTermInstalled: async () => false,
        detectIterm2Installed: async () => false,
      }),
    });
    expect(capturedHints[0]).toContain('brew install --cask wezterm');
    expect(capturedHints[1]).toContain('brew install --cask iterm2');
  });

  it('picking wezterm when not installed → error with brew hint, no further prompts', async () => {
    // The select shows the not-installed warning, but user picks anyway.
    // Wizard must hard-stop instead of proceeding to a flow that will
    // crash at adapter creation (P7 smoke 2026-05-14).
    const io = makeScripted({ selects: ['wezterm'] });
    const result = await selectTerminal({
      io,
      deps: baseDeps({
        detectWezTermInstalled: async () => false,
        detectIterm2Installed: async () => true,
      }),
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/WezTerm is not installed/);
      expect(result.message).toContain('brew install --cask wezterm');
    }
  });

  it('picking iterm2 when not installed → error with brew hint, no prefs prompt', async () => {
    const io = makeScripted({ selects: ['iterm2'] });
    const result = await selectTerminal({
      io,
      deps: baseDeps({
        detectWezTermInstalled: async () => true,
        detectIterm2Installed: async () => false,
        resolvePython3: async () => {
          throw new Error('should not be called when iterm2 missing');
        },
      }),
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/iTerm2 is not installed/);
      expect(result.message).toContain('brew install --cask iterm2');
    }
  });

  it('pip install uses --break-system-packages flag (PEP 668 bypass)', async () => {
    const io = makeScripted({
      selects: ['iterm2'],
      confirms: [true], // install confirmed
    });
    const execCalls: Array<{ cmd: string; args: string[] }> = [];
    await selectTerminal({
      io,
      deps: baseDeps({
        resolvePython3: async () => '/opt/homebrew/bin/python3',
        exec: async (cmd, args) => {
          execCalls.push({ cmd, args });
          return { stdout: '', stderr: '' };
        },
      }),
    });
    // First call is the pip install; verify the flag is present so
    // macOS Homebrew Python ≥ 3.12 (PEP 668 enforced) accepts the
    // install without `externally-managed-environment` rejecting.
    expect(execCalls[0]!.args).toContain('--break-system-packages');
    expect(execCalls[0]!.args).toContain('--user');
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
      deps: baseDeps({
        resolvePython3: async () => {
          throw new Error('should not reach');
        },
        exec: async () => {
          throw new Error('should not reach');
        },
      }),
    });
    expect(result).toEqual({ status: 'cancelled' });
  });
});
