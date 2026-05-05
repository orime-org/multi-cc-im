import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHookReceiver } from './hook-receiver.js';
import {
  readCcPid,
  readEnded,
  readLastHookAt,
} from './state-files.js';
import { enqueueInjection } from './injection-queue.js';
import { resolveEventsLogPath } from './events-log.js';
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

const USER_PROMPT_SUBMIT: ParsedHookPayload = {
  session_id: SID as never,
  transcript_path: TX as never,
  cwd: CWD as never,
  hook_event_name: 'UserPromptSubmit',
  permission_mode: 'default',
  prompt: 'hi',
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

describe('runHookReceiver', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-cc-recv-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  const stubCapturePid = async () => ({
    pid: 12345,
    startedAt: 'Tue May  4 16:38:00 2026',
  });

  it('SessionStart → writes cc-pid file with captured pid + startedAt + cwd from payload', async () => {
    await runHookReceiver({
      stateDir,
      payload: SESSION_START,
      capturePid: stubCapturePid,
    });
    expect(await readCcPid({ stateDir, sessionId: SID })).toEqual({
      pid: 12345,
      startedAt: 'Tue May  4 16:38:00 2026',
      cwd: CWD,
    });
  });

  it('SessionStart → captures paneId when WEZTERM_PANE is set', async () => {
    await runHookReceiver({
      stateDir,
      payload: SESSION_START,
      capturePid: async () => ({
        pid: 12345,
        startedAt: 'Tue May  4 16:38:00 2026',
        paneId: 42,
      }),
    });
    expect(await readCcPid({ stateDir, sessionId: SID })).toEqual({
      pid: 12345,
      startedAt: 'Tue May  4 16:38:00 2026',
      paneId: 42,
      cwd: CWD,
    });
  });

  it('SessionStart → omits paneId when WEZTERM_PANE not set (cc outside wezterm)', async () => {
    await runHookReceiver({
      stateDir,
      payload: SESSION_START,
      capturePid: async () => ({
        pid: 12345,
        startedAt: 'Tue May  4 16:38:00 2026',
        paneId: undefined,
      }),
    });
    const result = await readCcPid({ stateDir, sessionId: SID });
    expect(result?.paneId).toBeUndefined();
    expect(result?.pid).toBe(12345);
  });

  it('SessionStart → also touches last-hook-at', async () => {
    const before = Date.now();
    await runHookReceiver({
      stateDir,
      payload: SESSION_START,
      capturePid: stubCapturePid,
    });
    const ts = await readLastHookAt({ stateDir, sessionId: SID });
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('SessionEnd → writes ended file with reason', async () => {
    await runHookReceiver({ stateDir, payload: SESSION_END });
    const ended = await readEnded({ stateDir, sessionId: SID });
    expect(ended?.reason).toBe('/exit');
    expect(typeof ended?.endedAt).toBe('number');
  });

  it('SessionEnd → also touches last-hook-at', async () => {
    const before = Date.now();
    await runHookReceiver({ stateDir, payload: SESSION_END });
    const ts = await readLastHookAt({ stateDir, sessionId: SID });
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('UserPromptSubmit / Stop → only touch last-hook-at (no other state files)', async () => {
    await runHookReceiver({ stateDir, payload: USER_PROMPT_SUBMIT });
    expect(await readCcPid({ stateDir, sessionId: SID })).toBeNull();
    expect(await readEnded({ stateDir, sessionId: SID })).toBeNull();
    expect(await readLastHookAt({ stateDir, sessionId: SID })).toBeGreaterThan(0);

    await runHookReceiver({ stateDir, payload: STOP });
    expect(await readCcPid({ stateDir, sessionId: SID })).toBeNull();
    expect(await readEnded({ stateDir, sessionId: SID })).toBeNull();
  });

  it('SessionStart with capturePid throwing surfaces the error (caller logs to stderr + exits non-zero)', async () => {
    await expect(
      runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: async () => {
          throw new Error('ps lstart failed');
        },
      }),
    ).rejects.toThrow(/ps lstart failed/);
    // cc-pid file must NOT exist on failure (no half-written state)
    expect(await readCcPid({ stateDir, sessionId: SID })).toBeNull();
  });

  it('SessionStart without capturePid stub uses defaultCapturePid (real `ps -o lstart=`)', async () => {
    // Integration test: verify defaultCapturePid actually works on the host.
    // Test runner's process.ppid is some real OS process — `ps` will find it.
    await runHookReceiver({ stateDir, payload: SESSION_START });
    const result = await readCcPid({ stateDir, sessionId: SID });
    expect(result).not.toBeNull();
    expect(result?.pid).toBe(process.ppid);
    // lstart format varies (macOS: `Tue May  4 16:38:00 2026`; Linux similar)
    // — just check non-empty.
    expect(result?.startedAt.length).toBeGreaterThan(0);
  });

  it('multiple sequential hooks update last-hook-at monotonically', async () => {
    await runHookReceiver({
      stateDir,
      payload: SESSION_START,
      capturePid: stubCapturePid,
    });
    const t1 = (await readLastHookAt({ stateDir, sessionId: SID })) ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    await runHookReceiver({ stateDir, payload: USER_PROMPT_SUBMIT });
    const t2 = (await readLastHookAt({ stateDir, sessionId: SID })) ?? 0;
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  describe('events.jsonl append side-effect', () => {
    it('every hook event appends to <sid>.events.jsonl', async () => {
      await runHookReceiver({ stateDir, payload: USER_PROMPT_SUBMIT });
      await runHookReceiver({ stateDir, payload: STOP });
      const filePath = resolveEventsLogPath({ stateDir, sessionId: SID });
      const lines = (await readFile(filePath, 'utf-8'))
        .trim()
        .split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).hook_event_name).toBe('UserPromptSubmit');
      expect(JSON.parse(lines[1]!).hook_event_name).toBe('Stop');
    });

    it('SessionStart and SessionEnd also append events.jsonl (not just state files)', async () => {
      await runHookReceiver({
        stateDir,
        payload: SESSION_START,
        capturePid: stubCapturePid,
      });
      await runHookReceiver({ stateDir, payload: SESSION_END });
      const filePath = resolveEventsLogPath({ stateDir, sessionId: SID });
      const lines = (await readFile(filePath, 'utf-8'))
        .trim()
        .split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).hook_event_name).toBe('SessionStart');
      expect(JSON.parse(lines[1]!).hook_event_name).toBe('SessionEnd');
    });
  });

  describe('Stop hook injection-queue', () => {
    it('Stop with stop_hook_active=false + queued injection → returns decision:block', async () => {
      await enqueueInjection({
        stateDir,
        sessionId: SID,
        content: 'follow-up prompt',
      });
      const result = await runHookReceiver({ stateDir, payload: STOP });
      expect(result).toEqual({
        decision: 'block',
        reason: 'follow-up prompt',
      });
    });

    it('Stop with stop_hook_active=false + empty queue → returns void (no decision)', async () => {
      const result = await runHookReceiver({ stateDir, payload: STOP });
      expect(result).toBeUndefined();
    });

    it('Stop with stop_hook_active=TRUE + queued injection → returns void (anti-loop guard)', async () => {
      await enqueueInjection({
        stateDir,
        sessionId: SID,
        content: 'should-not-be-popped',
      });
      const result = await runHookReceiver({
        stateDir,
        payload: STOP_ACTIVE,
      });
      expect(result).toBeUndefined();
    });

    it('Stop with stop_hook_active=TRUE leaves queue intact for next normal Stop', async () => {
      await enqueueInjection({ stateDir, sessionId: SID, content: 'still-queued' });
      await runHookReceiver({ stateDir, payload: STOP_ACTIVE });
      // Subsequent normal Stop should pop the still-queued injection
      const result = await runHookReceiver({ stateDir, payload: STOP });
      expect(result).toEqual({ decision: 'block', reason: 'still-queued' });
    });

    it('FIFO across multiple Stop fires: each pops oldest first', async () => {
      await enqueueInjection({ stateDir, sessionId: SID, content: 'a' });
      await enqueueInjection({ stateDir, sessionId: SID, content: 'b' });
      const r1 = await runHookReceiver({ stateDir, payload: STOP });
      const r2 = await runHookReceiver({ stateDir, payload: STOP });
      const r3 = await runHookReceiver({ stateDir, payload: STOP });
      expect(r1).toEqual({ decision: 'block', reason: 'a' });
      expect(r2).toEqual({ decision: 'block', reason: 'b' });
      expect(r3).toBeUndefined();
    });

    it('Non-Stop events ignore the injection queue (e.g. UserPromptSubmit)', async () => {
      await enqueueInjection({ stateDir, sessionId: SID, content: 'x' });
      const result = await runHookReceiver({
        stateDir,
        payload: USER_PROMPT_SUBMIT,
      });
      expect(result).toBeUndefined();
      // Queue should still hold 'x' for future Stop.
      const stopResult = await runHookReceiver({ stateDir, payload: STOP });
      expect(stopResult).toEqual({ decision: 'block', reason: 'x' });
    });
  });
});
