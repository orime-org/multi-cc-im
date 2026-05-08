import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHookReceiver } from './hook-receiver.js';
import {
  PERMISSION_REQUEST_PREFIX,
  PERMISSION_RESPONSE_PREFIX,
  STOP_PREFIX,
  captureProcessLstart,
  imOriginPath,
  imWorkPath,
  listStopFiles,
  permissionRequestPath,
  readStopFile,
  stopFilePath,
  writeDaemonPidFile,
  writeIMOriginFile,
  writeIMWorkFile,
  writePermissionResponseFile,
} from './state-files.js';
import { enqueueInjection } from './injection-queue.js';
import type { ParsedHookPayload } from './payloads.js';
import type { IMReplyContext } from '@multi-cc-im/shared';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const TX = '/Users/x/.claude/projects/-private-tmp/91215578.jsonl';
const CWD = '/private/tmp/cc-probe';
const PANE_ID = 42;

const WECHAT_CTX: IMReplyContext = {
  imType: 'wechat',
  to: 'wxid_user',
  contextToken: 'ctx-1',
};

const PRE_TOOL_USE_BASH: ParsedHookPayload = {
  session_id: SID as never,
  transcript_path: TX as never,
  cwd: CWD as never,
  hook_event_name: 'PreToolUse',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'toolu_abc',
};

const PRE_TOOL_USE_READ: ParsedHookPayload = {
  ...PRE_TOOL_USE_BASH,
  tool_name: 'Read',
  tool_input: { file_path: '/tmp/x' },
};

const STOP_PAYLOAD: ParsedHookPayload = {
  session_id: SID as never,
  transcript_path: TX as never,
  cwd: CWD as never,
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: 'hi',
};

const STOP_HOOK_ACTIVE_TRUE: ParsedHookPayload = {
  ...STOP_PAYLOAD,
  stop_hook_active: true,
};

/** Build a stateDir with daemon.pid + IMWork + <paneId>.IMOrigin all set up
 * (= "fully bound, daemon alive" — the path that exercises the heavy code). */
async function setupBoundState(stateDir: string): Promise<void> {
  await writeIMWorkFile(stateDir);
  await writeIMOriginFile({
    stateDir,
    paneId: PANE_ID,
    replyCtx: WECHAT_CTX,
  });
  const lstart = (await captureProcessLstart(process.pid)) ?? 'unknown';
  await writeDaemonPidFile({
    stateDir,
    pid: process.pid,
    startedAt: lstart,
  });
}

async function readStateDirEntries(stateDir: string): Promise<string[]> {
  try {
    return await readdir(stateDir);
  } catch {
    return [];
  }
}

const stubPaneId = (): number => PANE_ID;
const noPane = (): undefined => undefined;

describe('runHookReceiver — WEZTERM_PANE filter', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-cc-recv-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('PreToolUse: silently exits (no file written) when WEZTERM_PANE undefined', async () => {
    await setupBoundState(stateDir);
    const initialEntries = await readStateDirEntries(stateDir);
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneId: noPane,
    });
    expect(result).toBeUndefined();
    const after = await readStateDirEntries(stateDir);
    // No PermissionRequest written.
    expect(
      after.filter((n) => n.includes(PERMISSION_REQUEST_PREFIX)).length,
    ).toBe(0);
    // Existing top-level files untouched.
    expect(after.sort()).toEqual(initialEntries.sort());
  });

  it('Stop: silently exits (no Stop file) when WEZTERM_PANE undefined', async () => {
    await setupBoundState(stateDir);
    const result = await runHookReceiver({
      stateDir,
      payload: STOP_PAYLOAD,
      resolvePaneId: noPane,
    });
    expect(result).toBeUndefined();
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(STOP_PREFIX))).toBe(false);
  });
});

describe('runHookReceiver — PreToolUse decision tree', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-cc-recv-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('E1: read-only tool (Read) → permissionDecision: allow, no Request file', async () => {
    await setupBoundState(stateDir);
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_READ,
      resolvePaneId: stubPaneId,
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.stringContaining('read-only'),
      },
    });
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(PERMISSION_REQUEST_PREFIX))).toBe(
      false,
    );
  });

  it('E1: includes Read / Grep / Glob / NotebookRead', async () => {
    await setupBoundState(stateDir);
    for (const tool of ['Read', 'Grep', 'Glob', 'NotebookRead']) {
      const result = await runHookReceiver({
        stateDir,
        payload: { ...PRE_TOOL_USE_READ, tool_name: tool } as ParsedHookPayload,
        resolvePaneId: stubPaneId,
      });
      const out = result as { hookSpecificOutput: { permissionDecision: string } };
      expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    }
  });

  it('E2: !IMWork → silent exit (no JSON, no Request file). cc falls through to user permission rules — does NOT force a prompt that would override "Yes don\'t ask again" allow rules', async () => {
    // Don't write IMWork.
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneId: stubPaneId,
    });
    // Hook returns void → CLI writes empty stdout → cc treats as "no opinion"
    // and runs its native permission flow (allow rules first, then ask, then
    // deny, then default prompt). Crucial: returning `permissionDecision: ask`
    // would FORCE a prompt and bypass user-saved allow rules — that was the
    // pre-fix bug.
    expect(result).toBeUndefined();
    expect(
      (await readStateDirEntries(stateDir)).some((n) =>
        n.includes(PERMISSION_REQUEST_PREFIX),
      ),
    ).toBe(false);
  });

  it('E1.5: IMWork.auto=true → permissionDecision: allow, no Request file (DD #64)', async () => {
    // Just IMWork {auto:true} — no IMOrigin / daemon.pid needed; auto bypasses
    // E3 / E4 entirely.
    await writeIMWorkFile(stateDir, { auto: true });
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneId: stubPaneId,
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.stringContaining('auto-approve'),
      },
    });
    // Crucially: no PermissionRequest file — IM round-trip skipped.
    expect(
      (await readStateDirEntries(stateDir)).some((n) =>
        n.includes(PERMISSION_REQUEST_PREFIX),
      ),
    ).toBe(false);
  });

  it('E1.5: IMWork.auto=false → falls through to E3 silent exit (no Request file)', async () => {
    // IMWork {auto:false} but no IMOrigin → should hit E3 silent exit.
    await writeIMWorkFile(stateDir, { auto: false });
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneId: stubPaneId,
    });
    expect(result).toBeUndefined();
  });

  it('E3: !<paneId>.IMOrigin → silent exit, no Request file (defers to cc native flow + user allow rules)', async () => {
    await writeIMWorkFile(stateDir);
    // No IMOrigin written.
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneId: stubPaneId,
    });
    expect(result).toBeUndefined();
    expect(
      (await readStateDirEntries(stateDir)).some((n) =>
        n.includes(PERMISSION_REQUEST_PREFIX),
      ),
    ).toBe(false);
  });

  it('E4: !daemon alive → silent exit, no Request file (defers to cc native flow)', async () => {
    await writeIMWorkFile(stateDir);
    await writeIMOriginFile({
      stateDir,
      paneId: PANE_ID,
      replyCtx: WECHAT_CTX,
    });
    // No daemon.pid → isDaemonAlive false.
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneId: stubPaneId,
    });
    expect(result).toBeUndefined();
    expect(
      (await readStateDirEntries(stateDir)).some((n) =>
        n.includes(PERMISSION_REQUEST_PREFIX),
      ),
    ).toBe(false);
  });

  it('E5 happy path: writes Request, polls, returns IM allow on response', async () => {
    await setupBoundState(stateDir);

    // Run hook receiver in parallel with a "user replies allow" simulator.
    // We don't know requestId yet — wait until Request file appears, copy id,
    // write Response.
    const respondInBackground = (async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const entries = await readStateDirEntries(stateDir);
        const reqFile = entries.find((n) =>
          n.startsWith(`${PANE_ID}_${SID}${PERMISSION_REQUEST_PREFIX}`),
        );
        if (reqFile) {
          // Extract requestId.
          const m = reqFile.match(/\.PermissionRequest\.([0-9a-f]+)\.json$/);
          if (m) {
            await writePermissionResponseFile({
              stateDir,
              paneId: PANE_ID,
              sessionId: SID,
              requestId: m[1]!,
              decision: 'allow',
              reason: 'user clicked /1',
            });
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneId: stubPaneId,
      permissionPollIntervalMs: 20,
      permissionTimeoutMs: 2_000,
    });
    await respondInBackground;

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'user clicked /1',
      },
    });
    // Request + Response both cleaned up by hook before exit.
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(PERMISSION_REQUEST_PREFIX))).toBe(
      false,
    );
    expect(after.some((n) => n.includes(PERMISSION_RESPONSE_PREFIX))).toBe(
      false,
    );
  });

  it('E5 timeout: returns default-allow + cleans up Request', async () => {
    await setupBoundState(stateDir);
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneId: stubPaneId,
      permissionPollIntervalMs: 30,
      permissionTimeoutMs: 100,
    });
    const out = result as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/timeout/);
    expect(
      (await readStateDirEntries(stateDir)).some((n) =>
        n.includes(PERMISSION_REQUEST_PREFIX),
      ),
    ).toBe(false);
  });

  it('E5 sweeps stale Request/Response files for this pane+sid before writing', async () => {
    await setupBoundState(stateDir);
    // Pre-seed a stale request for the same pane+sid.
    const stalePath = permissionRequestPath({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      requestId: 'staleeeee',
    });
    await writePermissionResponseFile({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      requestId: 'staleeeee',
      decision: 'deny',
      reason: 'old',
    });
    // Run with short timeout so we don't hang waiting for a real response.
    await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneId: stubPaneId,
      permissionPollIntervalMs: 30,
      permissionTimeoutMs: 100,
    });
    const after = await readStateDirEntries(stateDir);
    // No stale Request / Response left.
    expect(after.includes(stalePath.split('/').pop()!)).toBe(false);
    expect(after.some((n) => n.includes('staleeeee'))).toBe(false);
  });
});

describe('runHookReceiver — Stop event', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-cc-recv-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('!IMWork → silent exit, no Stop file', async () => {
    const result = await runHookReceiver({
      stateDir,
      payload: STOP_PAYLOAD,
      resolvePaneId: stubPaneId,
    });
    expect(result).toBeUndefined();
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(STOP_PREFIX))).toBe(false);
  });

  it('!IMOrigin → silent exit, no Stop file', async () => {
    await writeIMWorkFile(stateDir);
    const result = await runHookReceiver({
      stateDir,
      payload: STOP_PAYLOAD,
      resolvePaneId: stubPaneId,
    });
    expect(result).toBeUndefined();
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(STOP_PREFIX))).toBe(false);
  });

  it('!daemon alive → silent exit, no Stop file', async () => {
    await writeIMWorkFile(stateDir);
    await writeIMOriginFile({
      stateDir,
      paneId: PANE_ID,
      replyCtx: WECHAT_CTX,
    });
    const result = await runHookReceiver({
      stateDir,
      payload: STOP_PAYLOAD,
      resolvePaneId: stubPaneId,
    });
    expect(result).toBeUndefined();
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(STOP_PREFIX))).toBe(false);
  });

  it('all guards pass → writes <paneId>_<sid>.Stop.<ts> with last_assistant_message', async () => {
    await setupBoundState(stateDir);
    const fixedNow = new Date('2026-05-08T01:43:40.131Z');
    const result = await runHookReceiver({
      stateDir,
      payload: STOP_PAYLOAD,
      resolvePaneId: stubPaneId,
      now: () => fixedNow,
    });
    // No injection queued → returns void.
    expect(result).toBeUndefined();
    const path = stopFilePath({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      timestamp: '2026-05-08T01-43-40-131Z',
    });
    const got = await readStopFile(path);
    expect(got?.last_assistant_message).toBe('hi');
  });

  it('clears stale Stop.* for the pane+sid before writing fresh', async () => {
    await setupBoundState(stateDir);
    // Pre-seed a stale Stop file.
    const stalePath = stopFilePath({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      timestamp: 'stale',
    });
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(stalePath, '{"last_assistant_message":"old"}'),
    );
    expect(
      (await listStopFiles({ stateDir, paneId: PANE_ID, sessionId: SID }))
        .length,
    ).toBe(1);

    const fixedNow = new Date('2026-05-08T01:43:40.131Z');
    await runHookReceiver({
      stateDir,
      payload: STOP_PAYLOAD,
      resolvePaneId: stubPaneId,
      now: () => fixedNow,
    });
    const list = await listStopFiles({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.endsWith('stale')).toBe(false);
  });

  it('stop_hook_active=true: no injection check (avoids loop)', async () => {
    await setupBoundState(stateDir);
    await enqueueInjection({ stateDir, sessionId: SID, content: 'wake-cc' });
    const result = await runHookReceiver({
      stateDir,
      payload: STOP_HOOK_ACTIVE_TRUE,
      resolvePaneId: stubPaneId,
    });
    // Should NOT consume the injection queue → returns void.
    expect(result).toBeUndefined();
  });

  it('stop_hook_active=false + injection queued → returns block decision', async () => {
    await setupBoundState(stateDir);
    await enqueueInjection({ stateDir, sessionId: SID, content: 'wake-cc' });
    const result = await runHookReceiver({
      stateDir,
      payload: STOP_PAYLOAD,
      resolvePaneId: stubPaneId,
    });
    expect(result).toEqual({ decision: 'block', reason: 'wake-cc' });
  });
});
