import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  resolveEventsLogPath,
  tailNewEvents,
} from './events-log.js';
import type { ParsedHookPayload } from './payloads.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';
const TX = '/Users/x/.claude/projects/-private-tmp/91215578.jsonl';
const CWD = '/private/tmp/cc-probe';

const STOP_PAYLOAD: ParsedHookPayload = {
  session_id: SID as never,
  transcript_path: TX as never,
  cwd: CWD as never,
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: '你好 ✨',
};

const SESSION_END_PAYLOAD: ParsedHookPayload = {
  session_id: SID as never,
  transcript_path: TX as never,
  cwd: CWD as never,
  hook_event_name: 'SessionEnd',
  reason: '/exit',
};

describe('events-log', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'evlog-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  describe('appendEvent', () => {
    it('writes one JSON line per event under <stateDir>/<sid>.events.jsonl', async () => {
      await appendEvent({ stateDir, sessionId: SID, payload: STOP_PAYLOAD });
      const raw = await readFile(
        join(stateDir, `${SID}.events.jsonl`),
        'utf-8',
      );
      expect(raw.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(raw.trim());
      expect(parsed.hook_event_name).toBe('Stop');
      expect(parsed.last_assistant_message).toBe('你好 ✨');
    });

    it('preserves Unicode in JSON serialization (no \\uXXXX escaping)', async () => {
      await appendEvent({ stateDir, sessionId: SID, payload: STOP_PAYLOAD });
      const raw = await readFile(
        join(stateDir, `${SID}.events.jsonl`),
        'utf-8',
      );
      expect(raw).toContain('你好 ✨');
    });

    it('is append-only (preserves prior lines)', async () => {
      await appendEvent({ stateDir, sessionId: SID, payload: STOP_PAYLOAD });
      await appendEvent({ stateDir, sessionId: SID, payload: SESSION_END_PAYLOAD });
      const lines = (
        await readFile(join(stateDir, `${SID}.events.jsonl`), 'utf-8')
      )
        .trim()
        .split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).hook_event_name).toBe('Stop');
      expect(JSON.parse(lines[1]!).hook_event_name).toBe('SessionEnd');
    });

    it('creates nested stateDir if missing', async () => {
      const nested = join(stateDir, 'multi', 'level', 'state');
      await appendEvent({
        stateDir: nested,
        sessionId: SID,
        payload: STOP_PAYLOAD,
      });
      const raw = await readFile(
        join(nested, `${SID}.events.jsonl`),
        'utf-8',
      );
      expect(JSON.parse(raw.trim()).hook_event_name).toBe('Stop');
    });
  });

  describe('tailNewEvents', () => {
    it('returns empty + offset 0 when file does not exist', async () => {
      const result = await tailNewEvents({
        filePath: join(stateDir, 'no-such.events.jsonl'),
        fromOffset: 0,
      });
      expect(result.events).toEqual([]);
      expect(result.newOffset).toBe(0);
    });

    it('reads all lines from offset 0 + advances offset to file size', async () => {
      await appendEvent({ stateDir, sessionId: SID, payload: STOP_PAYLOAD });
      await appendEvent({ stateDir, sessionId: SID, payload: SESSION_END_PAYLOAD });
      const filePath = join(stateDir, `${SID}.events.jsonl`);
      const result = await tailNewEvents({ filePath, fromOffset: 0 });
      expect(result.events).toHaveLength(2);
      expect(result.events[0]!.hook_event_name).toBe('Stop');
      expect(result.events[1]!.hook_event_name).toBe('SessionEnd');
      expect(result.newOffset).toBeGreaterThan(0);
    });

    it('returns only new events when called twice (offset advances)', async () => {
      await appendEvent({ stateDir, sessionId: SID, payload: STOP_PAYLOAD });
      const filePath = join(stateDir, `${SID}.events.jsonl`);
      const first = await tailNewEvents({ filePath, fromOffset: 0 });
      expect(first.events).toHaveLength(1);

      await appendEvent({ stateDir, sessionId: SID, payload: SESSION_END_PAYLOAD });
      const second = await tailNewEvents({ filePath, fromOffset: first.newOffset });
      expect(second.events).toHaveLength(1);
      expect(second.events[0]!.hook_event_name).toBe('SessionEnd');
    });

    it('returns no events + same offset when nothing has been appended', async () => {
      await appendEvent({ stateDir, sessionId: SID, payload: STOP_PAYLOAD });
      const filePath = join(stateDir, `${SID}.events.jsonl`);
      const first = await tailNewEvents({ filePath, fromOffset: 0 });
      const second = await tailNewEvents({ filePath, fromOffset: first.newOffset });
      expect(second.events).toEqual([]);
      expect(second.newOffset).toBe(first.newOffset);
    });

    it('skips malformed JSON lines but reports them via onParseError', async () => {
      const filePath = join(stateDir, `${SID}.events.jsonl`);
      // Manually write a malformed line + a valid one
      await appendEvent({ stateDir, sessionId: SID, payload: STOP_PAYLOAD });
      await readFile(filePath, 'utf-8');
      const { writeFile, readFile: rf } = await import('node:fs/promises');
      const valid = JSON.stringify(STOP_PAYLOAD);
      await writeFile(
        filePath,
        `${valid}\nnot-json{{{\n${valid}\n`,
        'utf-8',
      );
      void rf;
      const errors: { line: string; error: unknown }[] = [];
      const result = await tailNewEvents({
        filePath,
        fromOffset: 0,
        onParseError: (line, error) => errors.push({ line, error }),
      });
      expect(result.events).toHaveLength(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.line).toBe('not-json{{{');
    });
  });

  describe('resolveEventsLogPath', () => {
    it('returns <stateDir>/<sessionId>.events.jsonl', () => {
      expect(resolveEventsLogPath({ stateDir: '/x', sessionId: SID })).toBe(
        `/x/${SID}.events.jsonl`,
      );
    });
  });
});
