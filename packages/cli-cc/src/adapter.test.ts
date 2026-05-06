import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CLIHandler,
  HookDecision,
  SessionEndPayload,
  SessionId,
  SessionStartPayload,
  StopPayload,
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

const STOP = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: 'hi',
} as const;

const SESSION_END = {
  session_id: SID,
  transcript_path: TX,
  cwd: CWD,
  hook_event_name: 'SessionEnd',
  reason: '/exit',
} as const;

function makeRecorder() {
  const events: { kind: string; payload: unknown }[] = [];
  const stopReturn: HookDecision | void = undefined;
  const handler: CLIHandler = {
    async onSessionStart(p: SessionStartPayload) {
      events.push({ kind: 'SessionStart', payload: p });
    },
    async onStop(p: StopPayload) {
      events.push({ kind: 'Stop', payload: p });
      return stopReturn;
    },
    async onSessionEnd(p: SessionEndPayload) {
      events.push({ kind: 'SessionEnd', payload: p });
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
      payload: SESSION_END as never,
    });

    const adapter = createCcCliAdapter({ stateDir });
    const { events, handler } = makeRecorder();
    await adapter.start(handler);
    try {
      await waitFor(() => events.length === 2);
      expect(events.map((e) => e.kind)).toEqual([
        'SessionStart',
        'SessionEnd',
      ]);
      expect((events[0]!.payload as SessionStartPayload).source).toBe('startup');
      expect((events[1]!.payload as SessionEndPayload).reason).toBe('/exit');
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
        payload: SESSION_END as never,
      });
      await appendEvent({
        stateDir,
        sessionId: SID2,
        payload: STOP as never,
      });
      await waitFor(() => events.length === 2);
      const kinds = events.map((e) => e.kind).sort();
      expect(kinds).toEqual(['SessionEnd', 'Stop']);
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

  it('SessionEnd dispatches through handler.onSessionEnd', async () => {
    const adapter = createCcCliAdapter({ stateDir });
    const { events, handler } = makeRecorder();
    await adapter.start(handler);
    try {
      await appendEvent({
        stateDir,
        sessionId: SID,
        payload: SESSION_END as never,
      });
      await waitFor(() => events.length === 1);
      expect(events[0]!.kind).toBe('SessionEnd');
      expect((events[0]!.payload as SessionEndPayload).reason).toBe('/exit');
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
      async onStop() {},
      async onSessionEnd() {
        // works fine
      },
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
        payload: SESSION_END as never,
      });
      await waitFor(() => handlerErrors.length === 1);
      expect(handlerErrors[0]!.message).toBe('boom');
      // Watcher kept going past the error — SessionEnd should have
      // been processed without re-throwing.
    } finally {
      await adapter.stop();
    }
  });
});
