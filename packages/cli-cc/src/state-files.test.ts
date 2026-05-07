import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IM_ORIGIN_SUFFIX,
  IM_WORK_FILE_NAME,
  SESSION_END_SUFFIX,
  SESSION_START_SUFFIX,
  STOP_PREFIX,
  deleteIMOriginFile,
  deleteIMWorkFile,
  deleteSessionEndFile,
  deleteSessionStartFile,
  deleteStopFile,
  existsIMOriginFile,
  existsIMWorkFile,
  existsSessionEndFile,
  formatStopTimestamp,
  imOriginPath,
  imWorkPath,
  listIMOriginFiles,
  listStopFiles,
  readIMOriginFile,
  readSessionStartFile,
  readStopFile,
  sessionEndPath,
  sessionStartPath,
  stopFilePath,
  writeIMOriginFile,
  writeIMWorkFile,
  writeSessionEndFile,
  writeSessionStartFile,
  writeStopFile,
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

  describe('formatStopTimestamp', () => {
    it('replaces ":" and "." in ISO timestamps with "-"', () => {
      const d = new Date('2026-05-06T16:20:15.123Z');
      expect(formatStopTimestamp(d)).toBe('2026-05-06T16-20-15-123Z');
    });

    it('produces lexicographically-sortable strings (sort = chronological)', () => {
      const t1 = formatStopTimestamp(new Date('2026-05-06T16:20:15.123Z'));
      const t2 = formatStopTimestamp(new Date('2026-05-06T16:20:15.124Z'));
      const t3 = formatStopTimestamp(new Date('2026-05-06T16:20:16.000Z'));
      const t4 = formatStopTimestamp(new Date('2027-01-01T00:00:00.000Z'));
      expect([t4, t1, t3, t2].sort()).toEqual([t1, t2, t3, t4]);
    });
  });

  describe('SessionStart file', () => {
    it('writeSessionStartFile + readSessionStartFile round-trip with all fields', async () => {
      await writeSessionStartFile({
        stateDir,
        sessionId: SID,
        pid: 12345,
        startedAt: 'Tue May  4 16:38:00 2026',
        paneId: 42,
        cwd: '/private/tmp/cc-probe',
        transcript_path: '/Users/x/.claude/projects/-private-tmp/91215578.jsonl',
      });
      const result = await readSessionStartFile({ stateDir, sessionId: SID });
      expect(result).toEqual({
        pid: 12345,
        startedAt: 'Tue May  4 16:38:00 2026',
        paneId: 42,
        cwd: '/private/tmp/cc-probe',
        transcript_path: '/Users/x/.claude/projects/-private-tmp/91215578.jsonl',
      });
    });

    it('writes to the path returned by sessionStartPath with mode 0600', async () => {
      await writeSessionStartFile({
        stateDir,
        sessionId: SID,
        pid: 1,
        startedAt: 'x',
        cwd: '/tmp',
        transcript_path: '/x.jsonl',
      });
      const path = sessionStartPath({ stateDir, sessionId: SID });
      expect(path).toBe(join(stateDir, `${SID}${SESSION_START_SUFFIX}`));
      const stats = await stat(path);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('omits paneId from JSON when not provided (cc outside wezterm)', async () => {
      await writeSessionStartFile({
        stateDir,
        sessionId: SID,
        pid: 12345,
        startedAt: 'Tue May  4 16:38:00 2026',
        cwd: '/private/tmp/cc-probe',
        transcript_path: '/x.jsonl',
      });
      const filePath = sessionStartPath({ stateDir, sessionId: SID });
      const raw = JSON.parse(await readFile(filePath, 'utf-8'));
      expect('paneId' in raw).toBe(false);
      const result = await readSessionStartFile({ stateDir, sessionId: SID });
      expect(result?.paneId).toBeUndefined();
      expect(result?.pid).toBe(12345);
    });

    it('readSessionStartFile returns null when file missing (ENOENT)', async () => {
      expect(
        await readSessionStartFile({ stateDir, sessionId: SID }),
      ).toBeNull();
    });

    it('deleteSessionStartFile is ENOENT-safe (no throw on missing)', async () => {
      await expect(
        deleteSessionStartFile({ stateDir, sessionId: SID }),
      ).resolves.toBeUndefined();
    });
  });

  describe('SessionEnd file', () => {
    it('writeSessionEndFile creates a 0-byte tombstone', async () => {
      await writeSessionEndFile({ stateDir, sessionId: SID });
      const path = sessionEndPath({ stateDir, sessionId: SID });
      expect(path).toBe(join(stateDir, `${SID}${SESSION_END_SUFFIX}`));
      const stats = await stat(path);
      expect(stats.size).toBe(0);
    });

    it('existsSessionEndFile returns true after write, false when missing', async () => {
      expect(
        await existsSessionEndFile({ stateDir, sessionId: SID }),
      ).toBe(false);
      await writeSessionEndFile({ stateDir, sessionId: SID });
      expect(
        await existsSessionEndFile({ stateDir, sessionId: SID }),
      ).toBe(true);
    });

    it('deleteSessionEndFile is ENOENT-safe', async () => {
      await expect(
        deleteSessionEndFile({ stateDir, sessionId: SID }),
      ).resolves.toBeUndefined();
      // After write+delete, exists should be false again
      await writeSessionEndFile({ stateDir, sessionId: SID });
      await deleteSessionEndFile({ stateDir, sessionId: SID });
      expect(
        await existsSessionEndFile({ stateDir, sessionId: SID }),
      ).toBe(false);
    });
  });

  describe('Stop file', () => {
    it('writeStopFile + readStopFile round-trip via path', async () => {
      const timestamp = '2026-05-06T16-20-15-123Z';
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp,
        last_assistant_message: 'hello world',
      });
      const path = stopFilePath({ stateDir, sessionId: SID, timestamp });
      expect(path).toBe(
        join(stateDir, `${SID}${STOP_PREFIX}${timestamp}`),
      );
      expect(await readStopFile(path)).toEqual({
        last_assistant_message: 'hello world',
      });
    });

    it('readStopFile returns null on ENOENT (daemon-double-event guard)', async () => {
      const path = stopFilePath({
        stateDir,
        sessionId: SID,
        timestamp: '2026-05-06T16-20-15-123Z',
      });
      expect(await readStopFile(path)).toBeNull();
    });

    it('deleteStopFile is ENOENT-safe', async () => {
      const path = stopFilePath({
        stateDir,
        sessionId: SID,
        timestamp: '2026-05-06T16-20-15-123Z',
      });
      await expect(deleteStopFile(path)).resolves.toBeUndefined();
    });

    it('listStopFiles returns paths sorted ascending by timestamp', async () => {
      const timestamps = [
        '2026-05-06T16-20-16-000Z',
        '2026-05-06T16-20-15-123Z',
        '2027-01-01T00-00-00-000Z',
      ];
      // Write in non-sorted order to confirm sort behavior is real
      for (const timestamp of timestamps) {
        await writeStopFile({
          stateDir,
          sessionId: SID,
          timestamp,
          last_assistant_message: `msg-${timestamp}`,
        });
      }
      const result = await listStopFiles({ stateDir, sessionId: SID });
      expect(result).toEqual([
        join(stateDir, `${SID}${STOP_PREFIX}2026-05-06T16-20-15-123Z`),
        join(stateDir, `${SID}${STOP_PREFIX}2026-05-06T16-20-16-000Z`),
        join(stateDir, `${SID}${STOP_PREFIX}2027-01-01T00-00-00-000Z`),
      ]);
    });

    it('listStopFiles for nonexistent stateDir returns []', async () => {
      const missing = join(stateDir, 'does-not-exist');
      expect(
        await listStopFiles({ stateDir: missing, sessionId: SID }),
      ).toEqual([]);
    });

    it('listStopFiles only includes files for the requested sessionId', async () => {
      const SID2 = '5780668a-0000-4fe4-b01d-aaaaaaaaaaaa';
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: '2026-05-06T16-20-15-123Z',
        last_assistant_message: 'a',
      });
      await writeStopFile({
        stateDir,
        sessionId: SID2,
        timestamp: '2026-05-06T16-20-16-000Z',
        last_assistant_message: 'b',
      });
      const result = await listStopFiles({ stateDir, sessionId: SID });
      expect(result).toHaveLength(1);
      expect(result[0]).toContain(SID);
      expect(result[0]).not.toContain(SID2);
    });
  });

  describe('IMWork file (global IM-mode tombstone)', () => {
    it('writeIMWorkFile creates a 0-byte file at <stateDir>/IMWork', async () => {
      await writeIMWorkFile(stateDir);
      const stats = await stat(imWorkPath(stateDir));
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBe(0);
    });

    it('existsIMWorkFile returns false before write, true after', async () => {
      expect(await existsIMWorkFile(stateDir)).toBe(false);
      await writeIMWorkFile(stateDir);
      expect(await existsIMWorkFile(stateDir)).toBe(true);
    });

    it('deleteIMWorkFile is idempotent (ENOENT-safe)', async () => {
      await deleteIMWorkFile(stateDir);
      await writeIMWorkFile(stateDir);
      await deleteIMWorkFile(stateDir);
      await deleteIMWorkFile(stateDir);
      expect(await existsIMWorkFile(stateDir)).toBe(false);
    });

    it('IM_WORK_FILE_NAME is "IMWork" (no .suffix — it lives at top level not per-session)', () => {
      expect(IM_WORK_FILE_NAME).toBe('IMWork');
      expect(imWorkPath(stateDir)).toBe(join(stateDir, 'IMWork'));
    });

    it('existsIMWorkFile returns false when stateDir itself is missing', async () => {
      const missing = join(stateDir, 'does-not-exist');
      expect(await existsIMWorkFile(missing)).toBe(false);
    });
  });

  describe('IMOrigin file (per-session IMReplyContext snapshot)', () => {
    it('writeIMOriginFile persists JSON ctx, readIMOriginFile reads it back verbatim', async () => {
      const ctx = { to: 'wxid_owner', contextToken: 'abc123' };
      await writeIMOriginFile({ stateDir, sessionId: SID, replyCtx: ctx });
      expect(await readIMOriginFile({ stateDir, sessionId: SID })).toEqual(ctx);
    });

    it('writeIMOriginFile overwrites prior content (B2 — newest ctx wins)', async () => {
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'first' },
      });
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'second' },
      });
      expect(await readIMOriginFile({ stateDir, sessionId: SID })).toEqual({
        contextToken: 'second',
      });
    });

    it('readIMOriginFile returns null when file does not exist', async () => {
      expect(
        await readIMOriginFile({ stateDir, sessionId: SID }),
      ).toBeNull();
    });

    it('existsIMOriginFile returns false before write, true after', async () => {
      expect(await existsIMOriginFile({ stateDir, sessionId: SID })).toBe(false);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { foo: 'bar' },
      });
      expect(await existsIMOriginFile({ stateDir, sessionId: SID })).toBe(true);
    });

    it('deleteIMOriginFile is idempotent (ENOENT-safe)', async () => {
      await deleteIMOriginFile({ stateDir, sessionId: SID });
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { x: 1 },
      });
      await deleteIMOriginFile({ stateDir, sessionId: SID });
      await deleteIMOriginFile({ stateDir, sessionId: SID });
      expect(await existsIMOriginFile({ stateDir, sessionId: SID })).toBe(false);
    });

    it('opaque ctx — bridge stores any JSON-serializable shape (forward compat for tg/lark)', async () => {
      // Schema is adapter-defined; bridge layer must NOT inspect it.
      // Test with three different shapes.
      const wechat = { to: 'wxid_owner', contextToken: 'tk123' };
      const telegram = { chatId: 12345, messageId: 678 };
      const lark = { openId: 'ou_xxx', chatId: 'oc_yyy' };
      for (const ctx of [wechat, telegram, lark]) {
        await writeIMOriginFile({ stateDir, sessionId: SID, replyCtx: ctx });
        expect(await readIMOriginFile({ stateDir, sessionId: SID })).toEqual(ctx);
      }
    });

    it('listIMOriginFiles returns absolute paths of all <sid>.IMOrigin files', async () => {
      const SID2 = 'aaaaaaaa-0000-4fe4-b01d-bbbbbbbbbbbb';
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { x: 1 },
      });
      await writeIMOriginFile({
        stateDir,
        sessionId: SID2,
        replyCtx: { y: 2 },
      });
      const result = await listIMOriginFiles(stateDir);
      expect(result).toHaveLength(2);
      expect(result.some((p) => p.includes(SID))).toBe(true);
      expect(result.some((p) => p.includes(SID2))).toBe(true);
      expect(result.every((p) => p.endsWith(IM_ORIGIN_SUFFIX))).toBe(true);
    });

    it('listIMOriginFiles for nonexistent stateDir returns []', async () => {
      const missing = join(stateDir, 'does-not-exist');
      expect(await listIMOriginFiles(missing)).toEqual([]);
    });

    it('listIMOriginFiles does not include other state file types', async () => {
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { x: 1 },
      });
      await writeSessionEndFile({ stateDir, sessionId: SID });
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: '2026-05-08T10-00-00-000Z',
        last_assistant_message: 'hi',
      });
      const result = await listIMOriginFiles(stateDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain(IM_ORIGIN_SUFFIX);
    });
  });
});
