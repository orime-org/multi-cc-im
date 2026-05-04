import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHookReceiver } from './hook-receiver.js';
import {
  readCcPid,
  readEnded,
  readLastHookAt,
} from './state-files.js';
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

  it('SessionStart → writes cc-pid file with captured pid + startedAt', async () => {
    await runHookReceiver({
      stateDir,
      payload: SESSION_START,
      capturePid: stubCapturePid,
    });
    expect(await readCcPid({ stateDir, sessionId: SID })).toEqual({
      pid: 12345,
      startedAt: 'Tue May  4 16:38:00 2026',
    });
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
});
