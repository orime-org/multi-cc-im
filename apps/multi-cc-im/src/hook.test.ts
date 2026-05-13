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
    await writeIMWorkFile(stateDir);
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
      stdin: 'not-json{{{',
      stateDir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/parse|json|invalid/i);
  });

  it('empty stdin → exit 1 + stderr', async () => {
    const result = await runHookCommand({ stdin: '', stateDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/empty|stdin/i);
  });

  it('unknown hook_event_name → exit 1 + stderr (zod validation)', async () => {
    const result = await runHookCommand({
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
