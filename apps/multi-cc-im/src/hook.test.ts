import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enqueueInjection,
  sessionStartPath,
} from '@multi-cc-im/cli-cc';
import { runHookCommand } from './hook.js';

const SID = '11111111-3606-4fe4-b01d-aaaaaaaaaaaa';
const TX = '/Users/x/.claude/projects/-private-tmp/abc.jsonl';
const CWD = '/private/tmp/cc-probe';

const SESSION_START = JSON.stringify({
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'SessionStart',
  source: 'startup',
  model: 'claude-opus-4-7',
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

  it('parses stdin → updates state files → exit 0 + empty stdout (normal hook)', async () => {
    const result = await runHookCommand({
      stdin: SESSION_START,
      stateDir,
      capturePid: async () => ({
        pid: 12345,
        startedAt: 'Tue May  4 16:38:00 2026',
        paneId: 42,
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    // Verify SessionStart state file written with the captured fields.
    const startPath = sessionStartPath({ stateDir, sessionId: SID });
    const startBody = JSON.parse(await readFile(startPath, 'utf-8'));
    expect(startBody.pid).toBe(12345);
    expect(startBody.paneId).toBe(42);
    expect(startBody.cwd).toBe(CWD);
    expect(startBody.transcript_path).toBe(TX);
  });

  it('Stop with queued injection → emits decision JSON to stdout', async () => {
    await enqueueInjection({
      stateDir,
      sessionId: SID,
      content: 'follow-up prompt',
    });
    const result = await runHookCommand({ stdin: STOP, stateDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      decision: 'block',
      reason: 'follow-up prompt',
    });
  });

  it('Stop with empty queue → exit 0 empty stdout (no decision = normal turn end)', async () => {
    const result = await runHookCommand({ stdin: STOP, stateDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('Stop with stop_hook_active=true → never pops queue (anti-loop)', async () => {
    await enqueueInjection({
      stateDir,
      sessionId: SID,
      content: 'should-not-fire',
    });
    const result = await runHookCommand({ stdin: STOP_ACTIVE, stateDir });
    expect(result.exitCode).toBe(0);
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

  it('never writes non-protocol output to stdout (CLAUDE.md hard rule)', async () => {
    // Even SessionStart with capturePid throwing — stderr only, never stdout
    const result = await runHookCommand({
      stdin: SESSION_START,
      stateDir,
      capturePid: async () => {
        throw new Error('ps failed for some reason');
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
