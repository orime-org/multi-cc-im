import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigStore, PaneId } from '@multi-cc-im/shared';
import {
  touchLastHookAt,
  writeCcPid,
  writeEnded,
} from '@multi-cc-im/cli-cc';
import type { PidProbe } from '@multi-cc-im/term-wezterm';
import { createSessionRegistry } from './session-registry.js';

const SID_A = '11111111-3606-4fe4-b01d-aaaaaaaaaaaa';
const SID_B = '22222222-3606-4fe4-b01d-bbbbbbbbbbbb';
const SID_C = '33333333-3606-4fe4-b01d-cccccccccccc';

function fixedConfigStore(
  friendlyNames: Record<string, string>,
): ConfigStore {
  return {
    load: async () => ({
      friendly_names: friendlyNames as never,
      acl: { owners: [] },
      external_paths: {},
    }),
    save: async () => {},
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
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({}),
    });
    expect(await reg.listAlive()).toEqual([]);
  });

  it('one alive session with paneId + matching lstart → returned', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/proj-a',
    });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
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
  });

  it('session with SessionEnd file → filtered out as dead', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
    });
    await writeEnded({ stateDir, sessionId: SID_A, reason: '/exit' });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    expect(await reg.listAlive()).toEqual([]);
  });

  it('session with PID dead → filtered out', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
    });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({ alivePids: new Set() }), // 1000 not alive
    });
    expect(await reg.listAlive()).toEqual([]);
  });

  it('session with lstart MISMATCH → filtered out (PID reuse defense)', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
    });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({
        alivePids: new Set([1000]),
        defaultLstart: 'Y', // different from saved 'X'
      }),
    });
    expect(await reg.listAlive()).toEqual([]);
  });

  it('multiple sessions: alive + dead + ended → returns alive only', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/a',
    });
    await writeCcPid({
      stateDir,
      sessionId: SID_B,
      pid: 2000,
      startedAt: 'X',
      paneId: 20,
      cwd: '/tmp/b',
    });
    await writeCcPid({
      stateDir,
      sessionId: SID_C,
      pid: 3000,
      startedAt: 'X',
      paneId: 30,
      cwd: '/tmp/c',
    });
    await writeEnded({ stateDir, sessionId: SID_C, reason: '/exit' });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({
        alivePids: new Set([1000]), // only A alive; B PID dead; C ended
        defaultLstart: 'X',
      }),
    });
    const result = await reg.listAlive();
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe(SID_A);
  });

  it('attaches friendlyName from configStore by sessionId', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 10,
      cwd: '/tmp/x',
    });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({ [SID_A]: 'frontend' }),
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    const result = await reg.listAlive();
    expect(result[0]?.friendlyName).toBe('frontend');
  });

  it('session with no paneId → filtered out (not routable from bridge)', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      // no paneId — cc ran outside wezterm
      cwd: '/tmp/x',
    });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    expect(await reg.listAlive()).toEqual([]);
  });

  it('cc-pid missing + last-hook-at fresh → fallback alive (bridge restart edge)', async () => {
    // Edge: SessionStart fired → events.jsonl appended → but bridge crashed
    // before cc-pid got written? In practice this is rare; the fallback
    // covers "cc-pid was deleted somehow but last-hook-at suggests recent
    // activity". Per pane-alive DD #4 signal logic.
    await touchLastHookAt({ stateDir, sessionId: SID_A });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({}),
      idleTimeoutMs: 30 * 60_000,
    });
    // Without cc-pid, no paneId/cwd → cannot route. Filter out.
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
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({}),
    });
    expect(reg.get(10 as PaneId)).toBeNull();
  });

  it('get(paneId) returns sessionId after listAlive populates the cache', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 42,
      cwd: '/tmp/x',
    });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    await reg.listAlive();
    expect(reg.get(42 as PaneId)).toBe(SID_A);
  });

  it('get(unknown paneId) returns null', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 42,
      cwd: '/tmp/x',
    });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
      pidProbe: stubPidProbe({ alivePids: new Set([1000]), defaultLstart: 'X' }),
    });
    await reg.listAlive();
    expect(reg.get(999 as PaneId)).toBeNull();
  });

  it('after session dies, listAlive prunes paneToSession cache', async () => {
    await writeCcPid({
      stateDir,
      sessionId: SID_A,
      pid: 1000,
      startedAt: 'X',
      paneId: 42,
      cwd: '/tmp/x',
    });
    const reg = createSessionRegistry({
      stateDir,
      configStore: fixedConfigStore({}),
      pidProbe: {
        isAlive: (pid) => pid === 1000,
        getLstart: async () => 'X',
      },
    });
    await reg.listAlive();
    expect(reg.get(42 as PaneId)).toBe(SID_A);

    // Simulate session ending
    await writeEnded({ stateDir, sessionId: SID_A, reason: '/exit' });
    await reg.listAlive();
    expect(reg.get(42 as PaneId)).toBeNull();
  });
});
