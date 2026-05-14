import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CLIHandler,
  PaneId,
  PreToolUsePayload,
  SessionId,
  StopPayload,
} from '@multi-cc-im/shared';
import { createCcCliAdapter } from './adapter.js';
import { resolveInjectionQueuePath } from './injection-queue.js';
import {
  permissionRequestPath,
  stopFilePath,
  writePermissionRequestFile,
  writeStopFile,
} from './state-files.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const SID2 = '5780668a-0000-4fe4-b01d-aaaaaaaaaaaa';
const PANE_ID = 42 as unknown as PaneId;
const PANE_ID2 = 99 as unknown as PaneId;

interface RecordedEvent {
  kind: 'PreToolUse' | 'Stop';
  payload:
    | (PreToolUsePayload & { requestId: string; paneId: PaneId })
    | (StopPayload & { paneId: PaneId });
}

function makeRecorder(overrides?: {
  onStopThrow?: Error;
  onPreToolUseThrow?: Error;
}): { events: RecordedEvent[]; handler: CLIHandler } {
  const events: RecordedEvent[] = [];
  const handler: CLIHandler = {
    async onPreToolUse(p) {
      events.push({
        kind: 'PreToolUse',
        payload: p as PreToolUsePayload & {
          requestId: string;
          paneId: PaneId;
        },
      });
      if (overrides?.onPreToolUseThrow) throw overrides.onPreToolUseThrow;
    },
    async onStop(p) {
      events.push({
        kind: 'Stop',
        payload: p as StopPayload & { paneId: PaneId },
      });
      if (overrides?.onStopThrow) throw overrides.onStopThrow;
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

describe('createCcCliAdapter', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cli-cc-adapter-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  describe('start / stop lifecycle', () => {
    it('start() then stop() succeeds without watcher errors', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { handler } = makeRecorder();
      await adapter.start(handler);
      await adapter.stop();
    });

    it('start() throws when called twice (already started)', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { handler } = makeRecorder();
      await adapter.start(handler);
      await expect(adapter.start(handler)).rejects.toThrow(/already started/);
      await adapter.stop();
    });

    it('stop() is idempotent', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { handler } = makeRecorder();
      await adapter.start(handler);
      await adapter.stop();
      await expect(adapter.stop()).resolves.toBeUndefined();
    });
  });

  describe('Stop file dispatch (live event)', () => {
    it('dispatches onStop with paneId + sessionId in payload', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);

      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: '2026-05-08T01-43-40-131Z',
        last_assistant_message: 'hello',
        termId: 'wezterm',
      });

      await waitFor(() =>
        events.some(
          (e) =>
            e.kind === 'Stop' &&
            (e.payload as StopPayload).last_assistant_message === 'hello',
        ),
      );
      const ev = events.find((e) => e.kind === 'Stop')!;
      expect((ev.payload as StopPayload & { paneId: PaneId }).paneId).toBe(
        PANE_ID,
      );
      expect(ev.payload.session_id).toBe(SID);

      await adapter.stop();
    });

    it('unlinks the Stop file after successful onStop', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);

      const ts = '2026-05-08T01-43-40-131Z';
      const path = stopFilePath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: ts,
      });
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: ts,
        last_assistant_message: 'x',
        termId: 'wezterm',
      });

      await waitFor(() => events.length === 1);
      await waitFor(async () => !(await fileExists(path)));

      await adapter.stop();
    });

    it('deletes the Stop file even when handler throws (delete-always per user policy 2026-05-11)', async () => {
      // Previous behavior kept the file "for next-run retry / sweep
      // cleanup" but daemon's state-sweep only runs at start, so the
      // retry never actually happened. New policy: once dispatched,
      // delete regardless of forward success — leave nothing behind.
      const adapter = createCcCliAdapter({
        stateDir,
        onHandlerError: () => undefined,
      });
      const { handler } = makeRecorder({ onStopThrow: new Error('boom') });
      await adapter.start(handler);

      const ts = '2026-05-08T01-43-40-131Z';
      const path = stopFilePath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: ts,
      });
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: ts,
        last_assistant_message: 'x',
        termId: 'wezterm',
      });

      // File is deleted even on handler throw — try/finally semantics.
      await waitFor(async () => !(await fileExists(path)));

      await adapter.stop();
    });
  });

  describe('PermissionRequest dispatch', () => {
    it('dispatches onPreToolUse with paneId + requestId in payload', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);

      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'deadbeef',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        createdAt: 1700000000000,
      });

      await waitFor(() => events.length === 1);
      const ev = events[0]!;
      expect(ev.kind).toBe('PreToolUse');
      const p = ev.payload as PreToolUsePayload & {
        paneId: PaneId;
        requestId: string;
      };
      expect(p.paneId).toBe(PANE_ID);
      expect(p.requestId).toBe('deadbeef');
      expect(p.tool_name).toBe('Bash');
      expect(p.tool_input).toEqual({ command: 'ls' });

      await adapter.stop();
    });

    it('does NOT unlink the Request file (hook owns cleanup)', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);

      const path = permissionRequestPath({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'aabb1111',
      });
      await writePermissionRequestFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        requestId: 'aabb1111',
        toolName: 'Bash',
        toolInput: {},
        createdAt: 0,
      });

      await waitFor(() => events.length === 1);
      // Confirm file is still there (hook owns cleanup).
      expect(await fileExists(path)).toBe(true);

      await adapter.stop();
    });
  });

  describe('per-pane+sid serial dispatch', () => {
    it('serializes Stop events for the same (paneId, sid)', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const events: string[] = [];
      const handler: CLIHandler = {
        async onPreToolUse() {},
        async onStop(p) {
          // Slow dispatch — second event must wait.
          events.push(`start:${p.last_assistant_message}`);
          await new Promise((r) => setTimeout(r, 80));
          events.push(`end:${p.last_assistant_message}`);
        },
      };
      await adapter.start(handler);

      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'T1',
        last_assistant_message: 'a',
        termId: 'wezterm',
      });
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'T2',
        last_assistant_message: 'b',
        termId: 'wezterm',
      });

      await waitFor(() => events.length === 4);
      // start:a → end:a → start:b → end:b (NOT interleaved)
      expect(events).toEqual([
        'start:a',
        'end:a',
        'start:b',
        'end:b',
      ]);

      await adapter.stop();
    });

    it('parallel dispatch for different (paneId, sid) pairs', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      let inFlight = 0;
      let maxInFlight = 0;
      const handler: CLIHandler = {
        async onPreToolUse() {},
        async onStop() {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // Wide enough overlap window for chokidar's file-event delivery on
          // CI runners (where load can push event latency past the 80ms used
          // earlier — see 2026-05-13 flaky CI on main post-PR-#160).
          await new Promise((r) => setTimeout(r, 200));
          inFlight--;
        },
      };
      await adapter.start(handler);

      // Concurrent writes so chokidar observes both events nearly
      // simultaneously. Sequential awaits would let chokidar dispatch
      // the first file and finish its 200ms handler before the second
      // file's event ever fires — the original race that flaked CI.
      await Promise.all([
        writeStopFile({
          stateDir,
          paneId: PANE_ID,
          sessionId: SID,
          timestamp: 'T1',
          last_assistant_message: 'a',
        termId: 'wezterm',
        }),
        writeStopFile({
          stateDir,
          paneId: PANE_ID2,
          sessionId: SID2,
          timestamp: 'T1',
          last_assistant_message: 'b',
        termId: 'wezterm',
        }),
      ]);

      // Strong wait: only success is maxInFlight reaching 2. No escape
      // hatch on `inFlight === 0` — that's what masked the failure
      // before (waitFor returned early when dispatch 1 completed before
      // dispatch 2 even started). If the contract breaks, waitFor times
      // out at 2s and the test fails correctly.
      await waitFor(() => maxInFlight === 2);
      expect(maxInFlight).toBe(2);

      await adapter.stop();
    });
  });

  describe('initial scan (backlog)', () => {
    it('drains backlog Stop files in chronological (filename-sorted) order', async () => {
      // Pre-seed before start().
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'T2',
        last_assistant_message: 'b',
        termId: 'wezterm',
      });
      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'T1',
        last_assistant_message: 'a',
        termId: 'wezterm',
      });

      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);

      await waitFor(() => events.length === 2);
      const messages = events.map(
        (e) => (e.payload as StopPayload).last_assistant_message,
      );
      expect(messages).toEqual(['a', 'b']);

      await adapter.stop();
    });

    it('ignores top-level files like IMWork / daemon.pid / IM-adapter cursor files', async () => {
      await import('node:fs/promises').then(async (fs) => {
        await fs.writeFile(join(stateDir, 'IMWork'), '');
        await fs.writeFile(join(stateDir, 'daemon.pid'), '{"pid":1}');
        // Any non-cc-hook top-level file (e.g. an IM adapter's long-poll
        // cursor like `lark-cursor`) must not trigger dispatch.
        await fs.writeFile(join(stateDir, 'lark-cursor'), '0');
      });

      const adapter = createCcCliAdapter({ stateDir });
      const { events, handler } = makeRecorder();
      await adapter.start(handler);

      // Wait a beat — none of these top-level files should dispatch.
      await new Promise((r) => setTimeout(r, 200));
      expect(events).toHaveLength(0);

      await adapter.stop();
    });
  });

  describe('enqueueInjection', () => {
    it('appends content to <stateDir>/<sid>.injection-queue.jsonl', async () => {
      const adapter = createCcCliAdapter({ stateDir });
      const { handler } = makeRecorder();
      await adapter.start(handler);

      await adapter.enqueueInjection(SID as unknown as SessionId, 'wake-cc');

      const path = resolveInjectionQueuePath({
        stateDir,
        sessionId: SID as unknown as SessionId,
      });
      const buf = await readFile(path, 'utf-8');
      expect(buf.trim()).toBe(JSON.stringify({ content: 'wake-cc' }));

      await adapter.stop();
    });
  });

  describe('error reporting', () => {
    it('calls onHandlerError with kind/paneId/sessionId on Stop throw', async () => {
      const errors: Array<{
        err: unknown;
        context: { kind: string; paneId: PaneId; sessionId: string };
      }> = [];
      const adapter = createCcCliAdapter({
        stateDir,
        onHandlerError: (err, context) => {
          errors.push({ err, context });
        },
      });
      const { handler } = makeRecorder({ onStopThrow: new Error('boom') });
      await adapter.start(handler);

      await writeStopFile({
        stateDir,
        paneId: PANE_ID,
        sessionId: SID,
        timestamp: 'T1',
        last_assistant_message: 'x',
        termId: 'wezterm',
      });

      await waitFor(() => errors.length === 1);
      expect(errors[0]?.context).toEqual({
        kind: 'Stop',
        paneId: PANE_ID,
        sessionId: SID,
      });
      expect((errors[0]?.err as Error).message).toBe('boom');

      await adapter.stop();
    });
  });
});
