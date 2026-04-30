import type { PendingMsg, PendingQueue } from '@multi-cc-im/shared';
import { open, readFile, mkdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic-write.js';
import { isENOENT } from './utils.js';

export interface PendingQueueOpts {
  /** Absolute path to the append-only JSONL queue file. */
  jsonlPath: string;
  /** Absolute path to the last-acked offset pointer file. */
  offsetPath: string;
}

/**
 * File-backed PendingQueue: append-only JSONL + offset pointer file.
 *
 * - `enqueue` appends one line per record (single-process safe — multi-cc-im
 *   bridge is single-process per Storage DD)
 * - `drainSince(offset)` reads from byte offset, yields {msg, offset} where
 *   `offset` is the byte position of the next record (consumer can ack with
 *   that value to mark "I've consumed up to here")
 * - `ack(offset)` atomically writes the offset pointer
 * - `compact()` rewrites the JSONL file dropping records before the current
 *   ack offset; resets offset pointer to 0
 *
 * Race-condition note: in v1 (single-bridge process), there is no concurrent
 * enqueue. If multi-process is ever needed, switch to file-locking.
 */
export function createPendingQueue(opts: PendingQueueOpts): PendingQueue {
  const { jsonlPath, offsetPath } = opts;

  return {
    async enqueue(msg) {
      const record: PendingMsg = {
        id: randomBytes(8).toString('hex'),
        enqueuedAt: Date.now(),
        payload: msg.payload,
      };
      await mkdir(dirname(jsonlPath), { recursive: true });
      const fh = await open(jsonlPath, 'a', 0o600);
      try {
        await fh.writeFile(JSON.stringify(record) + '\n');
        await fh.sync();
      } finally {
        await fh.close();
      }
      return record;
    },

    drainSince(offset) {
      return drainFromOffset(jsonlPath, offset);
    },

    async ack(offset) {
      await atomicWrite(offsetPath, String(offset));
    },

    async compact() {
      let offset = 0;
      try {
        const text = await readFile(offsetPath, 'utf8');
        const parsed = parseInt(text, 10);
        if (Number.isFinite(parsed) && parsed > 0) offset = parsed;
      } catch (err) {
        if (!isENOENT(err)) throw err;
      }

      if (offset === 0) return;

      let remaining: Buffer;
      try {
        const fh = await open(jsonlPath, 'r');
        try {
          const s = await fh.stat();
          if (offset >= s.size) {
            remaining = Buffer.alloc(0);
          } else {
            remaining = Buffer.alloc(s.size - offset);
            await fh.read(remaining, 0, s.size - offset, offset);
          }
        } finally {
          await fh.close();
        }
      } catch (err) {
        if (isENOENT(err)) return;
        throw err;
      }

      await atomicWrite(jsonlPath, remaining);
      await atomicWrite(offsetPath, '0');
    },
  };
}

async function* drainFromOffset(
  jsonlPath: string,
  offset: number,
): AsyncIterable<{ msg: PendingMsg; offset: number }> {
  let fh: FileHandle | undefined;
  try {
    try {
      fh = await open(jsonlPath, 'r');
    } catch (err) {
      if (isENOENT(err)) return;
      throw err;
    }

    const s = await fh.stat();
    if (offset >= s.size) return;

    const remaining = s.size - offset;
    const buf = Buffer.alloc(remaining);
    await fh.read(buf, 0, remaining, offset);

    let lineStartInBuf = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a /* \n */) continue;
      const line = buf.subarray(lineStartInBuf, i).toString('utf8');
      lineStartInBuf = i + 1;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let msg: PendingMsg;
      try {
        msg = JSON.parse(line) as PendingMsg;
      } catch {
        continue;
      }
      const nextOffset = offset + i + 1;
      yield { msg, offset: nextOffset };
    }
  } finally {
    if (fh) await fh.close();
  }
}
