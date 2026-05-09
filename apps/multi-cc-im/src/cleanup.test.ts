import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCleanupCommand } from './cleanup.js';

const SID_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const PANE_LIVE = 42;
const PANE_DEAD = 99;

describe('runCleanupCommand', () => {
  let root: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mcim-cleanup-'));
    stateDir = join(root, 'state');
    await mkdir(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFiles(rel: Record<string, string>): Promise<void> {
    for (const [name, body] of Object.entries(rel)) {
      await writeFile(join(stateDir, name), body, 'utf-8');
    }
  }

  // Test seam: provide live paneIds directly to bypass wezterm.
  const liveSet = (paneIds: readonly number[]) => async () => paneIds;

  it('clean state dir → "already clean" + exit 0', async () => {
    const lines: string[] = [];
    const r = await runCleanupCommand({
      root,
      log: (l) => lines.push(l),
      livePaneIds: liveSet([PANE_LIVE]),
    });
    expect(r.exitCode).toBe(0);
    expect(lines.some((l) => l.includes('already clean'))).toBe(true);
  });

  it('refuses to run when wezterm path cannot be resolved (no livePaneIds override)', async () => {
    const r = await runCleanupCommand({
      root,
      resolveWezTerm: async () => {
        throw new Error('wezterm not found in PATH');
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/wezterm/i);
    expect(r.stderr).toMatch(/refus/i);
  });

  it('legacy + dead-pane orphans + stale daemon.pid → all cleaned in one shot', async () => {
    await writeFiles({
      [`${PANE_DEAD}_${SID_A}.Stop.T1`]: '{}',
      [`${PANE_DEAD}.IMOrigin`]:
        '{"imType":"lark","openId":"ou_user","chatId":"oc_chat"}',
      [`${SID_A}.SessionStart`]: '{}',
      'daemon.pid': JSON.stringify({ pid: 999_999, startedAt: 'fake' }),
    });
    const lines: string[] = [];
    const r = await runCleanupCommand({
      root,
      log: (l) => lines.push(l),
      livePaneIds: liveSet([PANE_LIVE]),
    });
    expect(r.exitCode).toBe(0);
    expect(await readdir(stateDir)).toEqual([]);
    const joined = lines.join('\n');
    expect(joined).toContain('orphan pane file');
    expect(joined).toContain('legacy file');
    expect(joined).toContain('stale daemon.pid');
  });

  it('--dry-run → preview, NO deletions', async () => {
    await writeFiles({
      [`${PANE_DEAD}_${SID_A}.Stop.T1`]: '{}',
    });
    const lines: string[] = [];
    const r = await runCleanupCommand({
      root,
      dryRun: true,
      log: (l) => lines.push(l),
      livePaneIds: liveSet([PANE_LIVE]),
    });
    expect(r.exitCode).toBe(0);
    expect(await readdir(stateDir)).toContain(`${PANE_DEAD}_${SID_A}.Stop.T1`);
    const joined = lines.join('\n');
    expect(joined).toContain('dry-run');
    expect(joined).toContain('would delete');
  });

  it('logs state dir path', async () => {
    const lines: string[] = [];
    await runCleanupCommand({
      root,
      log: (l) => lines.push(l),
      livePaneIds: liveSet([PANE_LIVE]),
    });
    expect(lines.some((l) => l.includes(stateDir))).toBe(true);
  });

  it('state dir does not exist → no-op clean', async () => {
    await rm(stateDir, { recursive: true, force: true });
    const lines: string[] = [];
    const r = await runCleanupCommand({
      root,
      log: (l) => lines.push(l),
      livePaneIds: liveSet([PANE_LIVE]),
    });
    expect(r.exitCode).toBe(0);
    expect(lines.some((l) => l.includes('already clean'))).toBe(true);
  });
});
