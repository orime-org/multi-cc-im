import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStartCommand } from './start.js';

describe('runStartCommand — pre-flight failures', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'start-cli-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('credentials/wechat.json missing → exit 1 with "login wechat first" hint', async () => {
    const lines: string[] = [];
    const result = await runStartCommand({
      root,
      // No wezterm setup — but credential check fires first per start.ts order.
      resolveWezTerm: async () => '/nonexistent/wezterm',
      log: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/login wechat/i);
    // Banner header logged before credential check failed
    expect(lines.some((l) => l.includes('multi-cc-im start'))).toBe(true);
  });

  it('wezterm not findable → exit 1 with install hint', async () => {
    // Write valid credentials so the credential check passes
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(
      join(root, 'credentials', 'wechat.json'),
      JSON.stringify({ token: 'tok-abc' }),
    );
    await chmod(join(root, 'credentials', 'wechat.json'), 0o600);

    const result = await runStartCommand({
      root,
      resolveWezTerm: async () => {
        throw new Error('wezterm CLI not found. Install via: brew install --cask wezterm');
      },
      log: () => {}, // silence banner
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/wezterm.*not found/i);
  });

  it('happy path: returns shutdown handle and starts orchestrator', async () => {
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(
      join(root, 'credentials', 'wechat.json'),
      JSON.stringify({ token: 'tok-abc' }),
    );
    await chmod(join(root, 'credentials', 'wechat.json'), 0o600);

    // Stub the runtime adapters so we don't actually long-poll iLink / spawn
    // wezterm. Verifies start() wires through without throwing.
    const startSpy = vi.fn(async () => {});
    const stopSpy = vi.fn(async () => {});
    const result = await runStartCommand({
      root,
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: startSpy, stop: stopSpy }),
      log: () => {}, // silence banner in test output
    });
    expect(result.exitCode).toBe(0);
    expect(startSpy).toHaveBeenCalled();
    expect(result.shutdown).toBeDefined();
    await result.shutdown!();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('happy path: emits pre-flight banner + ready line via log sink', async () => {
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(
      join(root, 'credentials', 'wechat.json'),
      JSON.stringify({ token: 'tok-abc' }),
    );
    await chmod(join(root, 'credentials', 'wechat.json'), 0o600);

    const lines: string[] = [];
    const result = await runStartCommand({
      root,
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      log: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);

    const joined = lines.join('\n');
    expect(joined).toContain(`multi-cc-im start (root: ${root})`);
    expect(joined).toContain(`✓ wechat credentials at`);
    expect(joined).toContain(`✓ wezterm at /usr/local/bin/wezterm`);
    // Per DD #61, runStartCommand no longer creates a SessionRegistry — bridge
    // queries `termAdapter.listPanes()` on each IM event. Pre-flight logs the
    // live wezterm pane snapshot directly. Note: when wezterm is unreachable
    // (stub path on test machines without wezterm installed), the snapshot
    // log line is silently skipped via `.catch(() => null)`, so it's not
    // asserted here.
    expect(joined).toContain(`✓ IMWork: OFF`);
    expect(joined).toContain(`✓ daemon.pid: PID ${process.pid}`);
    expect(joined).toMatch(/✓ orchestrator started.*Ctrl\+C/);
    await result.shutdown!();
  });

  it('happy path: writes <stateDir>/daemon.pid with current PID + lstart', async () => {
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(
      join(root, 'credentials', 'wechat.json'),
      JSON.stringify({ token: 'tok-abc' }),
    );
    await chmod(join(root, 'credentials', 'wechat.json'), 0o600);

    const result = await runStartCommand({
      root,
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
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
    // Simulate: a daemon with PID=process.pid (this test process) is "already
    // running". The double-start check sees isDaemonAlive=true → reject.
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(
      join(root, 'credentials', 'wechat.json'),
      JSON.stringify({ token: 'tok-abc' }),
    );
    await chmod(join(root, 'credentials', 'wechat.json'), 0o600);
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
      root,
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      log: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/another daemon already running/i);
    expect(result.stderr).toContain(`PID:    ${process.pid}`);
    expect(result.stderr).toMatch(/pkill -f|kill /);
  });

  it('stale lock: daemon.pid PID dead → ignored, daemon starts normally', async () => {
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(
      join(root, 'credentials', 'wechat.json'),
      JSON.stringify({ token: 'tok-abc' }),
    );
    await chmod(join(root, 'credentials', 'wechat.json'), 0o600);
    await mkdir(join(root, 'state'), { recursive: true });
    const { writeDaemonPidFile } = await import('@multi-cc-im/cli-cc');
    await writeDaemonPidFile({
      stateDir: join(root, 'state'),
      pid: 999_999, // unlikely to exist
      startedAt: 'fake',
    });

    const result = await runStartCommand({
      root,
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);

    // Stale lock was overwritten with our own PID
    const { readDaemonPidFile } = await import('@multi-cc-im/cli-cc');
    const pidFile = await readDaemonPidFile(join(root, 'state'));
    expect(pidFile?.pid).toBe(process.pid);
    await result.shutdown!();
  });

  it('stale lock: daemon.pid PID alive but lstart mismatch (PID-reuse) → ignored, daemon starts normally', async () => {
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(
      join(root, 'credentials', 'wechat.json'),
      JSON.stringify({ token: 'tok-abc' }),
    );
    await chmod(join(root, 'credentials', 'wechat.json'), 0o600);
    await mkdir(join(root, 'state'), { recursive: true });
    const { writeDaemonPidFile } = await import('@multi-cc-im/cli-cc');
    await writeDaemonPidFile({
      stateDir: join(root, 'state'),
      pid: process.pid,
      startedAt: 'WRONG-LSTART-2020-01-01',
    });

    const result = await runStartCommand({
      root,
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    await result.shutdown!();
  });

  it('daemon start wipes any leftover state/IMOrigin (crash-path safety per DD: IMOrigin global)', async () => {
    // Simulate: previous daemon was SIGKILL'd / OOM'd → no graceful stop hook
    // → state/IMOrigin remains on disk with a stale `context_token`.
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(
      join(root, 'credentials', 'wechat.json'),
      JSON.stringify({ token: 'tok-abc' }),
    );
    await chmod(join(root, 'credentials', 'wechat.json'), 0o600);
    const stateDir = join(root, 'state');
    await mkdir(stateDir, { recursive: true });
    const { writeIMOriginFile, existsIMOriginFile } = await import(
      '@multi-cc-im/cli-cc'
    );
    await writeIMOriginFile(stateDir, {
      imType: 'wechat',
      to: 'wxid_owner',
      contextToken: 'stale-from-crashed-daemon',
    });
    expect(await existsIMOriginFile(stateDir)).toBe(true);

    const result = await runStartCommand({
      root,
      resolveWezTerm: async () => '/usr/local/bin/wezterm',
      buildOrchestrator: () => ({ start: async () => {}, stop: async () => {} }),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    // Crash-leftover IMOrigin wiped — fresh daemon won't reply with a token
    // the iLink server already invalidated.
    expect(await existsIMOriginFile(stateDir)).toBe(false);
    await result.shutdown!();
  });
});
