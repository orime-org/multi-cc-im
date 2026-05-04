import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CLIHandler,
  HookDecision,
  PostToolUsePayload,
  PreToolUsePayload,
  SessionId,
  SessionStartPayload,
  StopPayload,
  UserPromptSubmitPayload,
} from '@multi-cc-im/shared';
import { createCcCliAdapter } from './adapter.js';
import { appendEvent } from './events-log.js';
import { resolveInjectionQueuePath } from './injection-queue.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const TX = '/Users/x/.claude/projects/-private-tmp/91215578.jsonl';
const CWD = '/private/tmp/cc-probe';

const SESSION_START = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'SessionStart',
  source: 'startup',
  model: 'claude-opus-4-7[1m]',
} as const;

const USER = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'UserPromptSubmit',
  permission_mode: 'default',
  prompt: 'hi',
} as const;

const STOP = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: 'hi',
} as const;

function makeRecorder() {
  const events: { kind: string; payload: unknown }[] = [];
  const stopReturn: HookDecision | void = undefined;
  const handler: CLIHandler = {
    async onSessionStart(p) {
      events.push({ kind: 'SessionStart', payload: p });
    },
    async onUserPromptSubmit(p) {
      events.push({ kind: 'UserPromptSubmit', payload: p });
    },
    async onPreToolUse(p) {
      events.push({ kind: 'PreToolUse', payload: p });
    },
    async onPostToolUse(p) {
      events.push({ kind: 'PostToolUse', payload: p });
    },
    async onStop(p) {
      events.push({ kind: 'Stop', payload: p });
      return stopReturn;
    },
  };
  return { events, handler };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`waitFor: predicate did not pass within ${timeoutMs}ms`);
}

describe('createCcCliAdapter', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-adp-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('exposes name = "claude-code"', () => {
    const adapter = createCcCliAdapter({ stateDir });
    expect(adapter.name).toBe('claude-code');
  });

  it('start → tail existing events.jsonl backlog → dispatch to handler', async () => {
    // Pre-populate before start to test backlog handling
    await appendEvent({
      stateDir,
      sessionId: SID,
      payload: SESSION_START as never,
    });
    await appendEvent({
      stateDir,
      sessionId: SID,
      payload: USER as never,
    });

    const adapter = createCcCliAdapter({ stateDir });
    const { events, handler } = makeRecorder();
    await adapter.start(handler);
    try {
      await waitFor(() => events.length === 2);
      expect(events.map((e) => e.kind)).toEqual([
        'SessionStart',
        'UserPromptSubmit',
      ]);
      expect((events[0]!.payload as SessionStartPayload).source).toBe('startup');
      expect((events[1]!.payload as UserPromptSubmitPayload).prompt).toBe('hi');
    } finally {
      await adapter.stop();
    }
  });

  it('start → live append → handler called for new events only', async () => {
    const adapter = createCcCliAdapter({ stateDir });
    const { events, handler } = makeRecorder();
    await adapter.start(handler);
    try {
      await appendEvent({
        stateDir,
        sessionId: SID,
        payload: STOP as never,
      });
      await waitFor(() => events.length === 1);
      expect(events[0]!.kind).toBe('Stop');
      expect((events[0]!.payload as StopPayload).last_assistant_message).toBe(
        'hi',
      );
    } finally {
      await adapter.stop();
    }
  });

  it('start → events from multiple sessions all dispatch (events.jsonl per session)', async () => {
    const SID2 = '5780668a-0000-4fe4-b01d-aaaaaaaaaaaa' as SessionId;
    const adapter = createCcCliAdapter({ stateDir });
    const { events, handler } = makeRecorder();
    await adapter.start(handler);
    try {
      await appendEvent({
        stateDir,
        sessionId: SID,
        payload: USER as never,
      });
      await appendEvent({
        stateDir,
        sessionId: SID2,
        payload: STOP as never,
      });
      await waitFor(() => events.length === 2);
      const kinds = events.map((e) => e.kind).sort();
      expect(kinds).toEqual(['Stop', 'UserPromptSubmit']);
    } finally {
      await adapter.stop();
    }
  });

  it('stop → no further callbacks', async () => {
    const adapter = createCcCliAdapter({ stateDir });
    const { events, handler } = makeRecorder();
    await adapter.start(handler);
    await adapter.stop();
    await appendEvent({
      stateDir,
      sessionId: SID,
      payload: STOP as never,
    });
    // Give the watcher a beat to NOT process the new line
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toHaveLength(0);
  });

  it('start twice throws (single subscriber model)', async () => {
    const adapter = createCcCliAdapter({ stateDir });
    const { handler } = makeRecorder();
    await adapter.start(handler);
    try {
      await expect(adapter.start(handler)).rejects.toThrow(/already started/);
    } finally {
      await adapter.stop();
    }
  });

  it('PreToolUse / PostToolUse dispatch through respective handler methods', async () => {
    const adapter = createCcCliAdapter({ stateDir });
    const { events, handler } = makeRecorder();
    const PRE_TOOL_USE = {
      session_id: SID,
      transcript_path: TX,
      cwd: CWD,
      hook_event_name: 'PreToolUse',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tool-abc',
    };
    const POST_TOOL_USE = {
      ...PRE_TOOL_USE,
      hook_event_name: 'PostToolUse',
      tool_response: {
        stdout: 'foo\n',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
      duration_ms: 42,
    };
    await adapter.start(handler);
    try {
      await appendEvent({
        stateDir,
        sessionId: SID,
        payload: PRE_TOOL_USE as never,
      });
      await appendEvent({
        stateDir,
        sessionId: SID,
        payload: POST_TOOL_USE as never,
      });
      await waitFor(() => events.length === 2);
      expect((events[0]!.payload as PreToolUsePayload).tool_name).toBe('Bash');
      expect((events[1]!.payload as PostToolUsePayload).duration_ms).toBe(42);
    } finally {
      await adapter.stop();
    }
  });

  it('SessionEnd events are dispatched on a noop path (no Handler.onSessionEnd yet)', async () => {
    const SESSION_END = {
      session_id: SID,
      transcript_path: TX,
      cwd: CWD,
      hook_event_name: 'SessionEnd',
      reason: '/exit',
    };
    const adapter = createCcCliAdapter({ stateDir });
    const { events, handler } = makeRecorder();
    await adapter.start(handler);
    try {
      await appendEvent({
        stateDir,
        sessionId: SID,
        payload: SESSION_END as never,
      });
      // SessionEnd has no Handler callback (deferred); should not throw
      await new Promise((r) => setTimeout(r, 150));
      expect(events).toHaveLength(0);
    } finally {
      await adapter.stop();
    }
  });

  it('enqueueInjection writes to <sid>.injection-queue.jsonl FIFO', async () => {
    const adapter = createCcCliAdapter({ stateDir });
    await adapter.enqueueInjection(SID as SessionId, 'first');
    await adapter.enqueueInjection(SID as SessionId, 'second');
    const queuePath = resolveInjectionQueuePath({ stateDir, sessionId: SID });
    const lines = (await readFile(queuePath, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).content).toBe('first');
    expect(JSON.parse(lines[1]!).content).toBe('second');
  });

  it('handler error is swallowed with onHandlerError callback (does not stop the watcher)', async () => {
    const handlerErrors: Error[] = [];
    const adapter = createCcCliAdapter({
      stateDir,
      onHandlerError: (err) => handlerErrors.push(err as Error),
    });
    const handler: CLIHandler = {
      async onSessionStart() {
        throw new Error('boom');
      },
      async onUserPromptSubmit() {
        // works fine
      },
      async onPreToolUse() {},
      async onPostToolUse() {},
      async onStop() {},
    };
    await adapter.start(handler);
    try {
      await appendEvent({
        stateDir,
        sessionId: SID,
        payload: SESSION_START as never,
      });
      await appendEvent({
        stateDir,
        sessionId: SID,
        payload: USER as never,
      });
      await waitFor(() => handlerErrors.length === 1);
      expect(handlerErrors[0]!.message).toBe('boom');
      // Watcher kept going past the error — UserPromptSubmit should have
      // been processed without re-throwing.
    } finally {
      await adapter.stop();
    }
  });
});
