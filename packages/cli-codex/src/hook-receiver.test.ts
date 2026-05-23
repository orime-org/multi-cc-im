import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  IMLarkReplyContext,
  PaneId,
  TerminalId,
} from '@multi-cc-im/shared';
import {
  captureProcessLstart,
  permissionResponsePath,
  permissionDialogResponsePath,
  writeDaemonPidFile,
  writeIMOriginFile,
  writeIMWorkFile,
  writePermissionResponseFile,
  writePermissionDialogResponseFile,
  type PaneOrigin,
} from '@multi-cc-im/cli-cc';
import {
  runHookReceiver,
  runFromStdin,
  type RunHookReceiverOpts,
} from './hook-receiver.js';
import type {
  ParsedHookPayload,
  PreToolUsePayload,
  PermissionRequestPayload,
  SessionStartPayload,
  StopPayload,
} from './payloads.js';

const SID = 'thread_01J9Z7HVQK5P3M4XYZ';
const TURN_ID = 'turn_01J9Z7HW2A5BCD9XYZ';
const MODEL = 'gpt-5-codex';
const PANE_ID = 42 as unknown as PaneId;
const TERM_ID = 'wezterm' as unknown as TerminalId;
const TX = '/Users/x/.codex/sessions/test.jsonl';

const ORIGIN: PaneOrigin = {
  paneId: PANE_ID,
  termId: TERM_ID,
};

const REPLY_CTX: IMLarkReplyContext = {
  imType: 'lark',
  openId: 'ou_test',
  chatId: 'oc_test',
};

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'cli-codex-hook-receiver-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** Set up the 3-gate so Stop/PreToolUse/PermissionRequest pass to forward stage. */
async function setGatesOpen(): Promise<void> {
  await writeIMWorkFile(stateDir, TERM_ID, { auto: false });
  await writeIMOriginFile(stateDir, REPLY_CTX);
  const startedAt = (await captureProcessLstart(process.pid)) ?? 'unknown';
  await writeDaemonPidFile({ stateDir, pid: process.pid, startedAt });
}

function makeStopPayload(overrides: Partial<StopPayload> = {}): StopPayload {
  return {
    session_id: SID,
    transcript_path: TX,
    cwd: '/private/tmp/x',
    hook_event_name: 'Stop',
    permission_mode: 'default',
    model: MODEL,
    turn_id: TURN_ID,
    stop_hook_active: false,
    last_assistant_message: 'task complete',
    ...overrides,
  };
}

function makePreToolUsePayload(
  overrides: Partial<PreToolUsePayload> = {},
): PreToolUsePayload {
  return {
    session_id: SID,
    transcript_path: TX,
    cwd: '/private/tmp/x',
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    model: MODEL,
    turn_id: TURN_ID,
    agent_id: '',
    agent_type: '',
    tool_name: 'shell',
    tool_input: { command: ['ls'] },
    tool_use_id: 'fc_test',
    ...overrides,
  };
}

function makePermissionRequestPayload(
  overrides: Partial<PermissionRequestPayload> = {},
): PermissionRequestPayload {
  return {
    session_id: SID,
    transcript_path: TX,
    cwd: '/private/tmp/x',
    hook_event_name: 'PermissionRequest',
    permission_mode: 'default',
    model: MODEL,
    turn_id: TURN_ID,
    agent_id: '',
    agent_type: '',
    tool_name: 'shell',
    tool_input: { command: ['rm', '-rf', '/tmp/x'] },
    ...overrides,
  };
}

function makeSessionStartPayload(): SessionStartPayload {
  return {
    session_id: SID,
    transcript_path: TX,
    cwd: '/private/tmp/x',
    hook_event_name: 'SessionStart',
    permission_mode: 'default',
    model: MODEL,
    source: 'startup',
  };
}

function baseOpts(payload: ParsedHookPayload): RunHookReceiverOpts {
  return {
    stateDir,
    payload,
    resolvePaneOrigin: () => ORIGIN,
  };
}

describe('runHookReceiver — terminal detection gate', () => {
  it('silent-exits when no terminal env detected', async () => {
    const result = await runHookReceiver({
      stateDir,
      payload: makeStopPayload(),
      resolvePaneOrigin: () => undefined,
    });
    expect(result).toBeUndefined();
  });
});

describe('runHookReceiver — SessionStart', () => {
  it('silent-exits regardless of source (no-op in v0.2.0)', async () => {
    for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
      const result = await runHookReceiver(
        baseOpts({ ...makeSessionStartPayload(), source }),
      );
      expect(result).toBeUndefined();
    }
  });
});

describe('runHookReceiver — Stop branch', () => {
  it('silent-exits when IMWork missing', async () => {
    const result = await runHookReceiver(baseOpts(makeStopPayload()));
    expect(result).toBeUndefined();
  });

  it('silent-exits when IMOrigin missing (IMWork present)', async () => {
    await writeIMWorkFile(stateDir, TERM_ID, { auto: false });
    const result = await runHookReceiver(baseOpts(makeStopPayload()));
    expect(result).toBeUndefined();
  });

  it('silent-exits when daemon dead (IMWork + IMOrigin present)', async () => {
    await writeIMWorkFile(stateDir, TERM_ID, { auto: false });
    await writeIMOriginFile(stateDir, REPLY_CTX);
    // No daemon pid file → isDaemonAlive returns false
    const result = await runHookReceiver(baseOpts(makeStopPayload()));
    expect(result).toBeUndefined();
  });

  it('writes Stop file with given timestamp when all gates pass', async () => {
    await setGatesOpen();
    const fixedNow = new Date('2026-05-22T08:00:00.000Z');
    await runHookReceiver({
      ...baseOpts(makeStopPayload()),
      now: () => fixedNow,
    });
    const fname = `${String(PANE_ID)}_${SID}.Stop.2026-05-22T08-00-00-000Z`;
    const st = await stat(join(stateDir, fname));
    expect(st.isFile()).toBe(true);
  });

  it('serializes nullable last_assistant_message as empty string', async () => {
    await setGatesOpen();
    await runHookReceiver({
      ...baseOpts(makeStopPayload({ last_assistant_message: null })),
      now: () => new Date('2026-05-22T08:00:01.000Z'),
    });
    const fname = `${String(PANE_ID)}_${SID}.Stop.2026-05-22T08-00-01-000Z`;
    const raw = await readFile(join(stateDir, fname), 'utf8');
    const parsed = JSON.parse(raw) as { last_assistant_message: string };
    expect(parsed.last_assistant_message).toBe('');
  });
});

describe('runHookReceiver — PreToolUse branch', () => {
  it('silent-exits when IMWork missing', async () => {
    const result = await runHookReceiver(baseOpts(makePreToolUsePayload()));
    expect(result).toBeUndefined();
  });

  it('auto-mode returns allow without writing PermissionRequest', async () => {
    await writeIMWorkFile(stateDir, TERM_ID, { auto: true });
    const result = await runHookReceiver(baseOpts(makePreToolUsePayload()));
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.stringContaining('auto-approve'),
      },
    });
  });

  it('silent-exits when IMOrigin missing (IMWork present, non-auto)', async () => {
    await writeIMWorkFile(stateDir, TERM_ID, { auto: false });
    const result = await runHookReceiver(baseOpts(makePreToolUsePayload()));
    expect(result).toBeUndefined();
  });

  it('returns allow + reason from PermissionResponse file', async () => {
    await setGatesOpen();
    // Pre-write a stable requestId is impossible (randomBytes inside).
    // Instead, race: launch hook, poll for the PermissionRequest file,
    // write a matching Response, expect hook to resolve with allow.
    const hookPromise = runHookReceiver({
      ...baseOpts(makePreToolUsePayload()),
      permissionPollIntervalMs: 20,
      permissionTimeoutMs: 5_000,
    });

    // Wait for the request file to appear, then derive requestId from name.
    const requestId = await waitForRequestId({ stateDir, kind: 'PermissionRequest' });
    await writePermissionResponseFile({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      requestId,
      decision: 'allow',
      reason: 'user approved via IM',
    });

    const result = await hookPromise;
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'user approved via IM',
      },
    });
    // Both files cleaned up
    expect(await fileExists(permissionResponsePath({ stateDir, paneId: PANE_ID, sessionId: SID, requestId }))).toBe(false);
  });

  it('returns deny + reason from PermissionResponse file', async () => {
    await setGatesOpen();
    const hookPromise = runHookReceiver({
      ...baseOpts(makePreToolUsePayload()),
      permissionPollIntervalMs: 20,
      permissionTimeoutMs: 5_000,
    });
    const requestId = await waitForRequestId({ stateDir, kind: 'PermissionRequest' });
    await writePermissionResponseFile({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      requestId,
      decision: 'deny',
      reason: 'unsafe command',
    });
    const result = await hookPromise;
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'unsafe command',
      },
    });
  });

  it('falls through to default-allow on poll timeout', async () => {
    await setGatesOpen();
    const result = await runHookReceiver({
      ...baseOpts(makePreToolUsePayload()),
      permissionPollIntervalMs: 30,
      permissionTimeoutMs: 80,
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.stringMatching(/timeout, default allow/),
      },
    });
  });

  it('deletes Request + Response files even on poll timeout (delete-always finally)', async () => {
    await setGatesOpen();
    await runHookReceiver({
      ...baseOpts(makePreToolUsePayload()),
      permissionPollIntervalMs: 30,
      permissionTimeoutMs: 80,
    });
    // No PermissionRequest.* file should remain
    const remaining = await listDirSuffix(stateDir, '.PermissionRequest.');
    expect(remaining).toHaveLength(0);
  });
});

describe('runHookReceiver — PermissionRequest branch', () => {
  it('silent-exits when IMWork missing', async () => {
    const result = await runHookReceiver(baseOpts(makePermissionRequestPayload()));
    expect(result).toBeUndefined();
  });

  it('silent-exits when IMOrigin missing', async () => {
    await writeIMWorkFile(stateDir, TERM_ID, { auto: false });
    const result = await runHookReceiver(baseOpts(makePermissionRequestPayload()));
    expect(result).toBeUndefined();
  });

  it('silent-exits when daemon dead', async () => {
    await writeIMWorkFile(stateDir, TERM_ID, { auto: false });
    await writeIMOriginFile(stateDir, REPLY_CTX);
    const result = await runHookReceiver(baseOpts(makePermissionRequestPayload()));
    expect(result).toBeUndefined();
  });

  it('returns allow from PermissionDialogResponse file', async () => {
    await setGatesOpen();
    const hookPromise = runHookReceiver({
      ...baseOpts(makePermissionRequestPayload()),
      permissionPollIntervalMs: 20,
      permissionDialogTimeoutMs: 5_000,
    });
    const requestId = await waitForRequestId({ stateDir, kind: 'PermissionDialogRequest' });
    await writePermissionDialogResponseFile({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      requestId,
      decision: { behavior: 'allow' },
    });
    const result = await hookPromise;
    expect(result).toEqual({ decision: { behavior: 'allow' } });
  });

  it('returns deny + message from PermissionDialogResponse file', async () => {
    await setGatesOpen();
    const hookPromise = runHookReceiver({
      ...baseOpts(makePermissionRequestPayload()),
      permissionPollIntervalMs: 20,
      permissionDialogTimeoutMs: 5_000,
    });
    const requestId = await waitForRequestId({ stateDir, kind: 'PermissionDialogRequest' });
    await writePermissionDialogResponseFile({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      requestId,
      decision: { behavior: 'deny', message: 'sandbox violation' },
    });
    const result = await hookPromise;
    expect(result).toEqual({
      decision: { behavior: 'deny', message: 'sandbox violation' },
    });
  });

  it('timeout returns default allow (codex falls through to TUI)', async () => {
    await setGatesOpen();
    const result = await runHookReceiver({
      ...baseOpts(makePermissionRequestPayload()),
      permissionPollIntervalMs: 30,
      permissionDialogTimeoutMs: 80,
    });
    expect(result).toEqual({ decision: { behavior: 'allow' } });
  });

  it('deletes DialogRequest + DialogResponse files on timeout (delete-always)', async () => {
    await setGatesOpen();
    await runHookReceiver({
      ...baseOpts(makePermissionRequestPayload()),
      permissionPollIntervalMs: 30,
      permissionDialogTimeoutMs: 80,
    });
    const reqLeftover = await listDirSuffix(stateDir, '.PermissionDialogRequest.');
    expect(reqLeftover).toHaveLength(0);
  });
});

describe('runFromStdin', () => {
  it('parses JSON + dispatches Stop branch', async () => {
    await setGatesOpen();
    const raw = JSON.stringify(makeStopPayload());
    await runFromStdin(raw, {
      stateDir,
      resolvePaneOrigin: () => ORIGIN,
      now: () => new Date('2026-05-22T09:00:00.000Z'),
    });
    // Stop file appeared — proves dispatch happened end-to-end
    const remaining = await listDirSuffix(stateDir, '.Stop.');
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('throws ZodError on shape mismatch', async () => {
    await expect(
      runFromStdin(JSON.stringify({ hook_event_name: 'Stop' }), {
        stateDir,
        resolvePaneOrigin: () => ORIGIN,
      }),
    ).rejects.toThrow();
  });

  it('throws on malformed JSON', async () => {
    await expect(
      runFromStdin('{not json', { stateDir, resolvePaneOrigin: () => ORIGIN }),
    ).rejects.toThrow();
  });
});

// ===== helpers =====

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirSuffix(dir: string, suffix: string): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const entries = await fs.readdir(dir);
  return entries.filter((e) => e.includes(suffix));
}

/**
 * Poll the state dir for a request file matching the given kind and return
 * the requestId portion of its name. Used because the hook generates a
 * random requestId we can't predict from outside.
 */
async function waitForRequestId(opts: {
  stateDir: string;
  kind: 'PermissionRequest' | 'PermissionDialogRequest';
}): Promise<string> {
  const fs = await import('node:fs/promises');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(opts.stateDir);
    for (const e of entries) {
      const marker = `.${opts.kind}.`;
      const idx = e.indexOf(marker);
      if (idx !== -1) {
        const tail = e.slice(idx + marker.length);
        // strip optional `.json` extension
        return tail.replace(/\.json$/, '');
      }
    }
    await sleep(20);
  }
  throw new Error(`waitForRequestId: no ${opts.kind} file appeared in 3s`);
}
