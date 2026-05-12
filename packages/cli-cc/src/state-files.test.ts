import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAEMON_PID_FILE_NAME,
  IM_ORIGIN_FILE_NAME,
  IM_WORK_FILE_NAME,
  STOP_PREFIX,
  PERMISSION_REQUEST_PREFIX,
  PERMISSION_RESPONSE_PREFIX,
  captureProcessLstart,
  daemonPidPath,
  deleteDaemonPidFile,
  deleteIMOriginFile,
  deleteIMWorkFile,
  deletePermissionFileByPath,
  deletePermissionRequestFile,
  deletePermissionResponseFile,
  deleteStopFile,
  existsIMOriginFile,
  existsIMWorkFile,
  extractPaneIdFromFilename,
  formatStopTimestamp,
  imOriginPath,
  imWorkPath,
  isDaemonAlive,
  listPendingPermissionRequests,
  listPermissionRequestFiles,
  listPermissionResponseFiles,
  listStopFiles,
  parseLegacyPaneOriginFilename,
  parsePermissionFilename,
  parseStopFilename,
  permissionRequestPath,
  permissionResponsePath,
  readDaemonPidFile,
  readIMOriginFile,
  readPermissionRequestFile,
  readPermissionResponseFile,
  readStopFile,
  stopFilePath,
  writeDaemonPidFile,
  writeIMOriginFile,
  writeIMWorkFile,
  readIMWorkFile,
  writePermissionRequestFile,
  writePermissionResponseFile,
  writeStopFile,
} from './state-files.js';
import type { IMReplyContext } from '@multi-cc-im/shared';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const SID2 = '00000000-1111-2222-3333-444444444444';
const PANE_ID = 42;
const PANE_ID2 = 99;

const LARK_CTX: IMReplyContext = {
  imType: 'lark',
  openId: 'ou_user',
  chatId: 'oc_chat',
};

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

  describe('filename parsers', () => {
    it('parseStopFilename matches <paneId>_<sid>.Stop.<ts>', () => {
      const name = `${PANE_ID}_${SID}.Stop.2026-05-08T01-43-40-131Z`;
      expect(parseStopFilename(name)).toEqual({
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: '2026-05-08T01-43-40-131Z',
      });
    });

    it('parseStopFilename returns null for non-matching names', () => {
      expect(parseStopFilename(`${SID}.Stop.x`)).toBeNull(); // legacy sid-keyed
      expect(parseStopFilename('IMWork')).toBeNull();
      expect(parseStopFilename(`${PANE_ID}.IMOrigin`)).toBeNull();
    });

    it('parseStopFilename accepts absolute path (chokidar gives full path)', () => {
      const path = join('/state', `${PANE_ID}_${SID}.Stop.foo`);
      expect(parseStopFilename(path)).toEqual({
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'foo',
      });
    });

    it('parsePermissionFilename matches request + response variants', () => {
      const reqName = `${PANE_ID}_${SID}.PermissionRequest.deadbeef.json`;
      expect(parsePermissionFilename(reqName)).toEqual({
        paneId: PANE_ID,
        sessionId: SID,
        kind: 'request',
        requestId: 'deadbeef',
      });
      const resName = `${PANE_ID}_${SID}.PermissionResponse.cafef00d.json`;
      expect(parsePermissionFilename(resName)).toEqual({
        paneId: PANE_ID,
        sessionId: SID,
        kind: 'response',
        requestId: 'cafef00d',
      });
    });

    it('parsePermissionFilename returns null on bad shape', () => {
      expect(parsePermissionFilename(`${SID}.Permission.x.json`)).toBeNull();
    });

    it('parseLegacyPaneOriginFilename matches old <paneId>.IMOrigin (DD #_imorigin_global_ migration)', () => {
      expect(parseLegacyPaneOriginFilename(`${PANE_ID}.IMOrigin`)).toEqual({
        paneId: PANE_ID,
      });
    });

    it('parseLegacyPaneOriginFilename rejects non-numeric prefix', () => {
      expect(parseLegacyPaneOriginFilename(`abc.IMOrigin`)).toBeNull();
      expect(parseLegacyPaneOriginFilename(`${SID}.IMOrigin`)).toBeNull();
    });

    it('extractPaneIdFromFilename covers Stop / Permission / legacy <paneId>.IMOrigin', () => {
      expect(
        extractPaneIdFromFilename(`${PANE_ID}_${SID}.Stop.foo`),
      ).toBe(PANE_ID);
      expect(
        extractPaneIdFromFilename(
          `${PANE_ID}_${SID}.PermissionRequest.x.json`,
        ),
      ).toBe(PANE_ID);
      // Legacy pane-keyed IMOrigin still recognized so state-sweep can clean it up.
      expect(extractPaneIdFromFilename(`${PANE_ID}.IMOrigin`)).toBe(PANE_ID);
      // Top-level files (incl. new global IMOrigin) are NOT pane-keyed.
      expect(extractPaneIdFromFilename('IMWork')).toBeNull();
      expect(extractPaneIdFromFilename('IMOrigin')).toBeNull();
      expect(extractPaneIdFromFilename(`${SID}.SessionStart`)).toBeNull();
    });
  });

  describe('Stop file (paneId-keyed)', () => {
    it('writeStopFile + readStopFile round-trip preserves last_assistant_message', async () => {
      const ts = '2026-05-08T01-43-40-131Z';
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: ts,
        last_assistant_message: '多行\n第二行 ✨',
      });
      const path = stopFilePath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: ts,
      });
      expect(path.endsWith(`${PANE_ID}_${SID}${STOP_PREFIX}${ts}`)).toBe(true);
      const got = await readStopFile(path);
      expect(got?.last_assistant_message).toBe('多行\n第二行 ✨');
    });

    it('stopFilePath embeds <paneId>_<sid>.Stop.<ts>', () => {
      const path = stopFilePath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'T1',
      });
      expect(path).toBe(join(stateDir, `${PANE_ID}_${SID}.Stop.T1`));
    });

    it('listStopFiles returns sorted (chronological) files for that pane+sid', async () => {
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'T2',
        last_assistant_message: 'b',
      });
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'T1',
        last_assistant_message: 'a',
      });
      // Different pane shouldn't appear.
      await writeStopFile({
        stateDir,
        paneId: PANE_ID2,
        sessionId: SID,
        timestamp: 'T1',
        last_assistant_message: 'other-pane',
      });
      const list = await listStopFiles({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
      });
      expect(list).toHaveLength(2);
      expect(list[0]?.endsWith('T1')).toBe(true);
      expect(list[1]?.endsWith('T2')).toBe(true);
    });

    it('readStopFile returns null on ENOENT (chokidar double-event race)', async () => {
      const path = stopFilePath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'never',
      });
      expect(await readStopFile(path)).toBeNull();
    });

    it('deleteStopFile is idempotent', async () => {
      const ts = 'T1';
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: ts,
        last_assistant_message: 'x',
      });
      const path = stopFilePath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: ts,
      });
      await deleteStopFile(path);
      await expect(deleteStopFile(path)).resolves.toBeUndefined();
    });
  });

  describe('Permission Request / Response (paneId-keyed)', () => {
    it('writePermissionRequestFile + readPermissionRequestFile round-trip', async () => {
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'deadbeef',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        createdAt: 1700000000000,
      });
      const path = permissionRequestPath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'deadbeef',
      });
      expect(
        path.endsWith(
          `${PANE_ID}_${SID}${PERMISSION_REQUEST_PREFIX}deadbeef.json`,
        ),
      ).toBe(true);
      const got = await readPermissionRequestFile(path);
      expect(got?.requestId).toBe('deadbeef');
      expect(got?.toolName).toBe('Bash');
      expect(got?.toolInput).toEqual({ command: 'ls' });
    });

    it('writePermissionResponseFile + readPermissionResponseFile round-trip (allow + reason)', async () => {
      await writePermissionResponseFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'cafef00d',
        decision: 'allow',
        reason: 'IM user approved',
      });
      const path = permissionResponsePath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'cafef00d',
      });
      expect(
        path.endsWith(
          `${PANE_ID}_${SID}${PERMISSION_RESPONSE_PREFIX}cafef00d.json`,
        ),
      ).toBe(true);
      const got = await readPermissionResponseFile(path);
      expect(got?.decision).toBe('allow');
      if (got?.decision !== 'allow') throw new Error('expected allow');
      expect(got.reason).toBe('IM user approved');
      expect(got.updatedInput).toBeUndefined();
    });

    it('round-trip allow + updatedInput (AskUserQuestion answer-inject path)', async () => {
      const updatedInput = {
        questions: [
          {
            question: 'How should I format the output?',
            options: [{ label: 'Summary' }, { label: 'Detailed' }],
          },
        ],
        answers: {
          'How should I format the output?': 'Summary',
        },
      };
      await writePermissionResponseFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'auq00001',
        decision: 'allow',
        updatedInput,
      });
      const got = await readPermissionResponseFile(
        permissionResponsePath({
          stateDir,
          paneId: PANE_ID,
          sessionId: SID,
          requestId: 'auq00001',
        }),
      );
      expect(got?.decision).toBe('allow');
      if (got?.decision !== 'allow') throw new Error('expected allow');
      expect(got.updatedInput).toEqual(updatedInput);
      expect(got.reason).toBeUndefined();
    });

    it('round-trip deny + reason', async () => {
      await writePermissionResponseFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'denyfeed',
        decision: 'deny',
        reason: 'IM user rejected',
      });
      const got = await readPermissionResponseFile(
        permissionResponsePath({
          stateDir,
          paneId: PANE_ID,
          sessionId: SID,
          requestId: 'denyfeed',
        }),
      );
      expect(got?.decision).toBe('deny');
      if (got?.decision !== 'deny') throw new Error('expected deny');
      expect(got.reason).toBe('IM user rejected');
    });

    it('writePermissionResponseFile rejects deny without reason (zod parse error)', async () => {
      // Deliberately bypass TS so we can verify the runtime zod guard.
      // Without the cast, the union type rejects this at compile time —
      // which is also a property we want, but we test runtime defense too
      // (production code paths may receive untyped JSON from elsewhere).
      const invalid = {
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'denybare',
        decision: 'deny',
      } as unknown as Parameters<typeof writePermissionResponseFile>[0];
      await expect(writePermissionResponseFile(invalid)).rejects.toThrow();
    });

    it('deletePermissionRequestFile + deletePermissionResponseFile idempotent', async () => {
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'r1',
        toolName: 'Bash',
        toolInput: {},
        createdAt: 1,
      });
      await deletePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'r1',
      });
      await expect(
        deletePermissionRequestFile({
          stateDir,
          paneId: PANE_ID,
          sessionId: SID,
          requestId: 'r1',
        }),
      ).resolves.toBeUndefined();
      await expect(
        deletePermissionResponseFile({
          stateDir,
          paneId: PANE_ID,
          sessionId: SID,
          requestId: 'r-missing',
        }),
      ).resolves.toBeUndefined();
    });

    it('deletePermissionFileByPath unlinks at exact path', async () => {
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'r2',
        toolName: 'Edit',
        toolInput: {},
        createdAt: 0,
      });
      const path = permissionRequestPath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'r2',
      });
      await deletePermissionFileByPath(path);
      const after = await listPermissionRequestFiles({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
      });
      expect(after).toHaveLength(0);
    });

    it('listPermissionRequestFiles / listPermissionResponseFiles filter by pane+sid', async () => {
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'r1',
        toolName: 'Bash',
        toolInput: {},
        createdAt: 0,
      });
      await writePermissionResponseFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'r1',
        decision: 'allow',
        reason: 'ok',
      });
      // Different sid — should not appear.
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID2,
        requestId: 'r1',
        toolName: 'Bash',
        toolInput: {},
        createdAt: 0,
      });
      const reqs = await listPermissionRequestFiles({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
      });
      const ress = await listPermissionResponseFiles({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
      });
      expect(reqs).toHaveLength(1);
      expect(ress).toHaveLength(1);
    });
  });

  describe('listPendingPermissionRequests (daemon-wide)', () => {
    it('returns [] for an empty state dir', async () => {
      const got = await listPendingPermissionRequests(stateDir);
      expect(got).toEqual([]);
    });

    it('returns [] when state dir is missing (ENOENT)', async () => {
      const got = await listPendingPermissionRequests(
        join(stateDir, 'does-not-exist'),
      );
      expect(got).toEqual([]);
    });

    it('returns a single pending request with all metadata', async () => {
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'aabbccdd',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        createdAt: 1700000000000,
      });
      const got = await listPendingPermissionRequests(stateDir);
      expect(got).toEqual([
        {
          paneId: PANE_ID,
          sessionId: SID,
          requestId: 'aabbccdd',
          toolName: 'Bash',
          toolInput: { command: 'ls' },
          createdAt: 1700000000000,
        },
      ]);
    });

    it('excludes requests that already have a matching response (answered)', async () => {
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'answered1',
        toolName: 'Bash',
        toolInput: { command: 'rm' },
        createdAt: 1,
      });
      await writePermissionResponseFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'answered1',
        decision: 'allow',
        reason: 'ok',
      });
      const got = await listPendingPermissionRequests(stateDir);
      expect(got).toEqual([]);
    });

    it('matches response by (paneId, sessionId, requestId) triple — different pane keeps its request pending', async () => {
      // pane A has Request + Response → answered
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: '5ba51d',
        toolName: 'Bash',
        toolInput: {},
        createdAt: 1,
      });
      await writePermissionResponseFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: '5ba51d',
        decision: 'allow',
        reason: 'ok',
      });
      // pane B has Request only with the same requestId → still pending
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID2,
        sessionId: SID2,
        requestId: '5ba51d',
        toolName: 'Edit',
        toolInput: {},
        createdAt: 2,
      });
      const got = await listPendingPermissionRequests(stateDir);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({
        paneId: PANE_ID2,
        sessionId: SID2,
        requestId: '5ba51d',
        toolName: 'Edit',
      });
    });

    it('returns multiple pending requests sorted by createdAt ascending', async () => {
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: '07ee4',
        toolName: 'Edit',
        toolInput: {},
        createdAt: 2000,
      });
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID2,
        sessionId: SID2,
        requestId: '01de4',
        toolName: 'Bash',
        toolInput: {},
        createdAt: 1000,
      });
      const got = await listPendingPermissionRequests(stateDir);
      expect(got).toHaveLength(2);
      expect(got[0]?.requestId).toBe('01de4');
      expect(got[1]?.requestId).toBe('07ee4');
    });

    it('ignores unrelated files (Stop, IMWork, IMOrigin, daemon.pid, legacy)', async () => {
      // unrelated files
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: '2026-05-11T00-00-00-000Z',
        last_assistant_message: 'hi',
      });
      await writeIMWorkFile(stateDir, { auto: false });
      await writeIMOriginFile(stateDir, LARK_CTX);
      await writeDaemonPidFile({
        stateDir,
        pid: 12345,
        startedAt: 'Mon May 11 12:00:00 2026',
      });
      // one pending request
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'fee15',
        toolName: 'WebFetch',
        toolInput: { url: 'https://example.com' },
        createdAt: 42,
      });
      // Plus a stray file with a numeric-ish but non-matching name
      await writeFile(join(stateDir, 'random.txt'), 'noise');

      const got = await listPendingPermissionRequests(stateDir);
      expect(got).toHaveLength(1);
      expect(got[0]?.requestId).toBe('fee15');
    });
  });

  describe('IMWork file (top-level JSON, post-DD #64)', () => {
    it('writeIMWorkFile zero-arg writes {auto:false} JSON at top-level', async () => {
      await writeIMWorkFile(stateDir);
      const path = imWorkPath(stateDir);
      expect(path).toBe(join(stateDir, IM_WORK_FILE_NAME));
      const buf = await readFile(path, 'utf-8');
      expect(JSON.parse(buf)).toEqual({ auto: false });
    });

    it('writeIMWorkFile({auto:true}) writes {auto:true} JSON', async () => {
      await writeIMWorkFile(stateDir, { auto: true });
      const buf = await readFile(imWorkPath(stateDir), 'utf-8');
      expect(JSON.parse(buf)).toEqual({ auto: true });
    });

    it('readIMWorkFile returns null on ENOENT', async () => {
      expect(await readIMWorkFile(stateDir)).toBeNull();
    });

    it('readIMWorkFile returns {auto:false} for legacy 0-byte file (back-compat)', async () => {
      await writeFile(imWorkPath(stateDir), '');
      expect(await readIMWorkFile(stateDir)).toEqual({ auto: false });
    });

    it('readIMWorkFile round-trips JSON {auto:true} written by writeIMWorkFile', async () => {
      await writeIMWorkFile(stateDir, { auto: true });
      expect(await readIMWorkFile(stateDir)).toEqual({ auto: true });
    });

    it('readIMWorkFile throws on JSON corruption (loud failure, not silent default)', async () => {
      await writeFile(imWorkPath(stateDir), 'not-json');
      await expect(readIMWorkFile(stateDir)).rejects.toThrow();
    });

    it('readIMWorkFile throws on schema mismatch (e.g. future version with extra required field, or wrong type)', async () => {
      await writeFile(imWorkPath(stateDir), JSON.stringify({ auto: 'yes' }));
      await expect(readIMWorkFile(stateDir)).rejects.toThrow();
    });

    it('writeIMWorkFile rejects non-IMWorkFile-shape content via zod', async () => {
      await expect(
        writeIMWorkFile(stateDir, { auto: 'yes' } as unknown as { auto: boolean }),
      ).rejects.toThrow();
    });

    it('existsIMWorkFile / deleteIMWorkFile lifecycle', async () => {
      expect(await existsIMWorkFile(stateDir)).toBe(false);
      await writeIMWorkFile(stateDir);
      expect(await existsIMWorkFile(stateDir)).toBe(true);
      await deleteIMWorkFile(stateDir);
      expect(await existsIMWorkFile(stateDir)).toBe(false);
      // Idempotent.
      await expect(deleteIMWorkFile(stateDir)).resolves.toBeUndefined();
    });
  });

  describe('IMOrigin (daemon-global single file, post-DD #_imorigin_global_)', () => {
    it('imOriginPath uses top-level IMOrigin (no paneId)', () => {
      const path = imOriginPath(stateDir);
      expect(path).toBe(join(stateDir, IM_ORIGIN_FILE_NAME));
      expect(IM_ORIGIN_FILE_NAME).toBe('IMOrigin');
    });

    it('writeIMOriginFile + readIMOriginFile round-trip lark ctx', async () => {
      await writeIMOriginFile(stateDir, LARK_CTX);
      const got = await readIMOriginFile(stateDir);
      expect(got).toEqual(LARK_CTX);
    });

    it('writeIMOriginFile rejects ctx without imType discriminator', async () => {
      await expect(
        writeIMOriginFile(
          stateDir,
          { to: 'u', contextToken: 'x' } as unknown as IMReplyContext,
        ),
      ).rejects.toThrow();
    });

    it('writeIMOriginFile rejects unknown imType', async () => {
      await expect(
        writeIMOriginFile(
          stateDir,
          { imType: 'mystery', x: 1 } as unknown as IMReplyContext,
        ),
      ).rejects.toThrow();
    });

    it('readIMOriginFile returns null on ENOENT', async () => {
      expect(await readIMOriginFile(stateDir)).toBeNull();
    });

    it('readIMOriginFile throws on schema mismatch (corruption)', async () => {
      await writeFile(imOriginPath(stateDir), JSON.stringify({ no: 'imType' }));
      await expect(readIMOriginFile(stateDir)).rejects.toThrow();
    });

    it('latest-wins: second writeIMOriginFile overwrites first (modeling each inbound covers prior token)', async () => {
      await writeIMOriginFile(stateDir, {
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat_A',
      });
      await writeIMOriginFile(stateDir, {
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat_B',
      });
      const got = await readIMOriginFile(stateDir);
      expect(got).toEqual({
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat_B',
      });
    });

    it('existsIMOriginFile / deleteIMOriginFile lifecycle', async () => {
      expect(await existsIMOriginFile(stateDir)).toBe(false);
      await writeIMOriginFile(stateDir, LARK_CTX);
      expect(await existsIMOriginFile(stateDir)).toBe(true);
      await deleteIMOriginFile(stateDir);
      expect(await existsIMOriginFile(stateDir)).toBe(false);
      // Idempotent.
      await expect(deleteIMOriginFile(stateDir)).resolves.toBeUndefined();
    });
  });

  describe('daemon.pid', () => {
    it('writeDaemonPidFile + readDaemonPidFile round-trip', async () => {
      await writeDaemonPidFile({ stateDir, pid: 12345, startedAt: 'lstart-x' });
      const path = daemonPidPath(stateDir);
      expect(path).toBe(join(stateDir, DAEMON_PID_FILE_NAME));
      const got = await readDaemonPidFile(stateDir);
      expect(got).toEqual({ pid: 12345, startedAt: 'lstart-x' });
    });

    it('readDaemonPidFile returns null on ENOENT', async () => {
      expect(await readDaemonPidFile(stateDir)).toBeNull();
    });

    it('deleteDaemonPidFile idempotent', async () => {
      await expect(deleteDaemonPidFile(stateDir)).resolves.toBeUndefined();
    });

    it('captureProcessLstart returns a non-empty string for pid=process.pid', async () => {
      const got = await captureProcessLstart(process.pid);
      // ps -o lstart= returns something like "Tue May  4 16:38:00 2026" (>= 16 chars).
      expect(got).not.toBeNull();
      expect((got ?? '').length).toBeGreaterThanOrEqual(10);
    });

    it('captureProcessLstart returns null for very high (likely-dead) pid', async () => {
      const got = await captureProcessLstart(2_000_000_000);
      expect(got).toBeNull();
    });

    it('isDaemonAlive returns false when no pid file', async () => {
      expect(await isDaemonAlive(stateDir)).toBe(false);
    });

    it('isDaemonAlive returns true for the running test process', async () => {
      const lstart = (await captureProcessLstart(process.pid)) ?? 'unknown';
      await writeDaemonPidFile({
        stateDir,
        pid: process.pid,
        startedAt: lstart,
      });
      expect(await isDaemonAlive(stateDir)).toBe(true);
    });

    it('isDaemonAlive returns false on lstart mismatch (PID reuse defense)', async () => {
      await writeDaemonPidFile({
        stateDir,
        pid: process.pid,
        startedAt: 'wrong lstart string that will not match',
      });
      expect(await isDaemonAlive(stateDir)).toBe(false);
    });
  });

  describe('atomic write permissions (0600)', () => {
    it('writeIMOriginFile produces 0600 file', async () => {
      await writeIMOriginFile(stateDir, LARK_CTX);
      const st = await stat(imOriginPath(stateDir));
      // 0o777 is the rwx mask; check the lower bits == 0o600.
      expect(st.mode & 0o777).toBe(0o600);
    });
  });
});
