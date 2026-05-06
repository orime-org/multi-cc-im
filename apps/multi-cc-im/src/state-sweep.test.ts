import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  rm,
  writeFile,
  readdir,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleStateFiles } from './state-sweep.js';

const SID_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

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

  it('paired SessionStart + SessionEnd → both deleted (and any leftover Stop files)', async () => {
    await writeFiles({
      [`${SID_A}.SessionStart`]: '{}',
      [`${SID_A}.SessionEnd`]: '',
      [`${SID_A}.Stop.2026-05-06T16-20-00-000Z`]: '{}',
    });

    const r = await sweepStaleStateFiles(stateDir);
    expect(r.pairedCleaned).toBe(1);
    expect(r.orphanStopsCleaned).toBe(1);
    expect(await listStateDir()).toEqual([]);
  });

  it('lone SessionStart (still alive) keeps SessionStart but drops orphan Stop files', async () => {
    await writeFiles({
      [`${SID_A}.SessionStart`]: '{}',
      [`${SID_A}.Stop.2026-05-06T16-20-00-000Z`]: '{}',
      [`${SID_A}.Stop.2026-05-06T16-21-00-000Z`]: '{}',
    });
    const r = await sweepStaleStateFiles(stateDir);
    expect(r.pairedCleaned).toBe(0);
    expect(r.orphanStopsCleaned).toBe(2);
    expect(await listStateDir()).toEqual([`${SID_A}.SessionStart`]);
  });

  it('legacy state files (cc-pid / events.jsonl / ended / last-hook-at) all deleted', async () => {
    await writeFiles({
      [`${SID_A}.cc-pid`]: '{}',
      [`${SID_A}.events.jsonl`]: '',
      [`${SID_A}.ended`]: '{}',
      [`${SID_A}.last-hook-at`]: '0',
    });
    const r = await sweepStaleStateFiles(stateDir);
    expect(r.legacyCleaned).toBe(4);
    expect(await listStateDir()).toEqual([]);
  });

  it('top-level current-session legacy file deleted', async () => {
    await writeFiles({ 'current-session': 'old-sid' });
    const r = await sweepStaleStateFiles(stateDir);
    expect(r.legacyCleaned).toBe(1);
    expect(await listStateDir()).toEqual([]);
  });

  it('orphan SessionEnd (no SessionStart) → deleted', async () => {
    await writeFiles({ [`${SID_A}.SessionEnd`]: '' });
    const r = await sweepStaleStateFiles(stateDir);
    expect(r.pairedCleaned).toBe(0);
    expect(await listStateDir()).toEqual([]);
  });

  it('multiple sessions with mixed states handled independently', async () => {
    await writeFiles({
      // Session A: paired (dead)
      [`${SID_A}.SessionStart`]: '{}',
      [`${SID_A}.SessionEnd`]: '',
      [`${SID_A}.Stop.2026-05-06T16-20-00-000Z`]: '{}',
      // Session B: lone (alive)
      [`${SID_B}.SessionStart`]: '{}',
      [`${SID_B}.Stop.2026-05-06T16-25-00-000Z`]: '{}',
    });
    const r = await sweepStaleStateFiles(stateDir);
    expect(r.pairedCleaned).toBe(1);
    expect(r.orphanStopsCleaned).toBe(2);
    expect(await listStateDir()).toEqual([`${SID_B}.SessionStart`]);
  });

  it('stateDir does not exist → no-op (returns zeros)', async () => {
    await rm(stateDir, { recursive: true, force: true });
    const r = await sweepStaleStateFiles(stateDir);
    expect(r).toEqual({
      pairedCleaned: 0,
      orphanStopsCleaned: 0,
      legacyCleaned: 0,
    });
  });

  it('non-state-file basenames in stateDir are left untouched', async () => {
    await mkdir(join(stateDir, 'wechat-cursor-dir'), { recursive: true });
    await writeFiles({
      'wechat-cursor': 'cursor-state',
      'random-file.txt': 'untouched',
    });
    await sweepStaleStateFiles(stateDir);
    const remaining = await listStateDir();
    expect(remaining).toContain('wechat-cursor');
    expect(remaining).toContain('random-file.txt');
    expect(remaining).toContain('wechat-cursor-dir');
  });

  it('legacy files preserved when SessionStart exists (cleaned anyway, but session itself stays)', async () => {
    await writeFiles({
      [`${SID_A}.SessionStart`]: '{}',
      [`${SID_A}.cc-pid`]: '{}',
      [`${SID_A}.last-hook-at`]: '0',
    });
    const r = await sweepStaleStateFiles(stateDir);
    expect(r.legacyCleaned).toBe(2);
    expect(await listStateDir()).toEqual([`${SID_A}.SessionStart`]);
  });
});
