import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaneId } from '@multi-cc-im/shared';
import {
  writeSessionEndFile,
  writeSessionStartFile,
} from '@multi-cc-im/cli-cc';
import type { PidProbe, TabInfo } from '@multi-cc-im/term-wezterm';
import { createSessionRegistry } from './session-registry.js';

const SID_A = '11111111-3606-4fe4-b01d-aaaaaaaaaaaa';
const SID_B = '22222222-3606-4fe4-b01d-bbbbbbbbbbbb';
const SID_C = '33333333-3606-4fe4-b01d-cccccccccccc';

/**
 * Build a stub `getTabTitles` callback that returns the given paneId → title
 * map. Each entry yields a fully-formed `TabInfo` (paneId + title + cwd) so
 * the registry's `tab.title.length > 0` guard is exercised exactly the way
 * production wezterm `listAllTabs` would deliver it.
 */
function fixedGetTabTitles(
  titlesByPaneId: Record<number, string>,
): () => Promise<Map<number, TabInfo>> {
  return async () => {
    const m = new Map<number, TabInfo>();
    for (const [paneIdStr, title] of Object.entries(titlesByPaneId)) {
      const paneId = Number(paneIdStr);
      m.set(paneId, {
        paneId,
        title,
        cwd: `file:///tmp/pane-${paneId}`,
      });
    }
    return m;
  };
}

function stubPidProbe(opts: {
  alivePids?: Set<number>;
  lstartByPid?: Record<number, string>;
  defaultLstart?: string;
}): PidProbe {
  return {
    isAlive: (pid) => opts.alivePids?.has(pid) ?? true,
    getLstart: async (pid) =>
      opts.lstartByPid?.[pid] ?? opts.defaultLstart ?? 'Tue May  4 16:38:00 2026',
  };
}

describe('createSessionRegistry — listAlive', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'sr-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('empty stateDir → empty list', async () => {
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({}),
    });
    expect(await reg.listAlive()).toEqual([]);
  });

  it('one alive session with paneId + matching lstart → returned', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/proj-a',
      transcript_path: '/tmp/proj-a.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({
        alivePids: new Set([1000]),
        defaultLstart: 'X',
      }),
    });
    const result = await reg.listAlive();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sessionId: SID_A,
      paneId: 10,
      cwd: '/tmp/proj-a',
    });
    // No getTabTitles supplied → tabTitle stays undefined
    expect(result[0]?.tabTitle).toBeUndefined();
  });

  it('session with SessionEnd file → filtered out as dead', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    await writeSessionEndFile({ stateDir, sessionId: SID_A });
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    expect(await reg.listAlive()).toEqual([]);
  });

  it('session with PID dead → filtered out', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({ alivePids: new Set() }), // 1000 not alive
    });
    expect(await reg.listAlive()).toEqual([]);
  });

  it('session with lstart MISMATCH → filtered out (PID reuse defense)', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({
        alivePids: new Set([1000]),
        defaultLstart: 'Y', // different from saved 'X'
      }),
    });
    expect(await reg.listAlive()).toEqual([]);
  });

  it('multiple sessions: alive + dead + ended → returns alive only', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/a',
      transcript_path: '/tmp/a.jsonl',
    });
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_B,
      pid: 2000,
      startedAt: 'X',
      paneId: 20,
      cwd: '/tmp/b',
      transcript_path: '/tmp/b.jsonl',
    });
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_C,
      pid: 3000,
      startedAt: 'X',
      paneId: 30,
      cwd: '/tmp/c',
      transcript_path: '/tmp/c.jsonl',
    });
    await writeSessionEndFile({ stateDir, sessionId: SID_C });
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({
        alivePids: new Set([1000]), // only A alive; B PID dead; C ended
        defaultLstart: 'X',
      }),
    });
    const result = await reg.listAlive();
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe(SID_A);
  });

  it('attaches tabTitle from getTabTitles map by paneId', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      getTabTitles: fixedGetTabTitles({ 10: 'frontend' }),
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    const result = await reg.listAlive();
    expect(result[0]?.tabTitle).toBe('frontend');
  });

  it('getTabTitles throws → tabTitle stays undefined, listAlive still returns sessions', async () => {
    // Exercises the try/catch fallback in session-registry.ts:
    // wezterm cli unavailable / failure should not nuke routing — sessions
    // resolve by `$sid8` instead.
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      getTabTitles: async () => {
        throw new Error('wezterm cli not on PATH');
      },
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    const result = await reg.listAlive();
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe(SID_A);
    expect(result[0]?.tabTitle).toBeUndefined();
  });

  it('tab with empty string title → tabTitle field is undefined', async () => {
    // Exercises the `tab.title.length > 0` guard — an unnamed cc tab comes
    // back as `{ title: '', ... }` from wezterm; bridge must surface that as
    // `undefined` so `displayName` falls back to `$sid8` + rename hint.
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      getTabTitles: fixedGetTabTitles({ 10: '' }),
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    const result = await reg.listAlive();
    expect(result).toHaveLength(1);
    expect(result[0]?.tabTitle).toBeUndefined();
  });

  it('session with no paneId → filtered out (not routable from bridge)', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      // no paneId — cc ran outside wezterm
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    expect(await reg.listAlive()).toEqual([]);
  });
});

describe('createSessionRegistry — paneToSession reverse lookup', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'sr-pts-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('get(paneId) returns null until first listAlive (sync interface, no fs)', () => {
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({}),
    });
    expect(reg.get(10 as PaneId)).toBeNull();
  });

  it('get(paneId) returns sessionId after listAlive populates the cache', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 42,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    await reg.listAlive();
    expect(reg.get(42 as PaneId)).toBe(SID_A);
  });

  it('get(unknown paneId) returns null', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 42,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    await reg.listAlive();
    expect(reg.get(999 as PaneId)).toBeNull();
  });

  it('after session dies, listAlive prunes paneToSession cache', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 42,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const reg = createSessionRegistry({
      stateDir,
      pidProbe: {
        isAlive: (pid) => pid === 1000,
        getLstart: async () => 'X',
      },
    });
    await reg.listAlive();
    expect(reg.get(42 as PaneId)).toBe(SID_A);

    // Simulate session ending
    await writeSessionEndFile({ stateDir, sessionId: SID_A });
    await reg.listAlive();
    expect(reg.get(42 as PaneId)).toBeNull();
  });
});
