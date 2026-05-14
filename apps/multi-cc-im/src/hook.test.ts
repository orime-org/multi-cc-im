import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureProcessLstart,
  enqueueInjection,
  writeDaemonPidFile,
  writeIMOriginFile,
  writeIMWorkFile,
} from '@multi-cc-im/cli-cc';
import type { PaneId } from '@multi-cc-im/shared';
import { runHookCommand } from './hook.js';

const SID = '11111111-3606-4fe4-b01d-aaaaaaaaaaaa';
const TX = '/Users/x/.claude/projects/-private-tmp/abc.jsonl';
const CWD = '/private/tmp/cc-probe';
const PANE_ID = 42 as unknown as PaneId;

const PRE_TOOL_USE_BASH = JSON.stringify({
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'PreToolUse',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'toolu_abc',
});

const STOP = JSON.stringify({
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: 'hi',
});

const STOP_ACTIVE = JSON.stringify({
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: true,
  last_assistant_message: 'awakened',
});

describe('runHookCommand', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'hook-cli-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Helper: set up IMWork + global IMOrigin + daemon.pid so Stop / PreToolUse
   * pass the 3 short-circuit guards and exercise the forward path. */
  async function setupBoundState(): Promise<void> {
    await writeIMWorkFile(stateDir, 'wezterm');
    await writeIMOriginFile(stateDir, {
      imType: 'lark',
      openId: 'ou_user',
      chatId: 'oc_chat_tk',
    });
    const lstart = await captureProcessLstart(process.pid);
    await writeDaemonPidFile({
      stateDir,
      pid: process.pid,
      startedAt: lstart!,
    });
  }

  it('PreToolUse with WEZTERM_PANE undefined → silent exit (no stdout)', async () => {
    await setupBoundState();
    const result = await runHookCommand({
      traceLogPath: null,
      stdin: PRE_TOOL_USE_BASH,
      stateDir,
      resolvePaneId: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('PreToolUse read-only tool (Read) → emits permissionDecision allow JSON', async () => {
    await setupBoundState();
    const READ = JSON.stringify({
      session_id: SID,
      transcript_path: TX,
      cwd: CWD,
      hook_event_name: 'PreToolUse',
      permission_mode: 'default',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
      tool_use_id: 'toolu_x',
    });
    const result = await runHookCommand({
      traceLogPath: null,
      stdin: READ,
      stateDir,
      resolvePaneId: () => PANE_ID,
    });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('Stop with queued injection → emits decision JSON to stdout', async () => {
    await setupBoundState();
    await enqueueInjection({
      stateDir,
      sessionId: SID,
      content: 'follow-up prompt',
    });
    const result = await runHookCommand({
      traceLogPath: null,
      stdin: STOP,
      stateDir,
      resolvePaneId: () => PANE_ID,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      decision: 'block',
      reason: 'follow-up prompt',
    });
  });

  it('Stop with empty queue → exit 0 empty stdout', async () => {
    await setupBoundState();
    const result = await runHookCommand({
      traceLogPath: null,
      stdin: STOP,
      stateDir,
      resolvePaneId: () => PANE_ID,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('Stop with stop_hook_active=true → never pops queue (anti-loop)', async () => {
    await setupBoundState();
    await enqueueInjection({
      stateDir,
      sessionId: SID,
      content: 'should-not-fire',
    });
    const result = await runHookCommand({
      traceLogPath: null,
      stdin: STOP_ACTIVE,
      stateDir,
      resolvePaneId: () => PANE_ID,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('Stop without IMWork → exit 0 empty stdout (E1 short-circuit)', async () => {
    await enqueueInjection({
      stateDir,
      sessionId: SID,
      content: 'never-popped',
    });
    const result = await runHookCommand({
      traceLogPath: null,
      stdin: STOP,
      stateDir,
      resolvePaneId: () => PANE_ID,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('SessionStart payload → exit 1 (no longer subscribed per DD #61)', async () => {
    const SESSION_START = JSON.stringify({
      session_id: SID,
      transcript_path: TX,
      cwd: CWD,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-opus-4-7',
    });
    const result = await runHookCommand({
      traceLogPath: null,
      stdin: SESSION_START,
      stateDir,
      resolvePaneId: () => PANE_ID,
    });
    // SessionStart is not in HookPayloadSchema discriminator → parse error → exit 1.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('malformed JSON stdin → exit 1 + stderr explaining', async () => {
    const result = await runHookCommand({
      traceLogPath: null,
      stdin: 'not-json{{{',
      stateDir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/parse|json|invalid/i);
  });

  it('empty stdin → exit 1 + stderr', async () => {
    const result = await runHookCommand({ stdin: '', stateDir, traceLogPath: null });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/empty|stdin/i);
  });

  it('entry trace: writes one line to traceLogPath before parse, includes event + env keys + stdin-bytes', async () => {
    const tracePath = join(stateDir, 'hook-trace.log');
    const prevIterm = process.env.ITERM_SESSION_ID;
    const prevWez = process.env.WEZTERM_PANE;
    process.env.ITERM_SESSION_ID = 'w0t0p0:11111111-2222-3333-4444-555555555555';
    delete process.env.WEZTERM_PANE;
    try {
      await runHookCommand({
        event: 'Stop',
        stdin: STOP,
        stateDir,
        traceLogPath: tracePath,
        resolvePaneId: () => PANE_ID,
      });
      const { readFile } = await import('node:fs/promises');
      const trace = await readFile(tracePath, 'utf-8');
      expect(trace).toMatch(/hook event=Stop/);
      expect(trace).toMatch(/ITERM_SESSION_ID=w0t0p0:11111111/);
      expect(trace).toMatch(/WEZTERM_PANE= /);
      expect(trace).toMatch(/stdin-bytes=\d+/);
      // First line is the entry heartbeat; subsequent lines are
      // receiver gate decisions (issue 377 follow-up PR adds these).
      const lines = trace.split('\n').filter((l) => l.length > 0);
      expect(lines[0]!).toContain('hook event=Stop');
      expect(lines.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (prevIterm !== undefined) process.env.ITERM_SESSION_ID = prevIterm;
      else delete process.env.ITERM_SESSION_ID;
      if (prevWez !== undefined) process.env.WEZTERM_PANE = prevWez;
    }
  });

  it('entry trace: even logs empty-stdin invocations (so we see "cc fired but with bad payload")', async () => {
    const tracePath = join(stateDir, 'hook-trace.log');
    await runHookCommand({
      event: 'Stop',
      stdin: '',
      stateDir,
      traceLogPath: tracePath,
    });
    const { readFile } = await import('node:fs/promises');
    const trace = await readFile(tracePath, 'utf-8');
    expect(trace).toMatch(/hook event=Stop/);
    expect(trace).toMatch(/stdin-bytes=0/);
  });

  it('gate trace: Stop branch logs each gate decision + pre-write line', async () => {
    await setupBoundState();
    const tracePath = join(stateDir, 'hook-trace.log');
    await runHookCommand({
      event: 'Stop',
      stdin: STOP,
      stateDir,
      traceLogPath: tracePath,
      resolvePaneId: () => PANE_ID,
    });
    const { readFile } = await import('node:fs/promises');
    const trace = await readFile(tracePath, 'utf-8');
    // Each gate produces its own line. Order: detector → IMWezterm →
    // IMOrigin → daemon-alive → stop-write.
    expect(trace).toMatch(/detector: termId=wezterm paneId=\d+ event=Stop/);
    expect(trace).toMatch(/stop-gate IMWezterm=true/);
    expect(trace).toMatch(/stop-gate IMOrigin=true/);
    expect(trace).toMatch(/stop-gate daemon-alive=true/);
    expect(trace).toMatch(/stop-write paneId=\d+ sid=.+ ts=.+ msg-len=\d+/);
    expect(trace).toMatch(/stop-write OK/);
  });

  it('parse-fail trace: invalid stdin records err + stdin-head to trace', async () => {
    const tracePath = join(stateDir, 'hook-trace.log');
    await runHookCommand({
      event: 'Stop',
      stdin: 'not-json{{{',
      stateDir,
      traceLogPath: tracePath,
    });
    const { readFile } = await import('node:fs/promises');
    const trace = await readFile(tracePath, 'utf-8');
    expect(trace).toMatch(/parse-fail event=Stop/);
    expect(trace).toMatch(/stdin-head=/);
    // Include verbatim head so we can reconstruct what cc actually sent.
    expect(trace).toMatch(/not-json/);
  });

  it('entry trace: traceLogPath=null disables file write (tests + opt-out)', async () => {
    const tracePath = join(stateDir, 'hook-trace.log');
    await runHookCommand({
      event: 'Stop',
      stdin: STOP,
      stateDir,
      traceLogPath: null,
      resolvePaneId: () => PANE_ID,
    });
    const { stat } = await import('node:fs/promises');
    await expect(stat(tracePath)).rejects.toThrow(/ENOENT/);
  });

  it('unknown hook_event_name → exit 1 + stderr (zod validation)', async () => {
    const result = await runHookCommand({
      traceLogPath: null,
      stdin: JSON.stringify({
        session_id: SID,
        transcript_path: TX,
        cwd: CWD,
        hook_event_name: 'Mystery',
      }),
      stateDir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });
});
