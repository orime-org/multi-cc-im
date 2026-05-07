import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHookReceiver } from './hook-receiver.js';
import {
  PERMISSION_REQUEST_PREFIX,
  PERMISSION_RESPONSE_PREFIX,
  STOP_PREFIX,
  existsSessionEndFile,
  formatStopTimestamp,
  listStopFiles,
  readPermissionRequestFile,
  readSessionStartFile,
  readStopFile,
  sessionStartPath,
  stopFilePath,
  writePermissionResponseFile,
  writeSessionEndFile,
  writeStopFile,
} from './state-files.js';
import { enqueueInjection } from './injection-queue.js';
import type { ParsedHookPayload } from './payloads.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const TX = '/Users/x/.claude/projects/-private-tmp/91215578.jsonl';
const CWD = '/private/tmp/cc-probe';

const SESSION_START: ParsedHookPayload = {
  session_id: SID as never,
  transcript_path: TX as never,
  cwd: CWD as never,
  hook_event_name: 'SessionStart',
  source: 'startup',
  model: 'claude-opus-4-7[1m]',
};

const STOP: ParsedHookPayload = {
  session_id: SID as never,
  transcript_path: TX as never,
  cwd: CWD as never,
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: 'hi',
};

const STOP_ACTIVE: ParsedHookPayload = {
  ...STOP,
  hook_event_name: 'Stop',
  stop_hook_active: true,
} as ParsedHookPayload;

const SESSION_END: ParsedHookPayload = {
  session_id: SID as never,
  transcript_path: TX as never,
  cwd: CWD as never,
  hook_event_name: 'SessionEnd',
  reason: '/exit',
};

const STUB_CAPTURE = async () => ({
  pid: 12345,
  startedAt: 'Tue May  4 16:38:00 2026',
});

/** Helper: list every file directly under stateDir (no recursion). */
async function readStateDirEntries(stateDir: string): Promise<string[]> {
  try {
    return await readdir(stateDir);
  } catch {
    return [];
  }
}

describe('runHookReceiver', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-cc-recv-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  describe('SessionStart', () => {
    it('writes <sid>.SessionStart with cwd + transcript_path from payload + captured pid/startedAt', async () => {
      await runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: STUB_CAPTURE,
      });
      expect(
        await readSessionStartFile({ stateDir, sessionId: SID }),
      ).toEqual({
        pid: 12345,
        startedAt: 'Tue May  4 16:38:00 2026',
        cwd: CWD,
        transcript_path: TX,
      });
    });

    it('respects injected paneId from capturePid stub', async () => {
      await runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: async () => ({
          pid: 12345,
          startedAt: 'Tue May  4 16:38:00 2026',
          paneId: 42,
        }),
      });
      const result = await readSessionStartFile({ stateDir, sessionId: SID });
      expect(result?.paneId).toBe(42);
    });

    it('omits paneId when capturePid returns paneId=undefined (cc outside wezterm)', async () => {
      await runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: async () => ({
          pid: 12345,
          startedAt: 'Tue May  4 16:38:00 2026',
          paneId: undefined,
        }),
      });
      const result = await readSessionStartFile({ stateDir, sessionId: SID });
      expect(result?.paneId).toBeUndefined();
      expect(result?.pid).toBe(12345);
    });

    it('RESUME: pre-existing <sid>.SessionEnd is deleted before write', async () => {
      // Simulate: previous lifecycle ended; tombstone left behind.
      await writeSessionEndFile({ stateDir, sessionId: SID });
      expect(
        await existsSessionEndFile({ stateDir, sessionId: SID }),
      ).toBe(true);

      await runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: STUB_CAPTURE,
      });

      // SessionEnd cleared, fresh SessionStart present.
      expect(
        await existsSessionEndFile({ stateDir, sessionId: SID }),
      ).toBe(false);
      const result = await readSessionStartFile({ stateDir, sessionId: SID });
      expect(result?.pid).toBe(12345);
    });

    it('RESUME: pre-existing <sid>.Stop.* files are all deleted before write', async () => {
      // Drop 3 stale Stop files — all should be cleaned.
      const timestamps = [
        '2026-05-06T16-20-15-123Z',
        '2026-05-06T16-20-16-000Z',
        '2026-05-06T16-20-17-456Z',
      ];
      for (const timestamp of timestamps) {
        await writeStopFile({
          stateDir,
          sessionId: SID,
          timestamp,
          last_assistant_message: `stale-${timestamp}`,
        });
      }
      expect(
        (await listStopFiles({ stateDir, sessionId: SID })).length,
      ).toBe(3);

      await runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: STUB_CAPTURE,
      });

      expect(
        await listStopFiles({ stateDir, sessionId: SID }),
      ).toEqual([]);
      const result = await readSessionStartFile({ stateDir, sessionId: SID });
      expect(result?.pid).toBe(12345);
    });

    it('RESUME with both stale SessionEnd + Stop files: all cleaned, fresh SessionStart written', async () => {
      await writeSessionEndFile({ stateDir, sessionId: SID });
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: '2026-05-06T16-20-15-123Z',
        last_assistant_message: 'stale',
      });

      await runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: STUB_CAPTURE,
      });

      expect(
        await existsSessionEndFile({ stateDir, sessionId: SID }),
      ).toBe(false);
      expect(
        await listStopFiles({ stateDir, sessionId: SID }),
      ).toEqual([]);
      expect(
        await readSessionStartFile({ stateDir, sessionId: SID }),
      ).not.toBeNull();
    });

    it('SessionStart with capturePid throwing surfaces the error and writes nothing', async () => {
      await expect(
        runHookReceiver({
          stateDir,
          payload: SESSION_START,
          capturePid: async () => {
            throw new Error('ps lstart failed');
          },
        }),
      ).rejects.toThrow(/ps lstart failed/);
      expect(
        await readSessionStartFile({ stateDir, sessionId: SID }),
      ).toBeNull();
    });
  });

  describe('Stop', () => {
    const FIXED_NOW = new Date('2026-05-06T16:20:15.123Z');
    const FIXED_TS = formatStopTimestamp(FIXED_NOW);

    it('writes <sid>.Stop.<ts> with last_assistant_message using injected now()', async () => {
      const result = await runHookReceiver({
        stateDir,
        payload: STOP,
        now: () => FIXED_NOW,
      });
      expect(result).toBeUndefined();
      const path = stopFilePath({
        stateDir,
        sessionId: SID,
        timestamp: FIXED_TS,
      });
      expect(await readStopFile(path)).toEqual({
        last_assistant_message: 'hi',
      });
    });

    it('stop_hook_active=true: writes Stop file BUT skips injection-queue check (returns void)', async () => {
      await enqueueInjection({
        stateDir,
        sessionId: SID,
        content: 'should-not-be-popped',
      });
      const result = await runHookReceiver({
        stateDir,
        payload: STOP_ACTIVE,
        now: () => FIXED_NOW,
      });
      expect(result).toBeUndefined();
      // Stop file still created
      const path = stopFilePath({
        stateDir,
        sessionId: SID,
        timestamp: FIXED_TS,
      });
      expect(await readStopFile(path)).toEqual({
        last_assistant_message: 'hi',
      });
      // Queue still holds the injection — next normal Stop will pop it.
      const followUp = await runHookReceiver({
        stateDir,
        payload: STOP,
        now: () => new Date('2026-05-06T16:20:16.000Z'),
      });
      expect(followUp).toEqual({
        decision: 'block',
        reason: 'should-not-be-popped',
      });
    });

    it('stop_hook_active=false + empty queue: writes Stop file, returns void', async () => {
      const result = await runHookReceiver({
        stateDir,
        payload: STOP,
        now: () => FIXED_NOW,
      });
      expect(result).toBeUndefined();
      const path = stopFilePath({
        stateDir,
        sessionId: SID,
        timestamp: FIXED_TS,
      });
      expect(await readStopFile(path)).not.toBeNull();
    });

    it('stop_hook_active=false + pending injection: writes Stop file AND returns decision:block', async () => {
      await enqueueInjection({
        stateDir,
        sessionId: SID,
        content: 'follow-up prompt',
      });
      const result = await runHookReceiver({
        stateDir,
        payload: STOP,
        now: () => FIXED_NOW,
      });
      expect(result).toEqual({
        decision: 'block',
        reason: 'follow-up prompt',
      });
      // Stop file still written regardless of injection-queue outcome.
      const path = stopFilePath({
        stateDir,
        sessionId: SID,
        timestamp: FIXED_TS,
      });
      expect(await readStopFile(path)).toEqual({
        last_assistant_message: 'hi',
      });
    });

    it('multiple Stop calls: only the latest survives (each call clears stale Stop files for the same sid)', async () => {
      // Symmetric with SessionStart's resume cleanup. Daemon-up case: each
      // Stop is unlinked by the daemon ~100ms after write, so this listFiles
      // loop is a no-op. Daemon-down case: previous Stop files lingered;
      // they're cleaned here. Either way, after multiple Stop hooks fire,
      // state/ contains exactly the latest Stop file.
      const t1 = new Date('2026-05-06T16:20:15.123Z');
      const t2 = new Date('2026-05-06T16:20:16.000Z');
      const t3 = new Date('2026-05-06T16:20:17.456Z');
      await runHookReceiver({ stateDir, payload: STOP, now: () => t1 });
      await runHookReceiver({ stateDir, payload: STOP, now: () => t2 });
      await runHookReceiver({ stateDir, payload: STOP, now: () => t3 });
      const files = await listStopFiles({ stateDir, sessionId: SID });
      expect(files).toHaveLength(1);
      expect(files[0]).toContain(formatStopTimestamp(t3));
    });

    it('clears pre-existing Stop files for the same sid before writing the new one', async () => {
      // Simulate a daemon-down scenario where multiple Stop files
      // accumulated for this sid. The next Stop hook fire should clean them.
      const tOld1 = '2026-05-06T16-20-15-123Z';
      const tOld2 = '2026-05-06T16-20-16-000Z';
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: tOld1,
        last_assistant_message: 'old reply 1',
      });
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: tOld2,
        last_assistant_message: 'old reply 2',
      });
      expect(
        (await listStopFiles({ stateDir, sessionId: SID })).length,
      ).toBe(2);

      const tNew = new Date('2026-05-06T16:20:30.000Z');
      await runHookReceiver({ stateDir, payload: STOP, now: () => tNew });

      const files = await listStopFiles({ stateDir, sessionId: SID });
      expect(files).toHaveLength(1);
      expect(files[0]).toContain(formatStopTimestamp(tNew));
    });

    it('only clears Stop files for the current sid, not others', async () => {
      // Defensive: ensure the stale-cleanup is sid-scoped so concurrent cc
      // sessions don't accidentally drop each other's pending Stop files.
      const OTHER_SID = '99999999-3606-4fe4-b01d-bbbbbbbbbbbb';
      await writeStopFile({
        stateDir,
        sessionId: OTHER_SID,
        timestamp: '2026-05-06T16-20-15-123Z',
        last_assistant_message: 'other cc reply',
      });

      await runHookReceiver({
        stateDir,
        payload: STOP,
        now: () => new Date('2026-05-06T16:20:30.000Z'),
      });

      // SID got a new Stop, OTHER_SID's was untouched.
      expect(
        (await listStopFiles({ stateDir, sessionId: SID })).length,
      ).toBe(1);
      expect(
        (await listStopFiles({ stateDir, sessionId: OTHER_SID })).length,
      ).toBe(1);
    });
  });

  describe('PreToolUse — IM permission gate', () => {
    const PRE_TOOL_USE: ParsedHookPayload = {
      session_id: SID as never,
      transcript_path: TX as never,
      cwd: CWD as never,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi', description: 'greet' },
      tool_use_id: 'tu_abc',
      permission_mode: 'default',
    } as ParsedHookPayload;

    it('writes <sid>.PermissionRequest.<id>.json with tool_name + tool_input', async () => {
      // Use a short timeout so we're not blocked. Daemon writes Response
      // shortly after; here we drop the Response in-line before the loop
      // ticks so the test stays deterministic.
      let observedRequestId: string | null = null;

      // Race: simultaneously start the hook AND poll for the request file
      // so we can capture the requestId, then write the matching response.
      const hookPromise = runHookReceiver({
        stateDir,
        payload: PRE_TOOL_USE,
        permissionPollIntervalMs: 5,
        permissionTimeoutMs: 2_000,
      });

      // Poll for the request file (≤200ms)
      for (let i = 0; i < 40; i++) {
        const entries = await readStateDirEntries(stateDir);
        const reqFile = entries.find((n) =>
          n.startsWith(`${SID}${PERMISSION_REQUEST_PREFIX}`),
        );
        if (reqFile) {
          // Filename: <sid>.PermissionRequest.<id>.json
          const m = reqFile.match(
            new RegExp(`^${SID}\\${PERMISSION_REQUEST_PREFIX}([^.]+)\\.json$`),
          );
          if (m) observedRequestId = m[1] ?? null;
          // Verify content
          const content = await readPermissionRequestFile(
            join(stateDir, reqFile),
          );
          expect(content?.toolName).toBe('Bash');
          expect(content?.toolInput).toEqual({
            command: 'echo hi',
            description: 'greet',
          });
          expect(content?.requestId).toBe(observedRequestId);
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(observedRequestId).not.toBeNull();

      // Drop the matching Response
      await writePermissionResponseFile({
        stateDir,
        sessionId: SID,
        requestId: observedRequestId!,
        decision: 'allow',
        reason: 'IM user allowed',
      });

      const result = await hookPromise;
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'IM user allowed',
        },
      });
    });

    it('Response with decision=deny → returns deny + reason', async () => {
      const hookPromise = runHookReceiver({
        stateDir,
        payload: PRE_TOOL_USE,
        permissionPollIntervalMs: 5,
        permissionTimeoutMs: 2_000,
      });

      // Wait for request file, capture requestId, write deny
      let requestId: string | null = null;
      for (let i = 0; i < 40 && requestId === null; i++) {
        const entries = await readStateDirEntries(stateDir);
        const reqFile = entries.find((n) =>
          n.startsWith(`${SID}${PERMISSION_REQUEST_PREFIX}`),
        );
        if (reqFile) {
          const m = reqFile.match(
            new RegExp(`^${SID}\\${PERMISSION_REQUEST_PREFIX}([^.]+)\\.json$`),
          );
          requestId = m?.[1] ?? null;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(requestId).not.toBeNull();

      await writePermissionResponseFile({
        stateDir,
        sessionId: SID,
        requestId: requestId!,
        decision: 'deny',
        reason: 'user said no',
      });

      const result = await hookPromise;
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'user said no',
        },
      });
    });

    it('timeout (no Response) → default allow + timeout reason', async () => {
      // Deliberately no Response written. With 100ms timeout the hook
      // exits cleanly with the default-allow decision.
      const result = await runHookReceiver({
        stateDir,
        payload: PRE_TOOL_USE,
        permissionPollIntervalMs: 10,
        permissionTimeoutMs: 100,
      });
      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: expect.stringMatching(/timeout.*allow/i),
        },
      });
    });

    it('cleans up Request + Response files on success path', async () => {
      const hookPromise = runHookReceiver({
        stateDir,
        payload: PRE_TOOL_USE,
        permissionPollIntervalMs: 5,
        permissionTimeoutMs: 2_000,
      });

      let requestId: string | null = null;
      for (let i = 0; i < 40 && requestId === null; i++) {
        const entries = await readStateDirEntries(stateDir);
        const reqFile = entries.find((n) =>
          n.startsWith(`${SID}${PERMISSION_REQUEST_PREFIX}`),
        );
        if (reqFile) {
          const m = reqFile.match(
            new RegExp(`^${SID}\\${PERMISSION_REQUEST_PREFIX}([^.]+)\\.json$`),
          );
          requestId = m?.[1] ?? null;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      await writePermissionResponseFile({
        stateDir,
        sessionId: SID,
        requestId: requestId!,
        decision: 'allow',
        reason: 'IM user allowed',
      });
      await hookPromise;

      const entries = await readStateDirEntries(stateDir);
      // Both files removed. Nothing matches PermissionRequest./PermissionResponse. prefixes.
      expect(
        entries.filter(
          (n) =>
            n.includes(PERMISSION_REQUEST_PREFIX) ||
            n.includes(PERMISSION_RESPONSE_PREFIX),
        ),
      ).toEqual([]);
    });

    it('cleans up Request file on timeout path (no Response was written)', async () => {
      await runHookReceiver({
        stateDir,
        payload: PRE_TOOL_USE,
        permissionPollIntervalMs: 10,
        permissionTimeoutMs: 100,
      });
      const entries = await readStateDirEntries(stateDir);
      expect(
        entries.filter((n) => n.includes(PERMISSION_REQUEST_PREFIX)),
      ).toEqual([]);
    });
  });

  describe('SessionEnd', () => {
    it('writes 0-byte <sid>.SessionEnd tombstone, returns void', async () => {
      const result = await runHookReceiver({
        stateDir,
        payload: SESSION_END,
      });
      expect(result).toBeUndefined();
      expect(
        await existsSessionEndFile({ stateDir, sessionId: SID }),
      ).toBe(true);
      // Empty (0 bytes).
      const stats = await stat(join(stateDir, `${SID}.SessionEnd`));
      expect(stats.size).toBe(0);
    });
  });

  describe('legacy state files are NOT written under any branch', () => {
    // Old design wrote <sid>.cc-pid / <sid>.ended / <sid>.last-hook-at /
    // <sid>.events.jsonl. None of these should appear after the rewrite.
    const LEGACY_SUFFIXES = [
      '.cc-pid',
      '.ended',
      '.last-hook-at',
      '.events.jsonl',
    ];

    async function assertNoLegacy(): Promise<void> {
      const entries = await readStateDirEntries(stateDir);
      const offenders = entries.filter((name) =>
        LEGACY_SUFFIXES.some((suffix) => name.endsWith(suffix)),
      );
      expect(offenders).toEqual([]);
    }

    it('SessionStart branch writes no legacy state files', async () => {
      await runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: STUB_CAPTURE,
      });
      await assertNoLegacy();
    });

    it('Stop branch writes no legacy state files', async () => {
      await runHookReceiver({
        stateDir,
        payload: STOP,
        now: () => new Date('2026-05-06T16:20:15.123Z'),
      });
      await assertNoLegacy();
      // And verify the Stop file is the new STOP_PREFIX form.
      const entries = await readStateDirEntries(stateDir);
      const stopFiles = entries.filter((n) => n.includes(STOP_PREFIX));
      expect(stopFiles).toHaveLength(1);
    });

    it('SessionEnd branch writes no legacy state files', async () => {
      await runHookReceiver({ stateDir, payload: SESSION_END });
      await assertNoLegacy();
    });
  });

  describe('SessionStart fresh path produces the canonical file location', () => {
    it('the file is written at sessionStartPath()', async () => {
      await runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: STUB_CAPTURE,
      });
      const expectedPath = sessionStartPath({ stateDir, sessionId: SID });
      const stats = await stat(expectedPath);
      expect(stats.isFile()).toBe(true);
    });
  });
});
