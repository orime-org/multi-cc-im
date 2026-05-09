import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite } from '@multi-cc-im/storage-files';

/**
 * FIFO injection queue per session, file-backed.
 *
 * Bridge router calls `enqueueInjection({ stateDir, sessionId, content })`
 * to schedule a prompt for the next non-active Stop hook. The hook receiver
 * (`runHookReceiver` Stop branch) pops the oldest line and returns it as
 * `{ decision: 'block', reason }` so cc re-processes it as a fresh user
 * prompt.
 *
 * File: `<stateDir>/<sessionId>.injection-queue.jsonl` — one
 * `{ content: string }` JSON line per pending injection.
 *
 * Atomicity:
 * - `enqueueInjection` uses `appendFile` (single-line writes are atomic at
 *   the filesystem level for sub-PIPE_BUF sizes; injection contents are
 *   typically short strings).
 * - `popInjection` does **read → take first → atomic-rewrite tail** via
 *   `atomicWrite` (mode 0600 + same-dir tmp + fsync + rename). There is a
 *   short race window if a producer (`enqueueInjection`) writes between the
 *   read and the rewrite — that producer's line will be **lost** in the
 *   rewrite. For multi-cc-im (single-user, low Hz) this is acceptable; if
 *   the producer rate ever rises, swap in `proper-lockfile` (already a
 *   workspace dep via storage-files).
 *
 * Malformed lines are silently skipped on pop (don't block the queue);
 * caller logs separately if it cares.
 */

export interface InjectionQueuePath {
  stateDir: string;
  sessionId: string;
}

export function resolveInjectionQueuePath(
  opts: InjectionQueuePath,
): string {
  return join(opts.stateDir, `${opts.sessionId}.injection-queue.jsonl`);
}

export interface EnqueueInjectionOpts extends InjectionQueuePath {
  content: string;
}

export async function enqueueInjection(
  opts: EnqueueInjectionOpts,
): Promise<void> {
  const filePath = resolveInjectionQueuePath(opts);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(
    filePath,
    `${JSON.stringify({ content: opts.content })}\n`,
    'utf-8',
  );
}

interface QueueLine {
  content: string;
}

function isQueueLine(value: unknown): value is QueueLine {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    typeof (value as { content: unknown }).content === 'string'
  );
}

/**
 * Atomic-pop the oldest valid line. Returns the popped `content`, or `null`
 * if the queue file is missing / empty / contains only malformed lines.
 */
export async function popInjection(
  opts: InjectionQueuePath,
): Promise<string | null> {
  const filePath = resolveInjectionQueuePath(opts);

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  let poppedIndex = -1;
  let popped: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed: unknown = JSON.parse(lines[i]!);
      if (isQueueLine(parsed)) {
        poppedIndex = i;
        popped = parsed.content;
        break;
      }
    } catch {
      // skip malformed
    }
  }

  if (popped === null) {
    // No valid lines — overwrite to clean malformed cruft
    await atomicWrite(filePath, '');
    return null;
  }

  const remaining = lines.filter((_, i) => i !== poppedIndex);
  const newContent =
    remaining.length === 0 ? '' : `${remaining.join('\n')}\n`;
  await atomicWrite(filePath, newContent);

  return popped;
}
