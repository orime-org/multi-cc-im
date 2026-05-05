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
    const result = await runStartCommand({
      root,
      // No wezterm setup — but credential check fires first per start.ts order.
      resolveWezTerm: async () => '/nonexistent/wezterm',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/login wechat/i);
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
    });
    expect(result.exitCode).toBe(0);
    expect(startSpy).toHaveBeenCalled();
    expect(result.shutdown).toBeDefined();
    await result.shutdown!();
    expect(stopSpy).toHaveBeenCalled();
  });
});
