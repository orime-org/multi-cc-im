import { z } from 'zod';
import { codexHome, connectCodexLocal, type CodexLocalClient } from './local-client.js';

const SessionSource = z.union([
  z.enum(['cli', 'vscode', 'exec', 'appServer', 'unknown']),
  z.object({ custom: z.string() }).strict(),
  z.object({ subAgent: z.union([
    z.enum(['review', 'compact', 'memory_consolidation']),
    z.object({ other: z.string() }).strict(),
    z.object({ thread_spawn: z.object({ parent_thread_id: z.string(), depth: z.number().int() }).passthrough() }).strict(),
  ]) }).strict(),
]);
const ThreadMetadata = z.object({ thread: z.object({
  id: z.string().uuid(), name: z.string().nullish(), source: SessionSource,
}) });

/**
 * Read the exact native root session name for a Stop reply over the local UDS.
 * @param threadId Full UUID supplied by the native Stop payload.
 * @param opts Selected native home, deadline capped at 800 ms, and diagnostic sink.
 * @returns Native name, or undefined for subagents and diagnosed lookup failures.
 * @throws Diagnostic callbacks may propagate their own exceptions.
 * @example const name = await resolveCodexSessionName(threadId, { onError });
 */
export async function resolveCodexSessionName(threadId: string, opts: {
  home?: string; timeoutMs?: number; onError(err: unknown): void;
}): Promise<string | undefined> {
  let client: CodexLocalClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!z.string().uuid().safeParse(threadId).success) throw new Error('Invalid Codex thread id; expected the native Stop session UUID.');
    const timeoutMs = Math.min(z.number().finite().positive().parse(opts.timeoutMs ?? 800), 800);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Codex session name lookup timed out')), timeoutMs);
    });
    const peer = connectCodexLocal({ home: opts.home ?? codexHome(), timeoutMs, onError: opts.onError });
    client = peer;
    const lookup = (async (): Promise<string | undefined> => {
      await peer.ready;
      const { thread } = ThreadMetadata.parse(await peer.call('thread/read', { threadId, includeTurns: false }));
      if (thread.id !== threadId) throw new Error('Codex App Server returned a different thread id.');
      if (typeof thread.source === 'object' && 'subAgent' in thread.source) return undefined;
      if (!thread.name?.trim()) throw new Error('Codex session has no name; run /rename <session-name> in the terminal and retry.');
      return thread.name;
    })();
    return await Promise.race([lookup, deadline]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.onError(new Error(`Codex session name lookup failed: ${detail} Check the selected Codex home and local App Server (verified: 0.163.0).`, { cause: err }));
    return undefined;
  } finally {
    clearTimeout(timer);
    client?.close();
  }
}
