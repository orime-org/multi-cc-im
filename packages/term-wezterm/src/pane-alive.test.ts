import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaneId, PaneToSessionMap, SessionId } from '@multi-cc-im/shared';
import {
  writeSessionEndFile,
  writeSessionStartFile,
} from '@multi-cc-im/cli-cc';
import { createIsPaneAlive } from './pane-alive.js';
import type { PidProbe } from './pid-probe.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790' as SessionId;
const PANE = 20 as PaneId;

function fixedMap(map: Record<number, SessionId | null>): PaneToSessionMap {
  return {
    get: (paneId: PaneId) => map[paneId] ?? null,
  };
}

function stubPidProbe(opts: {
  alive: boolean;
  lstart?: string;
  lstartThrows?: boolean;
}): PidProbe {
  return {
    isAlive: () => opts.alive,
    getLstart: async () => {
      if (opts.lstartThrows) throw new Error('ps failed');
      return opts.lstart ?? 'Tue May  4 16:38:00 2026';
    },
  };
}

describe('createIsPaneAlive — multi-signal state machine', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'pa-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('unknown pane (paneToSession.get returns null) → dead (conservative)', async () => {
    const isAlive = createIsPaneAlive({
      stateDir,
      paneToSession: fixedMap({}),
      pidProbe: stubPidProbe({ alive: true }),
    });
    expect(await isAlive(PANE)).toBe(false);
  });

  it('SessionEnd file present → dead (signal 1: graceful exit)', async () => {
    await writeSessionEndFile({ stateDir, sessionId: SID });
    const isAlive = createIsPaneAlive({
      stateDir,
      paneToSession: fixedMap({ [PANE]: SID }),
      pidProbe: stubPidProbe({ alive: true }),
    });
    expect(await isAlive(PANE)).toBe(false);
  });

  it('SessionStart missing → DEAD (no signal at all, no idle-timeout fallback any more)', async () => {
    // Per the post-redesign 7-outcome lattice: with no SessionStart file there
    // is no authoritative pid/startedAt to probe and no idle-timeout fallback,
    // so the only safe answer is DEAD.
    const isAlive = createIsPaneAlive({
      stateDir,
      paneToSession: fixedMap({ [PANE]: SID }),
      pidProbe: stubPidProbe({ alive: true }),
    });
    expect(await isAlive(PANE)).toBe(false);
  });

  it('SessionStart present + PID alive + lstart matches → ALIVE (steady state)', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID,
      pid: 12345,
      startedAt: 'Tue May  4 16:38:00 2026',
      paneId: PANE,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const isAlive = createIsPaneAlive({
      stateDir,
      paneToSession: fixedMap({ [PANE]: SID }),
      pidProbe: stubPidProbe({
        alive: true,
        lstart: 'Tue May  4 16:38:00 2026',
      }),
    });
    expect(await isAlive(PANE)).toBe(true);
  });

  it('SessionStart present + PID DEAD → dead (signal 2: abnormal exit)', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID,
      pid: 12345,
      startedAt: 'Tue May  4 16:38:00 2026',
      paneId: PANE,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const isAlive = createIsPaneAlive({
      stateDir,
      paneToSession: fixedMap({ [PANE]: SID }),
      pidProbe: stubPidProbe({ alive: false }),
    });
    expect(await isAlive(PANE)).toBe(false);
  });

  it('SessionStart present + PID alive + lstart MISMATCH → dead (PID reuse defense)', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID,
      pid: 12345,
      startedAt: 'Tue May  4 16:38:00 2026',
      paneId: PANE,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const isAlive = createIsPaneAlive({
      stateDir,
      paneToSession: fixedMap({ [PANE]: SID }),
      pidProbe: stubPidProbe({
        alive: true,
        lstart: 'Wed May  5 09:00:00 2026', // different start time = PID reused
      }),
    });
    expect(await isAlive(PANE)).toBe(false);
  });

  it('SessionStart present + PID alive + ps lstart THROWS → dead (treat probe failure as dead)', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID,
      pid: 12345,
      startedAt: 'Tue May  4 16:38:00 2026',
      paneId: PANE,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    const isAlive = createIsPaneAlive({
      stateDir,
      paneToSession: fixedMap({ [PANE]: SID }),
      pidProbe: stubPidProbe({ alive: true, lstartThrows: true }),
    });
    expect(await isAlive(PANE)).toBe(false);
  });

  it('SessionEnd dominates even when PID still alive (graceful logout race window)', async () => {
    await writeSessionStartFile({
      stateDir,
      sessionId: SID,
      pid: 12345,
      startedAt: 'Tue May  4 16:38:00 2026',
      paneId: PANE,
      cwd: '/tmp/x',
      transcript_path: '/tmp/x.jsonl',
    });
    await writeSessionEndFile({ stateDir, sessionId: SID });
    const isAlive = createIsPaneAlive({
      stateDir,
      paneToSession: fixedMap({ [PANE]: SID }),
      pidProbe: stubPidProbe({
        alive: true, // PID still around
        lstart: 'Tue May  4 16:38:00 2026',
      }),
    });
    expect(await isAlive(PANE)).toBe(false);
  });
});
