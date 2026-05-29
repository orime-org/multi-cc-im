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
  readPermissionDialogRequestFile,
  readStopFile,
  stopFilePath,
  writeDaemonPidFile,
  writeIMOriginFile,
  writeIMWorkFile,
  writePermissionDialogResponseFile,
  writePermissionResponseFile,
} from './state-files.js';
import { enqueueInjection } from './injection-queue.js';
import type { ParsedHookPayload } from './payloads.js';
import type { IMReplyContext, PaneId } from '@multi-cc-im/shared';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const TX = '/Users/x/.claude/projects/-private-tmp/91215578.jsonl';
const CWD = '/private/tmp/cc-probe';
const PANE_ID = 42 as unknown as PaneId;

const LARK_CTX: IMReplyContext = {
  imType: 'lark',
  openId: 'ou_user',
  chatId: 'oc_chat',
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

const PRE_TOOL_USE_ASK: ParsedHookPayload = {
  ...PRE_TOOL_USE_BASH,
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: 'Pick one',
        header: 'Test',
        multiSelect: false,
        options: [
          { label: 'Option A', description: 'first one' },
          { label: 'Option B', description: 'second one' },
        ],
      },
    ],
  },
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

const PERMISSION_REQUEST_PAYLOAD: ParsedHookPayload = {
  session_id: SID as never,
  transcript_path: TX as never,
  cwd: CWD as never,
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'mkdir -p .claude/hooks' },
  permission_suggestions: [
    { type: 'addRules', behavior: 'allow', destination: 'session' },
  ],
};

/** Build a stateDir with daemon.pid + IMWork + <paneId>.IMOrigin all set up
 * (= "fully bound, daemon alive" — the path that exercises the heavy code). */
async function setupBoundState(stateDir: string): Promise<void> {
  await writeIMWorkFile(stateDir, 'wezterm');
  await writeIMOriginFile(stateDir, LARK_CTX);
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

// Tests treat the stubbed origin as wezterm by default — pre-issue-378
// IMWork/Stop files were wezterm-shaped (numeric paneId), so the IM<TermType>
// filename helpers default to wezterm for back-compat.
const stubPaneOrigin = () => ({ termId: 'wezterm' as const, paneId: PANE_ID });
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
      resolvePaneOrigin: noPane,
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
      resolvePaneOrigin: noPane,
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
      resolvePaneOrigin: stubPaneOrigin,
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
        resolvePaneOrigin: stubPaneOrigin,
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
      resolvePaneOrigin: stubPaneOrigin,
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
    await writeIMWorkFile(stateDir, 'wezterm', { auto: true });
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneOrigin: stubPaneOrigin,
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
    await writeIMWorkFile(stateDir, 'wezterm', { auto: false });
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toBeUndefined();
  });

  it('E3: !<paneId>.IMOrigin → silent exit, no Request file (defers to cc native flow + user allow rules)', async () => {
    await writeIMWorkFile(stateDir, 'wezterm');
    // No IMOrigin written.
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toBeUndefined();
    expect(
      (await readStateDirEntries(stateDir)).some((n) =>
        n.includes(PERMISSION_REQUEST_PREFIX),
      ),
    ).toBe(false);
  });

  it('E4: !daemon alive → silent exit, no Request file (defers to cc native flow)', async () => {
    await writeIMWorkFile(stateDir, 'wezterm');
    await writeIMOriginFile(stateDir, LARK_CTX);
    // No daemon.pid → isDaemonAlive false.
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneOrigin: stubPaneOrigin,
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
      resolvePaneOrigin: stubPaneOrigin,
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
      resolvePaneOrigin: stubPaneOrigin,
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
      resolvePaneOrigin: stubPaneOrigin,
      permissionPollIntervalMs: 30,
      permissionTimeoutMs: 100,
    });
    const after = await readStateDirEntries(stateDir);
    // No stale Request / Response left.
    expect(after.includes(stalePath.split('/').pop()!)).toBe(false);
    expect(after.some((n) => n.includes('staleeeee'))).toBe(false);
  });
});

// ============================================================================
// AskUserQuestion special-case (v1.9 DD §6 P2)
// ============================================================================

describe('runHookReceiver — PreToolUse AskUserQuestion special-case (DD 2026-05-12)', () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'hook-receiver-ask-'));
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('AskUserQuestion + IMWork.auto=true → bypasses auto-allow short-circuit, falls through to forward path (D1-B)', async () => {
    // Regular tool with IMWork.auto=true → E1.5 short-circuit returns allow
    // without writing Request. AskUserQuestion under same config must NOT
    // short-circuit — D1-B always-forward semantics.
    await writeIMWorkFile(stateDir, 'wezterm', { auto: true });
    // No IMOrigin → falls through to E3 silent exit. The key assertion is
    // that we DIDN'T return the auto-allow allow object.
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_ASK,
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toBeUndefined();
    expect(
      (await readStateDirEntries(stateDir)).some((n) =>
        n.includes(PERMISSION_REQUEST_PREFIX),
      ),
    ).toBe(false);
  });

  it('AskUserQuestion + IMWork null → silent exit (no forward when IM mode off; cc renders TUI widget natively)', async () => {
    // D1-B says "IMWork on → always forward". IMWork OFF means user opted
    // out of IM routing; AskUserQuestion should also defer.
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_ASK,
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toBeUndefined();
  });

  it('AskUserQuestion + response decision=deny → hook forwards deny + reason verbatim (defensive)', async () => {
    // Per DD §9 revision, daemon SHOULD write allow + updatedInput for AUQ.
    // If a future router still emits deny (e.g. defensive guard, schema
    // regression), the hook must honor it verbatim — not magically rewrite
    // it to allow. cc transcript will show the tool as denied with the
    // daemon's reason; that's the daemon's decision to own.
    await setupBoundState(stateDir);

    // Background responder: write response with decision='deny' + reason.
    const respondInBackground = (async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const entries = await readStateDirEntries(stateDir);
        const reqFile = entries.find((n) =>
          n.startsWith(`${PANE_ID}_${SID}${PERMISSION_REQUEST_PREFIX}`),
        );
        if (reqFile) {
          const m = reqFile.match(/\.PermissionRequest\.([0-9a-f]+)\.json$/);
          if (m) {
            await writePermissionResponseFile({
              stateDir,
              paneId: PANE_ID,
              sessionId: SID,
              requestId: m[1]!,
              decision: 'deny',
              reason: 'I pick Option A — second one looks risky',
            });
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_ASK,
      resolvePaneOrigin: stubPaneOrigin,
      permissionPollIntervalMs: 20,
      askUserQuestionTimeoutMs: 2_000,
    });
    await respondInBackground;

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'I pick Option A — second one looks risky',
      },
    });
    // Request + Response cleaned up by the same try/finally as regular path.
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(PERMISSION_REQUEST_PREFIX))).toBe(false);
    expect(after.some((n) => n.includes(PERMISSION_RESPONSE_PREFIX))).toBe(false);
  });

  it('AskUserQuestion + response with decision=allow + updatedInput → forwards updatedInput to cc (D5-D answer-inject)', async () => {
    // Per DD §9 revision: AskUserQuestion's correct response channel is
    // `allow + updatedInput.answers`. Daemon writes that, hook forwards it
    // verbatim to cc so cc treats the tool as completed successfully with
    // the user's answers. No deny override anymore.
    await setupBoundState(stateDir);
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
    const respondInBackground = (async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const entries = await readStateDirEntries(stateDir);
        const reqFile = entries.find((n) =>
          n.startsWith(`${PANE_ID}_${SID}${PERMISSION_REQUEST_PREFIX}`),
        );
        if (reqFile) {
          const m = reqFile.match(/\.PermissionRequest\.([0-9a-f]+)\.json$/);
          if (m) {
            await writePermissionResponseFile({
              stateDir,
              paneId: PANE_ID,
              sessionId: SID,
              requestId: m[1]!,
              decision: 'allow',
              updatedInput,
            });
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_ASK,
      resolvePaneOrigin: stubPaneOrigin,
      permissionPollIntervalMs: 20,
      askUserQuestionTimeoutMs: 2_000,
    });
    await respondInBackground;

    const out = (
      result as {
        hookSpecificOutput: {
          permissionDecision: string;
          updatedInput?: Record<string, unknown>;
        };
      }
    ).hookSpecificOutput;
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput).toEqual(updatedInput);
  });

  it('AskUserQuestion + timeout → allow + updatedInput.answers with empty strings (DD §9.5)', async () => {
    // Per DD §9.5 revision: on AUQ timeout the hook self-constructs an
    // `updatedInput` with empty `answers` per question and returns
    // `permissionDecision: 'allow'`. cc records the tool as completed
    // with empty user answers; the model decides what to do next. Does
    // NOT use the deny channel (deny is not part of AUQ's documented
    // response semantics per agent-sdk/user-input docs).
    await setupBoundState(stateDir);
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_ASK,
      resolvePaneOrigin: stubPaneOrigin,
      permissionPollIntervalMs: 20,
      askUserQuestionTimeoutMs: 100, // immediate timeout
    });
    const out = (
      result as {
        hookSpecificOutput: {
          permissionDecision: string;
          updatedInput?: {
            questions: unknown[];
            answers: Record<string, string>;
          };
        };
      }
    ).hookSpecificOutput;
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput).toBeDefined();
    expect(out.updatedInput!.questions).toEqual(
      (PRE_TOOL_USE_ASK as unknown as { tool_input: { questions: unknown[] } })
        .tool_input.questions,
    );
    // Empty answers for every question key (cc reads empty answer → decides)
    for (const [k, v] of Object.entries(out.updatedInput!.answers)) {
      expect(typeof k).toBe('string');
      expect(v).toBe('');
    }
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(PERMISSION_REQUEST_PREFIX))).toBe(false);
  });

  it('regular Bash tool with IMWork.auto=true STILL auto-allows (regression guard for D1-B narrow scope)', async () => {
    // D1-B special-cases only AskUserQuestion. Regular tools must keep
    // their existing v1.7 auto-mode behavior.
    await writeIMWorkFile(stateDir, 'wezterm', { auto: true });
    const result = await runHookReceiver({
      stateDir,
      payload: PRE_TOOL_USE_BASH,
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: expect.stringContaining('auto-approve'),
      },
    });
  });
});

describe('runHookReceiver — PermissionRequest handler (DD 2026-05-13 P4)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-cc-recv-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('E1 IMWork null → silent exit (cc falls back to TUI dialog)', async () => {
    const result = await runHookReceiver({
      stateDir,
      payload: PERMISSION_REQUEST_PAYLOAD,
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toBeUndefined();
    const entries = await readStateDirEntries(stateDir);
    expect(entries).toEqual([]);
  });

  it('E2 IMOrigin missing → silent exit (no IM thread bound)', async () => {
    await writeIMWorkFile(stateDir, 'wezterm');
    // No IMOrigin / daemon.pid setup
    const result = await runHookReceiver({
      stateDir,
      payload: PERMISSION_REQUEST_PAYLOAD,
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toBeUndefined();
    expect(
      (await readStateDirEntries(stateDir)).some((n) =>
        n.includes('.PermissionDialogRequest.'),
      ),
    ).toBe(false);
  });

  it('forward path: writes PermissionDialogRequest file + polls Response + returns hook output', async () => {
    await setupBoundState(stateDir);

    const updatedPermissions = [
      { type: 'addRules', behavior: 'allow', destination: 'session' },
    ];

    // Background responder simulates daemon writing a Response file.
    const respondInBackground = (async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const entries = await readStateDirEntries(stateDir);
        const reqFile = entries.find((n) =>
          n.startsWith(`${PANE_ID}_${SID}.PermissionDialogRequest.`),
        );
        if (reqFile) {
          const m = reqFile.match(
            /\.PermissionDialogRequest\.([0-9a-f]+)\.json$/,
          );
          if (m) {
            await writePermissionDialogResponseFile({
              stateDir,
              paneId: PANE_ID,
              sessionId: SID,
              requestId: m[1]!,
              decision: { behavior: 'allow', updatedPermissions },
            });
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

    const result = await runHookReceiver({
      stateDir,
      payload: PERMISSION_REQUEST_PAYLOAD,
      resolvePaneOrigin: stubPaneOrigin,
      permissionPollIntervalMs: 20,
      permissionDialogTimeoutMs: 2_000,
    });
    await respondInBackground;

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions },
      },
    });
    // Request + Response both cleaned up
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes('.PermissionDialogRequest.'))).toBe(
      false,
    );
    expect(after.some((n) => n.includes('.PermissionDialogResponse.'))).toBe(
      false,
    );
  });

  it('forward path: deny Response → forwards deny + message verbatim', async () => {
    await setupBoundState(stateDir);

    const respondInBackground = (async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const entries = await readStateDirEntries(stateDir);
        const reqFile = entries.find((n) =>
          n.startsWith(`${PANE_ID}_${SID}.PermissionDialogRequest.`),
        );
        if (reqFile) {
          const m = reqFile.match(
            /\.PermissionDialogRequest\.([0-9a-f]+)\.json$/,
          );
          if (m) {
            await writePermissionDialogResponseFile({
              stateDir,
              paneId: PANE_ID,
              sessionId: SID,
              requestId: m[1]!,
              decision: { behavior: 'deny', message: 'User said no' },
            });
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

    const result = await runHookReceiver({
      stateDir,
      payload: PERMISSION_REQUEST_PAYLOAD,
      resolvePaneOrigin: stubPaneOrigin,
      permissionPollIntervalMs: 20,
      permissionDialogTimeoutMs: 2_000,
    });
    await respondInBackground;

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'User said no' },
      },
    });
  });

  it('timeout: emits plain allow (no updatedPermissions — protects D2-A "single-yes" semantic)', async () => {
    await setupBoundState(stateDir);
    const result = await runHookReceiver({
      stateDir,
      payload: PERMISSION_REQUEST_PAYLOAD,
      resolvePaneOrigin: stubPaneOrigin,
      permissionPollIntervalMs: 20,
      permissionDialogTimeoutMs: 100, // immediate timeout
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    // Request file cleaned up after timeout
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes('.PermissionDialogRequest.'))).toBe(
      false,
    );
  });

  it('written PermissionDialogRequest file contains permission_suggestions from cc payload', async () => {
    await setupBoundState(stateDir);
    // Drive a timeout so we can inspect what the hook wrote before cleanup.
    // The polling loop's stat() runs at pollInterval cadence, so racing
    // a read between write + cleanup needs a small window — use slightly
    // longer poll than the immediate-timeout test.
    const observed: { suggestions: readonly unknown[] }[] = [];
    const observerInterval = setInterval(async () => {
      const entries = await readStateDirEntries(stateDir);
      const reqFile = entries.find((n) =>
        n.startsWith(`${PANE_ID}_${SID}.PermissionDialogRequest.`),
      );
      if (reqFile) {
        const m = reqFile.match(
          /\.PermissionDialogRequest\.([0-9a-f]+)\.json$/,
        );
        if (m) {
          const body = await readPermissionDialogRequestFile(
            join(stateDir, reqFile),
          );
          if (body) observed.push({ suggestions: body.permissionSuggestions });
        }
      }
    }, 20);

    await runHookReceiver({
      stateDir,
      payload: PERMISSION_REQUEST_PAYLOAD,
      resolvePaneOrigin: stubPaneOrigin,
      permissionPollIntervalMs: 50,
      permissionDialogTimeoutMs: 200,
    });
    clearInterval(observerInterval);

    expect(observed.length).toBeGreaterThan(0);
    expect(observed[0]!.suggestions).toEqual(
      (PERMISSION_REQUEST_PAYLOAD as { permission_suggestions: unknown })
        .permission_suggestions,
    );
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
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toBeUndefined();
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(STOP_PREFIX))).toBe(false);
  });

  it('!IMOrigin → silent exit, no Stop file', async () => {
    await writeIMWorkFile(stateDir, 'wezterm');
    const result = await runHookReceiver({
      stateDir,
      payload: STOP_PAYLOAD,
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toBeUndefined();
    const after = await readStateDirEntries(stateDir);
    expect(after.some((n) => n.includes(STOP_PREFIX))).toBe(false);
  });

  it('!daemon alive → silent exit, no Stop file', async () => {
    await writeIMWorkFile(stateDir, 'wezterm');
    await writeIMOriginFile(stateDir, LARK_CTX);
    const result = await runHookReceiver({
      stateDir,
      payload: STOP_PAYLOAD,
      resolvePaneOrigin: stubPaneOrigin,
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
      resolvePaneOrigin: stubPaneOrigin,
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

  // Crash repro: cc omits `last_assistant_message` when the final turn ends in
  // a tool call with no trailing text. The receiver must normalize the absent
  // value to '' (not crash on `.length`) and still write the Stop file — the
  // daemon-side empty guard then skips the actual IM forward.
  it('last_assistant_message omitted → writes Stop file normalized to empty string (no crash)', async () => {
    await setupBoundState(stateDir);
    const fixedNow = new Date('2026-05-08T01:43:40.131Z');
    const stopNoMsg: ParsedHookPayload = {
      session_id: SID as never,
      transcript_path: TX as never,
      cwd: CWD as never,
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: false,
      // last_assistant_message intentionally omitted (cc's real behavior).
    };
    const result = await runHookReceiver({
      stateDir,
      payload: stopNoMsg,
      resolvePaneOrigin: stubPaneOrigin,
      now: () => fixedNow,
    });
    expect(result).toBeUndefined();
    const path = stopFilePath({
      stateDir,
      paneId: PANE_ID,
      sessionId: SID,
      timestamp: '2026-05-08T01-43-40-131Z',
    });
    const got = await readStopFile(path);
    expect(got?.last_assistant_message).toBe('');
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
      resolvePaneOrigin: stubPaneOrigin,
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
      resolvePaneOrigin: stubPaneOrigin,
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
      resolvePaneOrigin: stubPaneOrigin,
    });
    expect(result).toEqual({ decision: 'block', reason: 'wake-cc' });
  });
});
