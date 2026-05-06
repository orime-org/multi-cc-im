import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CLIHandler,
  SessionEndPayload,
  SessionId,
  SessionStartPayload,
  StopPayload,
} from '@multi-cc-im/shared';
import { createCcCliAdapter } from './adapter.js';
import { resolveInjectionQueuePath } from './injection-queue.js';
import {
  sessionEndPath,
  sessionStartPath,
  stopFilePath,
  writeSessionEndFile,
  writeSessionStartFile,
  writeStopFile,
} from './state-files.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const SID2 = '5780668a-0000-4fe4-b01d-aaaaaaaaaaaa';
const TX = '/Users/x/.claude/projects/-private-tmp/91215578.jsonl';
const CWD = '/private/tmp/cc-probe';

interface RecordedEvent {
  kind: 'SessionStart' | 'Stop' | 'SessionEnd';
  payload: SessionStartPayload | StopPayload | SessionEndPayload;
}

function makeRecorder(overrides?: {
  onSessionStartThrow?: Error;
  onStopThrow?: Error;
  onSessionEndThrow?: Error;
}): { events: RecordedEvent[]; handler: CLIHandler } {
  const events: RecordedEvent[] = [];
  const handler: CLIHandler = {
    async onSessionStart(p: SessionStartPayload) {
      events.push({ kind: 'SessionStart', payload: p });
      if (overrides?.onSessionStartThrow) throw overrides.onSessionStartThrow;
    },
    async onStop(p: StopPayload) {
      events.push({ kind: 'Stop', payload: p });
      if (overrides?.onStopThrow) throw overrides.onStopThrow;
    },
    async onSessionEnd(p: SessionEndPayload) {
      events.push({ kind: 'SessionEnd', payload: p });
      if (overrides?.onSessionEndThrow) throw overrides.onSessionEndThrow;
    },
  };
  return { events, handler };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`waitFor: predicate did not pass within ${timeoutMs}ms`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const SESSION_START_FILE = {
  pid: 12345,
  startedAt: 'Tue May  4 16:38:00 2026',
  cwd: CWD,
  transcript_path: TX,
};

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

  describe('backlog dispatch on start()', () => {
    it('pre-existing <sid>.SessionStart → handler.onSessionStart called', async () => {
      await writeSessionStartFile({
        stateDir,
        sessionId: SID,
        ...SESSION_START_FILE,
      });
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      try {
        await waitFor(() => events.length === 1);
        expect(events[0]!.kind).toBe('SessionStart');
        const payload = events[0]!.payload as SessionStartPayload;
        expect(payload.session_id).toBe(SID);
        expect(payload.cwd).toBe(CWD);
        expect(payload.transcript_path).toBe(TX);
        // SessionStart file is NOT unlinked — long-lived snapshot.
        expect(
          await fileExists(sessionStartPath({ stateDir, sessionId: SID })),
        ).toBe(true);
      } finally {
        await adapter.stop();
      }
    });

    it('pre-existing <sid>.Stop.<ts> → handler.onStop called + file unlinked', async () => {
      const timestamp = '2026-05-06T16-20-15-123Z';
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp,
        last_assistant_message: 'hello',
      });
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      try {
        await waitFor(() => events.length === 1);
        expect(events[0]!.kind).toBe('Stop');
        expect(
          (events[0]!.payload as StopPayload).last_assistant_message,
        ).toBe('hello');
        // File unlinked after successful dispatch.
        await waitFor(async () => {
          return !(await fileExists(
            stopFilePath({ stateDir, sessionId: SID, timestamp }),
          ));
        });
      } finally {
        await adapter.stop();
      }
    });

    it('pre-existing <sid>.SessionEnd → handler.onSessionEnd called + file kept as tombstone', async () => {
      await writeSessionEndFile({ stateDir, sessionId: SID });
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      try {
        await waitFor(() => events.length === 1);
        expect(events[0]!.kind).toBe('SessionEnd');
        // Tombstone preserved.
        expect(
          await fileExists(sessionEndPath({ stateDir, sessionId: SID })),
        ).toBe(true);
      } finally {
        await adapter.stop();
      }
    });
  });

  describe('live add dispatch', () => {
    it('SessionStart create after start → dispatched (file not unlinked)', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      try {
        await writeSessionStartFile({
          stateDir,
          sessionId: SID,
          ...SESSION_START_FILE,
        });
        await waitFor(() => events.length === 1);
        expect(events[0]!.kind).toBe('SessionStart');
        expect(
          await fileExists(sessionStartPath({ stateDir, sessionId: SID })),
        ).toBe(true);
      } finally {
        await adapter.stop();
      }
    });

    it('Stop create → dispatched + unlinked', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      try {
        const timestamp = '2026-05-06T16-20-15-123Z';
        await writeStopFile({
          stateDir,
          sessionId: SID,
          timestamp,
          last_assistant_message: 'live-msg',
        });
        await waitFor(() => events.length === 1);
        expect(events[0]!.kind).toBe('Stop');
        expect(
          (events[0]!.payload as StopPayload).last_assistant_message,
        ).toBe('live-msg');
        await waitFor(async () => {
          return !(await fileExists(
            stopFilePath({ stateDir, sessionId: SID, timestamp }),
          ));
        });
      } finally {
        await adapter.stop();
      }
    });

    it('SessionEnd create → dispatched, NOT unlinked', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      try {
        await writeSessionEndFile({ stateDir, sessionId: SID });
        await waitFor(() => events.length === 1);
        expect(events[0]!.kind).toBe('SessionEnd');
        expect(
          await fileExists(sessionEndPath({ stateDir, sessionId: SID })),
        ).toBe(true);
      } finally {
        await adapter.stop();
      }
    });
  });

  describe('basename classification', () => {
    it('ignores files that do not match the SID-prefix + known suffix pattern', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      try {
        // Legacy / unrelated names that should never trigger dispatch.
        await writeFile(join(stateDir, `${SID}.cc-pid`), '{}');
        await writeFile(join(stateDir, `${SID}.events.jsonl`), '{}\n');
        await writeFile(join(stateDir, 'current-session'), 'x');
        await writeFile(join(stateDir, 'random.txt'), 'x');
        // Give the watcher a beat to NOT process them.
        await new Promise((r) => setTimeout(r, 200));
        expect(events).toHaveLength(0);
      } finally {
        await adapter.stop();
      }
    });
  });

  describe('per-session ordering', () => {
    it('multiple Stop files for the same sid dispatch in timestamp order', async () => {
      const t1 = '2026-05-06T16-20-15-123Z';
      const t2 = '2026-05-06T16-20-16-000Z';
      const t3 = '2026-05-06T16-20-17-456Z';
      // Pre-populate so chokidar emits all 3 'add' events near-simultaneously
      // during initial scan; per-session chain must serialize in t1<t2<t3
      // order regardless of FS ordering.
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: t1,
        last_assistant_message: 'first',
      });
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: t2,
        last_assistant_message: 'second',
      });
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: t3,
        last_assistant_message: 'third',
      });

      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      try {
        await waitFor(() => events.length === 3);
        const messages = events.map(
          (e) => (e.payload as StopPayload).last_assistant_message,
        );
        expect(messages).toEqual(['first', 'second', 'third']);
      } finally {
        await adapter.stop();
      }
    });

    it('events from different sessions both dispatch', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      try {
        await writeSessionEndFile({ stateDir, sessionId: SID });
        await writeStopFile({
          stateDir,
          sessionId: SID2,
          timestamp: '2026-05-06T16-20-15-123Z',
          last_assistant_message: 'msg2',
        });
        await waitFor(() => events.length === 2);
        const kinds = events.map((e) => e.kind).sort();
        expect(kinds).toEqual(['SessionEnd', 'Stop']);
      } finally {
        await adapter.stop();
      }
    });
  });

  describe('handler errors', () => {
    it('handler error during Stop: onHandlerError called, file NOT unlinked', async () => {
      const handlerErrors: { kind: string; sid: string; err: unknown }[] = [];
      const adapter = createCcCliAdapter({
        stateDir,
        onHandlerError: (err, ctx) =>
          handlerErrors.push({
            kind: ctx.kind,
            sid: ctx.sessionId,
            err,
          }),
      });
      const { handler } = makeRecorder({ onStopThrow: new Error('boom') });
      const timestamp = '2026-05-06T16-20-15-123Z';
      const path = stopFilePath({ stateDir, sessionId: SID, timestamp });
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp,
        last_assistant_message: 'will-fail',
      });
      await adapter.start(handler);
      try {
        await waitFor(() => handlerErrors.length === 1);
        expect(handlerErrors[0]!.kind).toBe('Stop');
        expect(handlerErrors[0]!.sid).toBe(SID);
        expect((handlerErrors[0]!.err as Error).message).toBe('boom');
        // File preserved so next run can retry.
        expect(await fileExists(path)).toBe(true);
      } finally {
        await adapter.stop();
      }
    });

    it('handler error during SessionStart: onHandlerError called', async () => {
      const handlerErrors: { kind: string; err: unknown }[] = [];
      const adapter = createCcCliAdapter({
        stateDir,
        onHandlerError: (err, ctx) =>
          handlerErrors.push({ kind: ctx.kind, err }),
      });
      const { handler } = makeRecorder({
        onSessionStartThrow: new Error('start-fail'),
      });
      await writeSessionStartFile({
        stateDir,
        sessionId: SID,
        ...SESSION_START_FILE,
      });
      await adapter.start(handler);
      try {
        await waitFor(() => handlerErrors.length === 1);
        expect(handlerErrors[0]!.kind).toBe('SessionStart');
        expect((handlerErrors[0]!.err as Error).message).toBe('start-fail');
      } finally {
        await adapter.stop();
      }
    });

    it('handler error keeps the watcher alive (subsequent events still dispatch)', async () => {
      const handlerErrors: unknown[] = [];
      const adapter = createCcCliAdapter({
        stateDir,
        onHandlerError: (err) => handlerErrors.push(err),
      });
      const events: string[] = [];
      const handler: CLIHandler = {
        async onSessionStart() {
          events.push('SessionStart');
          throw new Error('boom');
        },
        async onStop() {
          events.push('Stop');
        },
        async onSessionEnd() {
          events.push('SessionEnd');
        },
      };
      await adapter.start(handler);
      try {
        await writeSessionStartFile({
          stateDir,
          sessionId: SID,
          ...SESSION_START_FILE,
        });
        await writeSessionEndFile({ stateDir, sessionId: SID });
        await waitFor(() => events.length === 2);
        expect(handlerErrors).toHaveLength(1);
        expect(events).toContain('SessionStart');
        expect(events).toContain('SessionEnd');
      } finally {
        await adapter.stop();
      }
    });
  });

  describe('enqueueInjection', () => {
    it('delegates to injection-queue (file is appended FIFO)', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      await adapter.enqueueInjection(SID as SessionId, 'first');
      await adapter.enqueueInjection(SID as SessionId, 'second');
      const queuePath = resolveInjectionQueuePath({
        stateDir,
        sessionId: SID,
      });
      const lines = (await readFile(queuePath, 'utf-8'))
        .trim()
        .split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).content).toBe('first');
      expect(JSON.parse(lines[1]!).content).toBe('second');
    });
  });

  describe('lifecycle', () => {
    it('start twice throws (single subscriber model)', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { handler } = makeRecorder();
      await adapter.start(handler);
      try {
        await expect(adapter.start(handler)).rejects.toThrow(
          /already started/,
        );
      } finally {
        await adapter.stop();
      }
    });

    it('stop drains in-flight dispatches before resolving', async () => {
      // Use a slow handler so dispatch is in-flight when stop() is called.
      let resolveStop: (() => void) | undefined;
      const inFlight = new Promise<void>((r) => {
        resolveStop = r;
      });
      let stopCallCompleted = false;
      const handler: CLIHandler = {
        async onSessionStart() {},
        async onStop() {
          await inFlight;
          stopCallCompleted = true;
        },
        async onSessionEnd() {},
      };
      const adapter = createCcCliAdapter({ stateDir });
      await adapter.start(handler);
      const timestamp = '2026-05-06T16-20-15-123Z';
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp,
        last_assistant_message: 'slow',
      });
      // Wait for handler.onStop to begin (file dispatch is queued).
      await new Promise((r) => setTimeout(r, 100));
      // Initiate stop — must wait for inFlight to drain.
      const stopPromise = adapter.stop();
      // Release the handler.
      resolveStop?.();
      await stopPromise;
      expect(stopCallCompleted).toBe(true);
    });

    it('after stop, no further callbacks fire for new files', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);
      await adapter.stop();
      await writeStopFile({
        stateDir,
        sessionId: SID,
        timestamp: '2026-05-06T16-20-15-123Z',
        last_assistant_message: 'after-stop',
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(events).toHaveLength(0);
    });
  });
});
