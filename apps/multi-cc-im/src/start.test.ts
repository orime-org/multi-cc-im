import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IMAdapter } from '@multi-cc-im/shared';
import {
  defaultResolvePython3,
  resolveIterm2HelperPath,
  runStartCommand,
} from './start.js';
import type { AdapterRegistryEntry } from './adapters.js';
import type { SelectAdapterResult } from './adapter-selector.js';

// ============================================================================
// Test helpers
//
// Most tests don't care about the W5 selector / wizard flow — they exercise
// the daemon-side flow (wezterm probe, double-start guard, IMOrigin reset).
// They pass `selectAdapter: stubSelectAdapter()` to bypass the selector and
// receive a fixed configured adapter whose runtime is a no-op IMAdapter.
//
// Tests that DO target the selector path live in adapter-selector.test.ts.
// ============================================================================

function makeStubIMAdapter(): IMAdapter {
  return {
    name: 'lark-stub',
    start: async () => {},
    send: async () => {},
    stop: async () => {},
  };
}

function makeStubLarkEntry(
  buildAdapterRuntime?: (opts: {
    paths: { credentialFor: (id: string) => string };
    log: (line: string) => void;
  }) => IMAdapter,
): AdapterRegistryEntry {
  return {
    id: 'lark',
    setupSchema: {
      id: 'lark',
      displayName: 'Lark / 飞书',
      fields: [],
    },
    buildPersistShape: (v) => v,
    persist: async () => {},
    buildAdapterRuntime: buildAdapterRuntime ?? (() => makeStubIMAdapter()),
  };
}

function stubSelectAdapter(
  entry: AdapterRegistryEntry = makeStubLarkEntry(),
): () => Promise<SelectAdapterResult> {
  return async () => ({ status: 'configured', adapter: entry });
}

/**
 * Default stub for the P4 terminal-adapter wizard step. Returns
 * `{status: 'configured', id: 'wezterm'}` so the existing daemon-side
 * tests stay on the wezterm path they were written for. Tests
 * specifically exercising the iterm2 branch pass their own override.
 */
function stubSelectTerminal(
  id: 'wezterm' | 'iterm2' = 'wezterm',
  python3?: string,
) {
  return async () => ({ status: 'configured' as const, id, python3 });
}

/**
 * Default stubs for the 2026-05-23 wizard steps 1 (CLI multiselect)
 * and 2 (AI router single-select). `stubSelectCLIs` returns
 * `['cc']` so existing daemon-side tests stay on the cc-only path
 * they were written for; `stubSelectAIRouter` returns the same id.
 * Tests targeting codex / multi-CLI flows pass their own overrides.
 */
function stubSelectCLIs(ids: readonly ('cc' | 'codex')[] = ['cc']) {
  return async () => ({ status: 'configured' as const, ids });
}

function stubSelectAIRouter(id: 'cc' | 'codex' = 'cc') {
  return async () => ({ status: 'configured' as const, id });
}

describe('runStartCommand — pre-flight failures', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'start-cli-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('selector returns error → propagated to start result with exitCode + stderr', async () => {
    // Per W5: selector returns `{ status: 'error', exitCode, message }` for
    // unknown adapter id / missing creds in non-TTY / etc. start.ts surfaces
    // those as the daemon's exit shape so cli.ts can route to stderr.
    const lines: string[] = [];
    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/nonexistent/wezterm',
      selectAdapter: async () => ({
        status: 'error',
        exitCode: 1,
        message: 'multi-cc-im start: lark is not configured',
      }),
      log: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/lark is not configured/);
    expect(lines.some((l) => l.includes('multi-cc-im start'))).toBe(true);
  });

  it('selector returns cancelled → clean exit 0, no shutdown handle', async () => {
    // User backed out of the wizard / adapter menu. Per DD §4: clean exit,
    // no error message — the daemon never started.
    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/nonexistent/wezterm',
      selectAdapter: async () => ({ status: 'cancelled' }),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.shutdown).toBeUndefined();
  });

  it('wezterm not findable → exit 1 with install hint', async () => {
    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => {
        throw new Error('wezterm CLI not found. Install via: brew install --cask wezterm');
      },
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/wezterm.*not found/i);
  });

  it('happy path: returns shutdown handle and starts orchestrator', async () => {
    const startSpy = vi.fn(async () => {});
    const stopSpy = vi.fn(async () => {});
    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: startSpy, stop: stopSpy }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(startSpy).toHaveBeenCalled();
    expect(result.shutdown).toBeDefined();
    await result.shutdown!();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('happy path: emits pre-flight banner + ready line via log sink', async () => {
    const lines: string[] = [];
    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);

    const joined = lines.join('\n');
    expect(joined).toContain(`multi-cc-im start (root: ${root})`);
    expect(joined).toContain(`✓ lark credentials at`);
    expect(joined).toContain(`✓ wezterm at /usr/local/bin/wezterm`);
    expect(joined).toContain(`✓ IMWork: OFF`);
    expect(joined).toContain(`✓ daemon.pid: PID ${process.pid}`);
    expect(joined).toMatch(/✓ orchestrator started.*Ctrl\+C/);
    // Last line tells the user the next action — IMWork starts OFF so the
    // bridge does nothing until `/start` from IM, and the IMWork-OFF mid-
    // setup line is easy to miss when log scrolls past.
    expect(joined).toMatch(
      /⏳ Next: send `\/start` from your IM to enable bridge routing/,
    );
    // And the next-step hint must be AFTER the 'orchestrator started'
    // line so the user reads it last (the order matters for UX).
    const startedIdx = lines.findIndex((l) => l.includes('orchestrator started'));
    const nextIdx = lines.findIndex((l) => l.includes('Next: send'));
    expect(nextIdx).toBeGreaterThan(startedIdx);
    await result.shutdown!();
  });

  it('happy path: writes <stateDir>/daemon.pid with current PID + lstart', async () => {
    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);

    const { readDaemonPidFile, captureProcessLstart } = await import(
      '@multi-cc-im/cli-cc'
    );
    const stateDir = join(root, 'state');
    const pidFile = await readDaemonPidFile(stateDir);
    expect(pidFile?.pid).toBe(process.pid);
    const actualLstart = await captureProcessLstart(process.pid);
    expect(pidFile?.startedAt).toBe(actualLstart);
    await result.shutdown!();
  });

  it('double-start: existing daemon.pid pointing at our own PID + correct lstart → exit 1', async () => {
    await mkdir(join(root, 'state'), { recursive: true });
    const { writeDaemonPidFile, captureProcessLstart } = await import(
      '@multi-cc-im/cli-cc'
    );
    const lstart = await captureProcessLstart(process.pid);
    await writeDaemonPidFile({
      stateDir: join(root, 'state'),
      pid: process.pid,
      startedAt: lstart!,
    });

    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/another daemon already running/i);
    expect(result.stderr).toContain(`PID:    ${process.pid}`);
    expect(result.stderr).toMatch(/pkill -f|kill /);
  });

  it('stale lock: daemon.pid PID dead → ignored, daemon starts normally', async () => {
    await mkdir(join(root, 'state'), { recursive: true });
    const { writeDaemonPidFile } = await import('@multi-cc-im/cli-cc');
    await writeDaemonPidFile({
      stateDir: join(root, 'state'),
      pid: 999_999,
      startedAt: 'fake',
    });

    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);

    const { readDaemonPidFile } = await import('@multi-cc-im/cli-cc');
    const pidFile = await readDaemonPidFile(join(root, 'state'));
    expect(pidFile?.pid).toBe(process.pid);
    await result.shutdown!();
  });

  it('stale lock: daemon.pid PID alive but lstart mismatch (PID-reuse) → ignored, daemon starts normally', async () => {
    await mkdir(join(root, 'state'), { recursive: true });
    const { writeDaemonPidFile } = await import('@multi-cc-im/cli-cc');
    await writeDaemonPidFile({
      stateDir: join(root, 'state'),
      pid: process.pid,
      startedAt: 'WRONG-LSTART-2020-01-01',
    });

    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    await result.shutdown!();
  });

  it('daemon start wipes any leftover state/IMOrigin (crash-path safety per DD: IMOrigin global)', async () => {
    const stateDir = join(root, 'state');
    await mkdir(stateDir, { recursive: true });
    const { writeIMOriginFile, existsIMOriginFile } = await import(
      '@multi-cc-im/cli-cc'
    );
    await writeIMOriginFile(stateDir, {
      imType: 'lark',
      openId: 'ou_owner',
      chatId: 'oc_chat_stale-from-crashed-daemon',
    });
    expect(await existsIMOriginFile(stateDir)).toBe(true);

    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(await existsIMOriginFile(stateDir)).toBe(false);
    await result.shutdown!();
  });
});

// ============================================================================
// Auto-setup-hooks integration
// ============================================================================

describe('runStartCommand — auto setup-hooks', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'start-setup-hooks-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('default behavior: setupHooks is invoked before adapter wiring', async () => {
    const setupSpy = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const startSpy = vi.fn(async () => {});
    const result = await runStartCommand({
      root,
      setupHooks: setupSpy,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: startSpy, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(setupSpy).toHaveBeenCalledOnce();
    expect(startSpy).toHaveBeenCalled();
    await result.shutdown!();
  });

  it('skipSetupHooks=true: setupHooks NOT invoked', async () => {
    const setupSpy = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      setupHooks: setupSpy,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(setupSpy).not.toHaveBeenCalled();
    await result.shutdown!();
  });

  it('codex enabled → setupHooksCodex invoked; cc NOT in enabled → cc setupHooks NOT invoked', async () => {
    const ccSpy = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const codexSpy = vi.fn(async () => ({ changed: true, configPath: '/dev/null' }));
    const result = await runStartCommand({
      root,
      setupHooks: ccSpy,
      setupHooksCodex: codexSpy,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(['codex']),
      selectAIRouter: stubSelectAIRouter('codex'),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(ccSpy).not.toHaveBeenCalled();
    expect(codexSpy).toHaveBeenCalledOnce();
    await result.shutdown!();
  });

  it('codex changed=true → daemon console echoes codex-restart warning', async () => {
    // Setup: codex setup-hooks returns {changed:true} (real write).
    // Expected: start.ts re-logs the restart warning to the main log
    // sink so users see it in console (setup-hooks own log goes to
    // fileOnlyLog by default).
    const lines: string[] = [];
    const result = await runStartCommand({
      root,
      setupHooks: async () => ({ exitCode: 0, stderr: '' }),
      setupHooksCodex: async () => ({
        changed: true,
        configPath: '/dev/null',
      }),
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(['codex']),
      selectAIRouter: stubSelectAIRouter('codex'),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);
    // The warning string is owned by cli-codex; we assert by substring
    // (not equality) so changes to the exact wording in one place do
    // not silently break this assertion.
    expect(lines.some((l) => l.includes('codex 不像 cc 自动热重载'))).toBe(true);
    await result.shutdown!();
  });

  it('codex changed=false (idempotent) → NO restart warning echoed', async () => {
    const lines: string[] = [];
    const result = await runStartCommand({
      root,
      setupHooks: async () => ({ exitCode: 0, stderr: '' }),
      setupHooksCodex: async () => ({
        changed: false,
        configPath: '/dev/null',
      }),
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(['codex']),
      selectAIRouter: stubSelectAIRouter('codex'),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);
    expect(lines.some((l) => l.includes('codex 不像 cc 自动热重载'))).toBe(false);
    await result.shutdown!();
  });

  it('both cc + codex enabled → BOTH setup-hooks invoked', async () => {
    const ccSpy = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const codexSpy = vi.fn(async () => ({ changed: true, configPath: '/dev/null' }));
    const result = await runStartCommand({
      root,
      setupHooks: ccSpy,
      setupHooksCodex: codexSpy,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(['cc', 'codex']),
      selectAIRouter: stubSelectAIRouter('cc'),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(ccSpy).toHaveBeenCalledOnce();
    expect(codexSpy).toHaveBeenCalledOnce();
    await result.shutdown!();
  });

  it('codex setup-hooks throws → start aborts with exit 1', async () => {
    const codexSpy = vi.fn(async () => {
      throw new Error('toml write EACCES');
    });
    const result = await runStartCommand({
      root,
      setupHooksCodex: codexSpy,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(['codex']),
      selectAIRouter: stubSelectAIRouter('codex'),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/codex setup-hooks failed/);
    expect(result.stderr).toContain('toml write EACCES');
  });

  it('cli-selector returns cancelled → exit 0 (user backed out of step 1)', async () => {
    const ccSpy = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const result = await runStartCommand({
      root,
      setupHooks: ccSpy,
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      selectTerminal: stubSelectTerminal(),
      selectCLIs: async () => ({ status: 'cancelled' }),
      selectAIRouter: stubSelectAIRouter(),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(ccSpy).not.toHaveBeenCalled();
  });

  it('ai-router selector returns cancelled → exit 0 (user backed out of step 2)', async () => {
    const ccSpy = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const result = await runStartCommand({
      root,
      setupHooks: ccSpy,
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: async () => ({ status: 'cancelled' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    // setupHooks for cc still ran (step 1 completed before step 2 cancellation)
    expect(ccSpy).toHaveBeenCalledOnce();
  });

  it('setupHooks returns non-zero → start aborts with exit 1 + stderr surfacing', async () => {
    const setupSpy = vi.fn(async () => ({
      exitCode: 1,
      stderr: 'permission denied writing settings.json',
    }));
    const startSpy = vi.fn(async () => {});
    const result = await runStartCommand({
      root,
      setupHooks: setupSpy,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: startSpy, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/setup-hooks failed/);
    expect(result.stderr).toContain('permission denied');
    expect(startSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Default-orchestrator branch: when callers DON'T pass `buildOrchestrator`,
// `runStartCommand` constructs a real orchestrator using
// `selectedEntry.buildAdapterRuntime` for the IM adapter. Tests inject a
// fake adapter entry whose `buildAdapterRuntime` is a spy returning a
// no-op IMAdapter, so we can verify the wiring without dialing
// open.feishu.cn.
// ============================================================================

describe('runStartCommand — default orchestrator branch wires entry.buildAdapterRuntime', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'start-default-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('without buildOrchestrator → real orchestrator constructed; entry.buildAdapterRuntime receives paths + log', async () => {
    const buildAdapterRuntime = vi.fn(
      (opts: {
        paths: { credentialFor: (id: string) => string };
        log: (line: string) => void;
      }) => {
        void opts;
        return makeStubIMAdapter();
      },
    );
    const entry = makeStubLarkEntry(buildAdapterRuntime);
    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
      selectTerminal: stubSelectTerminal(),
      selectCLIs: stubSelectCLIs(),
      selectAIRouter: stubSelectAIRouter(),
      setupHooksCodex: async () => ({ changed: false, configPath: '/dev/null' }),
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      selectAdapter: stubSelectAdapter(entry),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(buildAdapterRuntime).toHaveBeenCalledOnce();
    const passed = buildAdapterRuntime.mock.calls[0]![0];
    expect(passed.paths).toBeDefined();
    expect(typeof passed.paths.credentialFor).toBe('function');
    expect(typeof passed.log).toBe('function');
    await result.shutdown!();
  });
});

describe('defaultResolvePython3 (P3)', () => {
  it('returns an absolute executable python3 path when one is on the system', async () => {
    // CI runners + macOS dev machines all have python3. Smoke check only —
    // discovery logic is covered by
    // `packages/term-iterm2/src/path-resolver.test.ts`.
    const result = await defaultResolvePython3();
    expect(result).toMatch(/python3$/);
  });

  it('uses the cached path when it is still executable', async () => {
    const realPython = await defaultResolvePython3();
    const result = await defaultResolvePython3(realPython);
    expect(result).toBe(realPython);
  });
});

describe('resolveIterm2HelperPath (P3)', () => {
  it('resolves to a readable iterm2-helper.py via either bundled or dev-tree location', async () => {
    // Under vitest, `import.meta.url` points at
    // `apps/multi-cc-im/src/start.ts`; the dev-tree branch finds
    // `packages/term-iterm2/bin/iterm2-helper.py`. After
    // `pnpm --filter multi-cc-im build`, the bundled branch finds
    // `dist/iterm2-helper.py`. Either way the function must return
    // without throwing.
    const path = await resolveIterm2HelperPath();
    expect(path).toMatch(/iterm2-helper\.py$/);
  });
});
