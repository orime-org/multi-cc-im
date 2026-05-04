import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enqueueInjection,
  popInjection,
  resolveInjectionQueuePath,
} from './injection-queue.js';

const SID = '91215578-3606-4fe4-b01d-c436bf804790';

describe('injection-queue', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'inj-q-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  describe('enqueueInjection', () => {
    it('writes one JSON line per content under <stateDir>/<sid>.injection-queue.jsonl', async () => {
      await enqueueInjection({ stateDir, sessionId: SID, content: 'hello' });
      const raw = await readFile(
        join(stateDir, `${SID}.injection-queue.jsonl`),
        'utf-8',
      );
      const parsed = JSON.parse(raw.trim());
      expect(parsed.content).toBe('hello');
    });

    it('preserves Unicode + multiline content verbatim', async () => {
      const tricky = '你好 ✨\n第二行\n第三行';
      await enqueueInjection({ stateDir, sessionId: SID, content: tricky });
      const raw = await readFile(
        join(stateDir, `${SID}.injection-queue.jsonl`),
        'utf-8',
      );
      const parsed = JSON.parse(raw.trim());
      expect(parsed.content).toBe(tricky);
    });

    it('appends FIFO: subsequent enqueues add new lines at end', async () => {
      await enqueueInjection({ stateDir, sessionId: SID, content: 'first' });
      await enqueueInjection({ stateDir, sessionId: SID, content: 'second' });
      await enqueueInjection({ stateDir, sessionId: SID, content: 'third' });
      const raw = await readFile(
        join(stateDir, `${SID}.injection-queue.jsonl`),
        'utf-8',
      );
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]!).content).toBe('first');
      expect(JSON.parse(lines[1]!).content).toBe('second');
      expect(JSON.parse(lines[2]!).content).toBe('third');
    });

    it('creates nested stateDir if missing', async () => {
      const nested = join(stateDir, 'level1', 'level2');
      await enqueueInjection({
        stateDir: nested,
        sessionId: SID,
        content: 'x',
      });
      expect(await popInjection({ stateDir: nested, sessionId: SID })).toBe('x');
    });
  });

  describe('popInjection', () => {
    it('returns null when queue file does not exist', async () => {
      expect(await popInjection({ stateDir, sessionId: SID })).toBeNull();
    });

    it('FIFO: pops the OLDEST enqueued content first', async () => {
      await enqueueInjection({ stateDir, sessionId: SID, content: 'first' });
      await enqueueInjection({ stateDir, sessionId: SID, content: 'second' });
      expect(await popInjection({ stateDir, sessionId: SID })).toBe('first');
      expect(await popInjection({ stateDir, sessionId: SID })).toBe('second');
      expect(await popInjection({ stateDir, sessionId: SID })).toBeNull();
    });

    it('atomic pop: file content is rewritten without the popped line', async () => {
      await enqueueInjection({ stateDir, sessionId: SID, content: 'a' });
      await enqueueInjection({ stateDir, sessionId: SID, content: 'b' });
      await popInjection({ stateDir, sessionId: SID });
      const raw = await readFile(
        join(stateDir, `${SID}.injection-queue.jsonl`),
        'utf-8',
      );
      const lines = raw.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).content).toBe('b');
    });

    it('skips malformed lines but still pops the next valid one', async () => {
      const filePath = join(stateDir, `${SID}.injection-queue.jsonl`);
      await enqueueInjection({ stateDir, sessionId: SID, content: 'valid' });
      // Inject a corrupt line manually before the valid one
      const { writeFile } = await import('node:fs/promises');
      const valid = JSON.stringify({ content: 'valid' });
      await writeFile(filePath, `corrupt-line\n${valid}\n`, 'utf-8');
      const popped = await popInjection({ stateDir, sessionId: SID });
      expect(popped).toBe('valid');
    });

    it('preserves Unicode in popped content', async () => {
      const tricky = '回我 hi ✨';
      await enqueueInjection({ stateDir, sessionId: SID, content: tricky });
      expect(await popInjection({ stateDir, sessionId: SID })).toBe(tricky);
    });
  });

  describe('resolveInjectionQueuePath', () => {
    it('returns <stateDir>/<sessionId>.injection-queue.jsonl', () => {
      expect(
        resolveInjectionQueuePath({ stateDir: '/x', sessionId: SID }),
      ).toBe(`/x/${SID}.injection-queue.jsonl`);
    });
  });
});
