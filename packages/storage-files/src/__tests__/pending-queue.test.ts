import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPendingQueue } from '../pending-queue.js';

describe('PendingQueue', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let offsetPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcim-pq-'));
    jsonlPath = join(tmpDir, 'pending.jsonl');
    offsetPath = join(tmpDir, 'pending-offset.txt');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('enqueue', () => {
    it('returns msg with assigned id and enqueuedAt', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      const before = Date.now();
      const result = await q.enqueue({ payload: { hello: 'world' } });
      const after = Date.now();
      expect(result.id).toMatch(/^[a-f0-9]+$/);
      expect(result.enqueuedAt).toBeGreaterThanOrEqual(before);
      expect(result.enqueuedAt).toBeLessThanOrEqual(after);
      expect(result.payload).toEqual({ hello: 'world' });
    });

    it('appends to JSONL file (one record per line)', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.enqueue({ payload: { i: 1 } });
      await q.enqueue({ payload: { i: 2 } });
      const content = await readFile(jsonlPath, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      const r1 = JSON.parse(lines[0]!) as { payload: unknown };
      const r2 = JSON.parse(lines[1]!) as { payload: unknown };
      expect(r1.payload).toEqual({ i: 1 });
      expect(r2.payload).toEqual({ i: 2 });
    });

    it('creates parent directories when missing', async () => {
      const deep = join(tmpDir, 'state', 'deep', 'pending.jsonl');
      const q = createPendingQueue({
        jsonlPath: deep,
        offsetPath: join(tmpDir, 'state', 'deep', 'offset.txt'),
      });
      await q.enqueue({ payload: { ok: true } });
      const content = await readFile(deep, 'utf8');
      expect(content).toContain('"ok":true');
    });
  });

  describe('drainSince', () => {
    it('yields nothing for empty queue (file missing)', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      const collected: unknown[] = [];
      for await (const item of q.drainSince(0)) collected.push(item);
      expect(collected).toEqual([]);
    });

    it('yields all messages from offset 0', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.enqueue({ payload: { i: 1 } });
      await q.enqueue({ payload: { i: 2 } });
      await q.enqueue({ payload: { i: 3 } });

      const collected: { payload: unknown }[] = [];
      for await (const item of q.drainSince(0)) collected.push(item.msg);
      expect(collected).toHaveLength(3);
      expect(collected[0]?.payload).toEqual({ i: 1 });
      expect(collected[2]?.payload).toEqual({ i: 3 });
    });

    it('yields offsets that allow resuming', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.enqueue({ payload: { i: 1 } });
      await q.enqueue({ payload: { i: 2 } });

      let firstYielded: { offset: number; payload: unknown } | undefined;
      for await (const item of q.drainSince(0)) {
        firstYielded = { offset: item.offset, payload: item.msg.payload };
        break;
      }
      expect(firstYielded?.payload).toEqual({ i: 1 });

      const remaining: unknown[] = [];
      for await (const item of q.drainSince(firstYielded!.offset)) {
        remaining.push(item.msg.payload);
      }
      expect(remaining).toEqual([{ i: 2 }]);
    });

    it('yields nothing when offset >= file size', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.enqueue({ payload: { i: 1 } });
      const collected: unknown[] = [];
      for await (const item of q.drainSince(99999)) collected.push(item);
      expect(collected).toEqual([]);
    });

    it('skips invalid (non-JSON) lines gracefully', async () => {
      await writeFile(
        jsonlPath,
        'not-json\n{"id":"a","enqueuedAt":1,"payload":{"i":1}}\n',
      );
      const q = createPendingQueue({ jsonlPath, offsetPath });
      const collected: unknown[] = [];
      for await (const item of q.drainSince(0)) {
        collected.push(item.msg.payload);
      }
      expect(collected).toEqual([{ i: 1 }]);
    });

    it('skips blank lines', async () => {
      await writeFile(
        jsonlPath,
        '\n{"id":"a","enqueuedAt":1,"payload":1}\n\n',
      );
      const q = createPendingQueue({ jsonlPath, offsetPath });
      const collected: unknown[] = [];
      for await (const item of q.drainSince(0)) {
        collected.push(item.msg.payload);
      }
      expect(collected).toEqual([1]);
    });
  });

  describe('ack', () => {
    it('writes offset to offsetPath atomically', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.ack(42);
      expect(await readFile(offsetPath, 'utf8')).toBe('42');
    });

    it('overwrites previous ack', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.ack(10);
      await q.ack(20);
      expect(await readFile(offsetPath, 'utf8')).toBe('20');
    });
  });

  describe('compact', () => {
    it('removes acked records and resets offset to 0', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.enqueue({ payload: { i: 1 } });
      await q.enqueue({ payload: { i: 2 } });
      await q.enqueue({ payload: { i: 3 } });

      let firstOffset = 0;
      for await (const item of q.drainSince(0)) {
        firstOffset = item.offset;
        break;
      }
      await q.ack(firstOffset);
      await q.compact();

      expect(await readFile(offsetPath, 'utf8')).toBe('0');

      const remaining: unknown[] = [];
      for await (const item of q.drainSince(0)) {
        remaining.push(item.msg.payload);
      }
      expect(remaining).toEqual([{ i: 2 }, { i: 3 }]);
    });

    it('is no-op when nothing acked', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.enqueue({ payload: { i: 1 } });
      await q.compact();
      const collected: unknown[] = [];
      for await (const item of q.drainSince(0)) {
        collected.push(item.msg.payload);
      }
      expect(collected).toEqual([{ i: 1 }]);
    });

    it('is no-op when JSONL file missing', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.ack(100);
      await q.compact();
      // shouldn't throw; offsetPath still has '100' (not reset since jsonl absent)
    });

    it('handles offset >= file size by emptying jsonl', async () => {
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.enqueue({ payload: { i: 1 } });
      await q.ack(99999);
      await q.compact();
      const collected: unknown[] = [];
      for await (const item of q.drainSince(0)) collected.push(item);
      expect(collected).toEqual([]);
    });

    it('treats invalid offset file content as 0 (no-op)', async () => {
      await writeFile(offsetPath, 'not-a-number');
      const q = createPendingQueue({ jsonlPath, offsetPath });
      await q.enqueue({ payload: { i: 1 } });
      await q.compact();
      const collected: unknown[] = [];
      for await (const item of q.drainSince(0)) {
        collected.push(item.msg.payload);
      }
      expect(collected).toEqual([{ i: 1 }]);
    });
  });

  describe('persistence across instances', () => {
    it('drain from new instance reads same JSONL', async () => {
      const q1 = createPendingQueue({ jsonlPath, offsetPath });
      await q1.enqueue({ payload: { from: 'q1' } });

      const q2 = createPendingQueue({ jsonlPath, offsetPath });
      const collected: unknown[] = [];
      for await (const item of q2.drainSince(0)) {
        collected.push(item.msg.payload);
      }
      expect(collected).toEqual([{ from: 'q1' }]);
    });
  });
});
