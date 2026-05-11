import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IMAdapter } from '@multi-cc-im/shared';
import { runStartCommand } from './start.js';
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
    await result.shutdown!();
  });

  it('happy path: writes <stateDir>/daemon.pid with current PID + lstart', async () => {
    const result = await runStartCommand({
      skipSetupHooks: true,
      root,
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
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      selectAdapter: stubSelectAdapter(),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(setupSpy).not.toHaveBeenCalled();
    await result.shutdown!();
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
