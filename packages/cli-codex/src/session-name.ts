import { z } from 'zod';
import { codexHome } from './local-client.js';
import { readCodexThreadMetadata } from './stdio-metadata.js';

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
 * Read the exact native root session name for a Stop reply over owned stdio.
 * @param threadId Full UUID supplied by the native Stop payload.
 * @param opts Native home, deadline capped at 800 ms, diagnostics, and an optional
 * executable override for isolated process fixtures.
 * @returns Native name, or undefined for subagents and diagnosed lookup failures.
 * @throws Diagnostic callbacks may propagate their own exceptions.
 * @example const name = await resolveCodexSessionName(threadId, { onError });
 */
export async function resolveCodexSessionName(threadId: string, opts: {
  home?: string; timeoutMs?: number; executable?: string; onError(err: unknown): void;
}): Promise<string | undefined> {
  try {
    if (!z.string().uuid().safeParse(threadId).success) throw new Error('Invalid Codex thread id; expected the native Stop session UUID.');
    const timeoutMs = Math.min(z.number().finite().positive().parse(opts.timeoutMs ?? 800), 800);
    const { thread } = ThreadMetadata.parse(await readCodexThreadMetadata({
      home: opts.home ?? codexHome(), threadId, timeoutMs, executable: opts.executable, onError: opts.onError,
    }));
    if (thread.id !== threadId) throw new Error('Codex App Server returned a different thread id.');
    if (typeof thread.source === 'object' && 'subAgent' in thread.source) return undefined;
    if (!thread.name?.trim()) throw new Error('Codex session has no name; run /rename <session-name> in the terminal and retry.');
    return thread.name;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.onError(new Error(`Codex App Server session name lookup failed: ${detail} Check the selected Codex home and run codex --version and codex app-server --help in the terminal (verified: 0.163.0).`, { cause: err }));
    return undefined;
  }
}
