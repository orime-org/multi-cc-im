import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeCcPid,
  readCcPid,
  writeEnded,
  readEnded,
  touchLastHookAt,
  readLastHookAt,
} from './state-files.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';

describe('state-files', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-cc-state-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  describe('writeCcPid / readCcPid', () => {
    it('writes <sid>.cc-pid as JSON with pid + startedAt + writes 0600 mode', async () => {
      await writeCcPid({
        stateDir,
        sessionId: SID,
        pid: 12345,
        startedAt: 'Tue May  4 16:38:00 2026',
      });
      const filePath = join(stateDir, `${SID}.cc-pid`);
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      expect(raw).toEqual({
        pid: 12345,
        startedAt: 'Tue May  4 16:38:00 2026',
      });
      const stats = await stat(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('readCcPid returns null when file missing', async () => {
      expect(await readCcPid({ stateDir, sessionId: SID })).toBeNull();
    });

    it('readCcPid round-trips written content', async () => {
      await writeCcPid({
        stateDir,
        sessionId: SID,
        pid: 9876,
        startedAt: 'Wed May  5 12:00:00 2026',
      });
      expect(await readCcPid({ stateDir, sessionId: SID })).toEqual({
        pid: 9876,
        startedAt: 'Wed May  5 12:00:00 2026',
      });
    });
  });

  describe('writeEnded / readEnded', () => {
    it('writes <sid>.ended JSON with reason + endedAt', async () => {
      await writeEnded({
        stateDir,
        sessionId: SID,
        reason: 'prompt_input_exit',
      });
      const raw = JSON.parse(
        await readFile(join(stateDir, `${SID}.ended`), 'utf-8'),
      );
      expect(raw.reason).toBe('prompt_input_exit');
      expect(typeof raw.endedAt).toBe('number');
      expect(raw.endedAt).toBeGreaterThan(0);
    });

    it('readEnded returns null when file missing', async () => {
      expect(await readEnded({ stateDir, sessionId: SID })).toBeNull();
    });

    it('readEnded round-trips written content', async () => {
      const before = Date.now();
      await writeEnded({
        stateDir,
        sessionId: SID,
        reason: '/exit',
      });
      const after = Date.now();
      const result = await readEnded({ stateDir, sessionId: SID });
      expect(result?.reason).toBe('/exit');
      expect(result?.endedAt).toBeGreaterThanOrEqual(before);
      expect(result?.endedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('touchLastHookAt / readLastHookAt', () => {
    it('writes <sid>.last-hook-at with current ms timestamp', async () => {
      const before = Date.now();
      await touchLastHookAt({ stateDir, sessionId: SID });
      const after = Date.now();
      const ts = await readLastHookAt({ stateDir, sessionId: SID });
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('readLastHookAt returns null when file missing', async () => {
      expect(await readLastHookAt({ stateDir, sessionId: SID })).toBeNull();
    });

    it('overwrites timestamp on subsequent touches', async () => {
      await touchLastHookAt({ stateDir, sessionId: SID });
      await new Promise((r) => setTimeout(r, 10));
      const expected = Date.now();
      await touchLastHookAt({ stateDir, sessionId: SID });
      const actual = await readLastHookAt({ stateDir, sessionId: SID });
      expect(actual).toBeGreaterThanOrEqual(expected - 5);
    });
  });

  describe('directory creation', () => {
    it('writeCcPid creates nested stateDir if missing', async () => {
      const nested = join(stateDir, 'multi', 'level', 'state');
      await writeCcPid({
        stateDir: nested,
        sessionId: SID,
        pid: 1,
        startedAt: 'x',
      });
      expect(await readCcPid({ stateDir: nested, sessionId: SID })).toEqual({
        pid: 1,
        startedAt: 'x',
      });
    });
  });
});
