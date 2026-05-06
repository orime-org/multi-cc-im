import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HookPayloadSchema, type ParsedHookPayload } from './payloads.js';

/**
 * Per-session append-only event log: every cc hook fire writes one JSON line
 * to `<stateDir>/<sessionId>.events.jsonl`. The CLIAdapter file-watcher tails
 * these files (`tailNewEvents` with offset bookkeeping) and dispatches to its
 * Handler.
 *
 * Choice of append + tail (vs. IPC server / unix socket): aligns with Storage
 * DD pattern A file-first approach + CLAUDE.md "local-first" + avoids the
 * bridge lifecycle issue that plagues IPC (cc hooks fire even when bridge is
 * down; file-based is naturally compatible with bridge restarts).
 *
 * Format: one JSON-encoded `ParsedHookPayload` per line, terminated by `\n`.
 * Caller (hook receiver) ensures payload has been zod-validated upstream.
 */

export interface EventsLogPath {
  stateDir: string;
  sessionId: string;
}

export function resolveEventsLogPath(opts: EventsLogPath): string {
  return join(opts.stateDir, `${opts.sessionId}.events.jsonl`);
}

export interface AppendEventOpts extends EventsLogPath {
  payload: ParsedHookPayload;
}

export async function appendEvent(opts: AppendEventOpts): Promise<void> {
  const filePath = resolveEventsLogPath(opts);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(opts.payload)}\n`, 'utf-8');
}

export interface TailNewEventsOpts {
  filePath: string;
  /** Byte offset where to start reading; pass result of last call's `newOffset`. */
  fromOffset: number;
  /**
   * Optional callback for malformed lines. The watcher uses this to log
   * corruption without failing the whole tail. Default: silently skip.
   */
  onParseError?: (line: string, error: unknown) => void;
}

export interface TailNewEventsResult {
  events: ParsedHookPayload[];
  /** Bookmark — pass to next call's `fromOffset` to skip what was just read. */
  newOffset: number;
}

/**
 * Tail an events.jsonl file from `fromOffset` to current EOF, parse each
 * complete line, return events + new offset. Malformed lines are skipped (and
 * reported via `onParseError`). File missing → empty result.
 *
 * Caveat: a partial line (last line not yet terminated by `\n`) is treated as
 * incomplete and **excluded** from this batch — it'll be picked up on the
 * next tail when the writer flushes the newline. This matches the
 * `appendFile` write semantics in `appendEvent` (line + \n in single call).
 */
export async function tailNewEvents(
  opts: TailNewEventsOpts,
): Promise<TailNewEventsResult> {
  let fileSize: number;
  try {
    const s = await stat(opts.filePath);
    fileSize = s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], newOffset: opts.fromOffset };
    }
    throw err;
  }

  if (fileSize <= opts.fromOffset) {
    return { events: [], newOffset: opts.fromOffset };
  }

  // Read entire file then slice — simpler than incremental fd reads, and
  // events.jsonl size is bounded by hook fire rate (low Hz) × session lifespan.
  const raw = await readFile(opts.filePath, 'utf-8');
  const tail = raw.slice(opts.fromOffset);

  // Split off complete lines (terminated by \n). Trailing partial line is
  // dropped from this batch — caller's offset advances only past complete \n.
  const lastNewline = tail.lastIndexOf('\n');
  if (lastNewline < 0) {
    return { events: [], newOffset: opts.fromOffset };
  }

  const completeBlock = tail.slice(0, lastNewline);
  const newOffset = opts.fromOffset + lastNewline + 1; // +1 to consume the \n

  const events: ParsedHookPayload[] = [];
  for (const line of completeBlock.split('\n')) {
    if (!line) continue;
    try {
      const json: unknown = JSON.parse(line);
      events.push(HookPayloadSchema.parse(json));
    } catch (error) {
      opts.onParseError?.(line, error);
    }
  }

  return { events, newOffset };
}
