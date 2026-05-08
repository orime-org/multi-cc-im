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
  captureProcessLstart,
  writeDaemonPidFile,
  writeIMOriginFile,
  writeIMWorkFile,
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

    // Existing Stop tests assume the write path runs. After daemon liveness
    // DD #57, that requires IMWork on + IMOrigin set + daemon alive. Set
    // those once per test so each Stop test starts in the "forward path"
    // state. Tests for the new short-circuit guards live in their own
    // describe block below.
    beforeEach(async () => {
      await writeIMWorkFile(stateDir);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { to: 'wxid_owner', contextToken: 'tk-test' },
      });
      const lstart = await captureProcessLstart(process.pid);
      await writeDaemonPidFile({
        stateDir,
        pid: process.pid,
        startedAt: lstart!,
      });
    });

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

  describe('PreToolUse — IM permission gate (forward path)', () => {
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

    // Forward-path tests below require IMWork on + IMOrigin set for the sid
    // + daemon alive (E1/E2/E3/E4 must all pass to reach polling path).
    // We pretend the test process IS the daemon by writing daemon.pid with
    // the test's own pid + actual lstart — isDaemonAlive then returns true.
    beforeEach(async () => {
      await writeIMWorkFile(stateDir);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { to: 'wxid_owner', contextToken: 'tk-test' },
      });
      const lstart = await captureProcessLstart(process.pid);
      await writeDaemonPidFile({
        stateDir,
        pid: process.pid,
        startedAt: lstart!,
      });
    });

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

    it('clears pre-existing PermissionRequest/Response files for the same sid before writing the new one', async () => {
      // Mirrors the Stop branch's stale-cleanup behavior: a prior hook
      // subprocess that was killed mid-flow (or a daemon-down accumulation
      // of unread Response files) should not survive into the next round.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(stateDir, `${SID}.PermissionRequest.stale1.json`),
        '{"requestId":"stale1","toolName":"Bash","toolInput":{},"createdAt":0}',
      );
      await writeFile(
        join(stateDir, `${SID}.PermissionRequest.stale2.json`),
        '{"requestId":"stale2","toolName":"Bash","toolInput":{},"createdAt":0}',
      );
      await writeFile(
        join(stateDir, `${SID}.PermissionResponse.staleResp.json`),
        '{"requestId":"staleResp","decision":"allow","reason":"old"}',
      );

      // Run a fast-timeout PreToolUse so we observe end state quickly.
      await runHookReceiver({
        stateDir,
        payload: PRE_TOOL_USE,
        permissionPollIntervalMs: 10,
        permissionTimeoutMs: 50,
      });

      const entries = await readStateDirEntries(stateDir);
      // No `stale*` filenames remain; the just-written Request was also
      // cleaned at the timeout cleanup step → state dir is empty for this sid.
      expect(entries.filter((n) => n.includes('stale'))).toEqual([]);
      expect(
        entries.filter(
          (n) =>
            n.includes(PERMISSION_REQUEST_PREFIX) ||
            n.includes(PERMISSION_RESPONSE_PREFIX),
        ),
      ).toEqual([]);
    });

    it('only clears Permission files for the current sid, not others', async () => {
      const OTHER_SID = '99999999-3606-4fe4-b01d-cccccccccccc';
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(stateDir, `${OTHER_SID}.PermissionRequest.other1.json`),
        '{"requestId":"other1","toolName":"Bash","toolInput":{},"createdAt":0}',
      );

      await runHookReceiver({
        stateDir,
        payload: PRE_TOOL_USE,
        permissionPollIntervalMs: 10,
        permissionTimeoutMs: 50,
      });

      const entries = await readStateDirEntries(stateDir);
      // OTHER_SID's Request still there (sid-scoped sweep).
      expect(entries).toContain(`${OTHER_SID}.PermissionRequest.other1.json`);
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

  describe('PreToolUse — early-return paths (no Request file written)', () => {
    // These paths short-circuit BEFORE the polling loop. No PermissionRequest
    // file should ever appear, no daemon round-trip needed.

    function payloadWithTool(toolName: string): ParsedHookPayload {
      return {
        session_id: SID as never,
        transcript_path: TX as never,
        cwd: CWD as never,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: { foo: 'bar' },
        tool_use_id: 'tu_abc',
        permission_mode: 'default',
      } as ParsedHookPayload;
    }

    it('E1 read-only Read tool → permissionDecision: allow + reason "read-only" + no Request file', async () => {
      // Even with IMWork on + IMOrigin set (forward path conditions met),
      // read-only tools take precedence and bypass forward.
      await writeIMWorkFile(stateDir);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'tk' },
      });

      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Read'),
      });

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: '[multi-cc-im] read-only tool, auto-allow',
        },
      });
      // No Request file ever written
      const entries = await readStateDirEntries(stateDir);
      expect(entries.filter((n) => n.includes(PERMISSION_REQUEST_PREFIX))).toEqual([]);
    });

    it.each(['Read', 'Grep', 'Glob', 'NotebookRead'])(
      'E1 read-only tool %s → allow + no Request',
      async (toolName) => {
        const result = await runHookReceiver({
          stateDir,
          payload: payloadWithTool(toolName),
        });
        expect(
          (result as { hookSpecificOutput: { permissionDecision: string } })
            .hookSpecificOutput.permissionDecision,
        ).toBe('allow');
        const entries = await readStateDirEntries(stateDir);
        expect(entries.filter((n) => n.includes(PERMISSION_REQUEST_PREFIX))).toEqual([]);
      },
    );

    it('Bash is NOT in the read-only whitelist (E1 does not match) — falls through to E2/E3 or polling', async () => {
      // No IMWork → falls through E1 (Bash not whitelisted) to E2 (no IMWork → ask)
      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Bash'),
      });
      expect(
        (result as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } })
          .hookSpecificOutput.permissionDecision,
      ).toBe('ask');
      expect(
        (result as { hookSpecificOutput: { permissionDecisionReason: string } })
          .hookSpecificOutput.permissionDecisionReason,
      ).toContain('local mode');
    });

    it('E2 IMWork file missing → permissionDecision: ask + reason "local mode" + no Request file', async () => {
      // No IMWork file, no IMOrigin file
      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Bash'),
      });

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: '[multi-cc-im] local mode',
        },
      });
      const entries = await readStateDirEntries(stateDir);
      expect(entries.filter((n) => n.includes(PERMISSION_REQUEST_PREFIX))).toEqual([]);
    });

    it('E3 IMWork on but IMOrigin missing → permissionDecision: ask + reason "no IM thread" + no Request file', async () => {
      await writeIMWorkFile(stateDir);
      // Don't write IMOrigin

      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Bash'),
      });

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: '[multi-cc-im] no IM thread for this cc',
        },
      });
      const entries = await readStateDirEntries(stateDir);
      expect(entries.filter((n) => n.includes(PERMISSION_REQUEST_PREFIX))).toEqual([]);
    });

    it('E1 takes precedence over E2 / E3 (read-only allowed even when IMWork off)', async () => {
      // No IMWork, no IMOrigin — but Read tool wins by E1 first-check
      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Read'),
      });
      expect(
        (result as { hookSpecificOutput: { permissionDecision: string } })
          .hookSpecificOutput.permissionDecision,
      ).toBe('allow');
    });

    it('E2 takes precedence over E3 (IMWork off + IMOrigin set → still says local mode)', async () => {
      // IMOrigin set without IMWork — should still emit "local mode" not "no IM thread"
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'tk' },
      });
      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Bash'),
      });
      expect(
        (result as { hookSpecificOutput: { permissionDecisionReason: string } })
          .hookSpecificOutput.permissionDecisionReason,
      ).toContain('local mode');
    });

    it('E4 IMWork on + IMOrigin set + daemon dead → ask + reason "daemon not running" + no Request file', async () => {
      // All forward path conditions met EXCEPT daemon — daemon.pid points
      // at a non-existent PID.
      const { writeIMWorkFile, writeIMOriginFile } = await import('./state-files.js');
      await writeIMWorkFile(stateDir);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'tk' },
      });
      await writeDaemonPidFile({
        stateDir,
        pid: 999_999, // very unlikely to exist
        startedAt: 'whatever',
      });

      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Bash'),
      });

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: '[multi-cc-im] daemon not running',
        },
      });
      const entries = await readStateDirEntries(stateDir);
      expect(entries.filter((n) => n.includes(PERMISSION_REQUEST_PREFIX))).toEqual([]);
    });

    it('E4 daemon.pid exists but PID lstart mismatches → ask "daemon not running" (PID-reuse defense)', async () => {
      const { writeIMWorkFile, writeIMOriginFile } = await import('./state-files.js');
      await writeIMWorkFile(stateDir);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'tk' },
      });
      // Real PID but fake lstart — isDaemonAlive should reject.
      await writeDaemonPidFile({
        stateDir,
        pid: process.pid,
        startedAt: 'WRONG-LSTART-2020-01-01',
      });

      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Bash'),
      });

      expect(
        (result as { hookSpecificOutput: { permissionDecisionReason: string } })
          .hookSpecificOutput.permissionDecisionReason,
      ).toContain('daemon not running');
    });

    it('E1 takes precedence over E4 (read-only auto-allow even when daemon dead)', async () => {
      const { writeIMWorkFile, writeIMOriginFile } = await import('./state-files.js');
      await writeIMWorkFile(stateDir);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'tk' },
      });
      // No daemon.pid → daemon dead. But Read is read-only → E1 wins.
      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Read'),
      });
      expect(
        (result as { hookSpecificOutput: { permissionDecision: string } })
          .hookSpecificOutput.permissionDecision,
      ).toBe('allow');
    });

    it('E2 takes precedence over E4 (IMWork off → "local mode" not "daemon not running")', async () => {
      // No IMWork; daemon also dead. E2 fires first.
      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Bash'),
      });
      expect(
        (result as { hookSpecificOutput: { permissionDecisionReason: string } })
          .hookSpecificOutput.permissionDecisionReason,
      ).toContain('local mode');
    });

    it('E3 takes precedence over E4 (IMWork on, no IMOrigin → "no IM thread" not "daemon not running")', async () => {
      const { writeIMWorkFile } = await import('./state-files.js');
      await writeIMWorkFile(stateDir);
      // No IMOrigin; no daemon.pid. E3 fires first.
      const result = await runHookReceiver({
        stateDir,
        payload: payloadWithTool('Bash'),
      });
      expect(
        (result as { hookSpecificOutput: { permissionDecisionReason: string } })
          .hookSpecificOutput.permissionDecisionReason,
      ).toContain('no IM thread');
    });
  });

  describe('Stop — short-circuit guards (E1/E2/E3 before write)', () => {
    const STOP_PAYLOAD: ParsedHookPayload = {
      session_id: SID as never,
      transcript_path: TX as never,
      cwd: CWD as never,
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: 'reply text',
    };

    it('E1 !IMWork → return void, do NOT write <sid>.Stop.<ts>', async () => {
      // IMWork file missing
      const result = await runHookReceiver({
        stateDir,
        payload: STOP_PAYLOAD,
      });
      expect(result).toBeUndefined();
      const stops = await listStopFiles({ stateDir, sessionId: SID });
      expect(stops).toEqual([]);
    });

    it('E2 IMWork on but no IMOrigin → return void, do NOT write Stop file', async () => {
      const { writeIMWorkFile } = await import('./state-files.js');
      await writeIMWorkFile(stateDir);
      // No IMOrigin

      const result = await runHookReceiver({
        stateDir,
        payload: STOP_PAYLOAD,
      });
      expect(result).toBeUndefined();
      const stops = await listStopFiles({ stateDir, sessionId: SID });
      expect(stops).toEqual([]);
    });

    it('E3 IMWork + IMOrigin set but daemon dead → return void, do NOT write Stop file', async () => {
      const { writeIMWorkFile, writeIMOriginFile } = await import('./state-files.js');
      await writeIMWorkFile(stateDir);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'tk' },
      });
      await writeDaemonPidFile({
        stateDir,
        pid: 999_999,
        startedAt: 'whatever',
      });

      const result = await runHookReceiver({
        stateDir,
        payload: STOP_PAYLOAD,
      });
      expect(result).toBeUndefined();
      const stops = await listStopFiles({ stateDir, sessionId: SID });
      expect(stops).toEqual([]);
    });

    it('all 3 guards pass → write Stop file (forward path)', async () => {
      const { writeIMWorkFile, writeIMOriginFile } = await import('./state-files.js');
      await writeIMWorkFile(stateDir);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'tk' },
      });
      const lstart = await captureProcessLstart(process.pid);
      await writeDaemonPidFile({
        stateDir,
        pid: process.pid,
        startedAt: lstart!,
      });

      await runHookReceiver({
        stateDir,
        payload: STOP_PAYLOAD,
        now: () => new Date('2026-05-09T10:00:00.000Z'),
      });

      const stops = await listStopFiles({ stateDir, sessionId: SID });
      expect(stops).toHaveLength(1);
      const content = await readStopFile(stops[0]!);
      expect(content).toEqual({ last_assistant_message: 'reply text' });
    });

    it('!IMWork preserves existing Stop files (does not sweep — write path skipped entirely)', async () => {
      // Pre-existing Stop file from earlier IM mode session — when user
      // runs /stop and cc keeps replying, we don't actively delete prior
      // Stop files; they're cleaned by daemon-start sweep on next reboot.
      const tOld = '2026-05-08T10-00-00-000Z';
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: tOld,
        last_assistant_message: 'old',
      });
      // No IMWork → E1 short-circuits

      await runHookReceiver({
        stateDir,
        payload: STOP_PAYLOAD,
      });

      const stops = await listStopFiles({ stateDir, sessionId: SID });
      expect(stops).toHaveLength(1);
      expect(stops[0]).toContain(tOld);
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
      // Stop write path requires IMWork + IMOrigin + daemon alive (DD #57).
      await writeIMWorkFile(stateDir);
      await writeIMOriginFile({
        stateDir,
        sessionId: SID,
        replyCtx: { contextToken: 'tk' },
      });
      const lstart = await captureProcessLstart(process.pid);
      await writeDaemonPidFile({
        stateDir,
        pid: process.pid,
        startedAt: lstart!,
      });

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
