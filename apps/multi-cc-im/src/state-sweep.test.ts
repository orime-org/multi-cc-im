import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleStateFiles } from './state-sweep.js';

const SID_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const PANE_LIVE = 42;
const PANE_DEAD = 99;

describe('sweepStaleStateFiles', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'mcim-sweep-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  async function writeFiles(rel: Record<string, string>): Promise<void> {
    for (const [name, body] of Object.entries(rel)) {
      await writeFile(join(stateDir, name), body, 'utf-8');
    }
  }

  async function listStateDir(): Promise<string[]> {
    return (await readdir(stateDir)).sort();
  }

  // ===========================================================================
  // Pane-keyed orphan sweep — paneId not in live wezterm set → cleaned.
  // ===========================================================================

  describe('pane-keyed orphan files (paneId not in live wezterm set)', () => {
    it('Stop / PermissionRequest / IMOrigin for dead pane → all cleaned', async () => {
      await writeFiles({
        [`${PANE_DEAD}_${SID_A}.Stop.2026-05-08T01-43-40-131Z`]: '{}',
        [`${PANE_DEAD}_${SID_A}.PermissionRequest.deadbeef.json`]: '{}',
        [`${PANE_DEAD}.IMOrigin`]:
          '{"imType":"wechat","to":"u","contextToken":"x"}',
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.orphanPaneFilesCleaned).toBe(3);
      expect(await listStateDir()).toEqual([]);
    });

    it('files for live pane → KEPT', async () => {
      await writeFiles({
        [`${PANE_LIVE}_${SID_A}.Stop.2026-05-08T01-43-40-131Z`]: '{}',
        [`${PANE_LIVE}.IMOrigin`]:
          '{"imType":"wechat","to":"u","contextToken":"x"}',
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.orphanPaneFilesCleaned).toBe(0);
      expect((await listStateDir()).length).toBe(2);
    });

    it('mixed live + dead → only dead cleaned', async () => {
      await writeFiles({
        [`${PANE_LIVE}_${SID_A}.Stop.T1`]: '{}',
        [`${PANE_DEAD}_${SID_B}.Stop.T1`]: '{}',
        [`${PANE_LIVE}.IMOrigin`]:
          '{"imType":"wechat","to":"u","contextToken":"x"}',
        [`${PANE_DEAD}.IMOrigin`]:
          '{"imType":"wechat","to":"u","contextToken":"x"}',
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.orphanPaneFilesCleaned).toBe(2);
      const after = await listStateDir();
      expect(after).toContain(`${PANE_LIVE}_${SID_A}.Stop.T1`);
      expect(after).toContain(`${PANE_LIVE}.IMOrigin`);
    });

    it('livePaneIds throws → keep all pane-keyed files (defensive fail-safe)', async () => {
      await writeFiles({
        [`${PANE_LIVE}_${SID_A}.Stop.T1`]: '{}',
        [`${PANE_DEAD}_${SID_B}.Stop.T1`]: '{}',
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => {
          throw new Error('wezterm not running');
        },
      });
      expect(r.orphanPaneFilesCleaned).toBe(0);
      expect((await listStateDir()).length).toBe(2);
    });

    it('livePaneIds undefined → all pane-keyed files treated as orphans (scorched-earth)', async () => {
      await writeFiles({
        [`${PANE_LIVE}_${SID_A}.Stop.T1`]: '{}',
        [`${PANE_LIVE}.IMOrigin`]:
          '{"imType":"wechat","to":"u","contextToken":"x"}',
      });
      const r = await sweepStaleStateFiles(stateDir);
      expect(r.orphanPaneFilesCleaned).toBe(2);
      expect(await listStateDir()).toEqual([]);
    });
  });

  // ===========================================================================
  // Legacy sid-keyed schema cleanup — pre-DD-#61 artifacts.
  // ===========================================================================

  describe('legacy pre-DD-#61 sid-keyed files', () => {
    it('SessionStart / SessionEnd → cleaned (no longer subscribed)', async () => {
      await writeFiles({
        [`${SID_A}.SessionStart`]: '{}',
        [`${SID_A}.SessionEnd`]: '',
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.legacyCleaned).toBe(2);
      expect(await listStateDir()).toEqual([]);
    });

    it('cc-pid / events.jsonl / ended / last-hook-at → cleaned', async () => {
      await writeFiles({
        [`${SID_A}.cc-pid`]: '{}',
        [`${SID_A}.events.jsonl`]: '',
        [`${SID_A}.ended`]: '{}',
        [`${SID_A}.last-hook-at`]: '0',
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.legacyCleaned).toBe(4);
      expect(await listStateDir()).toEqual([]);
    });

    it('top-level current-session legacy file → cleaned', async () => {
      await writeFiles({ 'current-session': 'old-sid' });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.legacyCleaned).toBe(1);
      expect(await listStateDir()).toEqual([]);
    });

    it('legacy sid-keyed Permission / Stop / IMOrigin → cleaned (no paneId in name)', async () => {
      await writeFiles({
        [`${SID_A}.Stop.2026-05-06T16-20-00-000Z`]: '{}',
        [`${SID_A}.PermissionRequest.req1.json`]: '{}',
        [`${SID_A}.IMOrigin`]:
          '{"imType":"wechat","to":"u","contextToken":"x"}',
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.legacyCleaned).toBe(3);
      expect(await listStateDir()).toEqual([]);
    });
  });

  // ===========================================================================
  // Top-level files NEVER swept.
  // ===========================================================================

  describe('top-level files never swept', () => {
    it('IMWork preserved', async () => {
      await writeFiles({ IMWork: '' });
      await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(await listStateDir()).toContain('IMWork');
    });

    it('wechat-cursor preserved (long-poll cursor)', async () => {
      await writeFiles({ 'wechat-cursor': 'cursor-state' });
      await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(await listStateDir()).toContain('wechat-cursor');
    });

    it('unknown random files left alone (not legacy patterns, not pane-keyed)', async () => {
      await mkdir(join(stateDir, 'wechat-cursor-dir'), { recursive: true });
      await writeFiles({ 'random-file.txt': 'untouched' });
      await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      const remaining = await listStateDir();
      expect(remaining).toContain('random-file.txt');
      expect(remaining).toContain('wechat-cursor-dir');
    });
  });

  // ===========================================================================
  // daemon.pid liveness check.
  // ===========================================================================

  describe('daemon.pid', () => {
    it('dead PID → cleaned (stale lock)', async () => {
      await writeFiles({
        'daemon.pid': JSON.stringify({
          pid: 999_999,
          startedAt: 'fake',
        }),
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.staleDaemonPidCleaned).toBe(1);
      expect(await listStateDir()).toEqual([]);
    });

    it('live PID + mismatched lstart → cleaned (PID-reuse stale)', async () => {
      await writeFiles({
        'daemon.pid': JSON.stringify({
          pid: process.pid,
          startedAt: 'WRONG-LSTART-2020-01-01',
        }),
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.staleDaemonPidCleaned).toBe(1);
    });

    it('live PID + correct lstart → KEPT (active daemon)', async () => {
      const { captureProcessLstart } = await import('@multi-cc-im/cli-cc');
      const lstart = await captureProcessLstart(process.pid);
      await writeFiles({
        'daemon.pid': JSON.stringify({
          pid: process.pid,
          startedAt: lstart!,
        }),
      });
      const r = await sweepStaleStateFiles(stateDir, {
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.staleDaemonPidCleaned).toBe(0);
      expect(await listStateDir()).toContain('daemon.pid');
    });
  });

  // ===========================================================================
  // dry-run + edge cases.
  // ===========================================================================

  describe('dry-run', () => {
    it('preserves all files but counts what would be deleted', async () => {
      await writeFiles({
        [`${PANE_DEAD}_${SID_A}.Stop.T1`]: '{}',
        [`${SID_A}.SessionStart`]: '{}',
        'daemon.pid': JSON.stringify({ pid: 999_999, startedAt: 'fake' }),
      });
      const r = await sweepStaleStateFiles(stateDir, {
        dryRun: true,
        livePaneIds: async () => [PANE_LIVE],
      });
      expect(r.orphanPaneFilesCleaned).toBe(1);
      expect(r.legacyCleaned).toBe(1);
      expect(r.staleDaemonPidCleaned).toBe(1);
      expect((await listStateDir()).length).toBe(3);
    });
  });

  it('stateDir does not exist → no-op (returns zeros)', async () => {
    await rm(stateDir, { recursive: true, force: true });
    const r = await sweepStaleStateFiles(stateDir);
    expect(r).toEqual({
      orphanPaneFilesCleaned: 0,
      legacyCleaned: 0,
      staleDaemonPidCleaned: 0,
    });
  });

  it('combined sweep — dead pane files + legacy + stale daemon.pid all cleaned in one pass', async () => {
    await writeFiles({
      [`${PANE_DEAD}_${SID_A}.Stop.T1`]: '{}',
      [`${PANE_DEAD}.IMOrigin`]:
        '{"imType":"wechat","to":"u","contextToken":"x"}',
      [`${SID_A}.SessionStart`]: '{}',
      [`${SID_B}.cc-pid`]: '{}',
      'daemon.pid': JSON.stringify({ pid: 999_999, startedAt: 'fake' }),
      IMWork: '',
    });
    const r = await sweepStaleStateFiles(stateDir, {
      livePaneIds: async () => [PANE_LIVE],
    });
    expect(r.orphanPaneFilesCleaned).toBe(2);
    expect(r.legacyCleaned).toBe(2);
    expect(r.staleDaemonPidCleaned).toBe(1);
    // IMWork survives.
    expect(await listStateDir()).toEqual(['IMWork']);
  });
});
