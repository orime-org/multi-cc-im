import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '@multi-cc-im/storage-files';
import { TerminalIdSchema, type CLISessionReply } from '@multi-cc-im/shared';

const NativeId = z.string().uuid();
const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
const Reply: z.ZodType<CLISessionReply> = z.object({
  cli: z.literal('codex'), sessionId: NativeId,
  sessionName: z.string().refine(name => name.trim().length > 0, 'Session name must be nonempty'),
  termId: TerminalIdSchema, last_assistant_message: z.string(),
});

/**
 * Recognize the session reply queue family emitted by native Stop hooks.
 * @param path Queue basename or absolute path supplied by the watcher.
 * @returns Validated native id and timestamp, or null for another file family.
 * @example parseSessionReplyFilename('SessionReply.codex.<uuid>.<timestamp>.json');
 */
export function parseSessionReplyFilename(path: string): { sessionId: string; timestamp: string } | null {
  const match = /^SessionReply\.codex\.([0-9a-f-]+)\.(.+)\.json$/.exec(basename(path));
  if (!match || !NativeId.safeParse(match[1]).success || !Timestamp.safeParse(match[2]).success) return null;
  return { sessionId: match[1]!, timestamp: match[2]! };
}

/**
 * Atomically queue a private session reply with validated path components.
 * @param opts State directory, timestamp and native reply metadata.
 * @returns Resolves after the 0600 event has been atomically committed.
 * @throws Invalid event fields, unsafe filename components or filesystem errors.
 * @example await writeSessionReplyFile({ stateDir, timestamp, reply });
 */
export async function writeSessionReplyFile(opts: { stateDir: string; timestamp: string; reply: CLISessionReply }): Promise<void> {
  const reply = Reply.parse(opts.reply);
  const timestamp = Timestamp.parse(opts.timestamp);
  const path = join(opts.stateDir, `SessionReply.codex.${reply.sessionId}.${timestamp}.json`);
  await atomicWrite(path, JSON.stringify(reply));
}

/**
 * Read and validate a queued reply against its native filename identity.
 * @param path Recognized queue file path from the watcher.
 * @returns Valid reply, or null if an earlier dispatch already consumed it.
 * @throws Malformed body, mismatched session identity or filesystem errors.
 * @example const reply = await readSessionReplyFile(path);
 */
export async function readSessionReplyFile(path: string): Promise<CLISessionReply | null> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
  const reply = Reply.parse(JSON.parse(raw));
  if (parseSessionReplyFilename(path)?.sessionId !== reply.sessionId) {
    throw new Error('Session reply filename and body session ids differ');
  }
  return reply;
}
