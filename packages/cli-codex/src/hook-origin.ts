import type { TermPaneInfo, TerminalId } from '@multi-cc-im/shared';
import type { PaneOrigin } from '@multi-cc-im/cli-cc';
import { codexHome, connectCodexLocal, listLoadedCodexThreads } from './local-client.js';
import { matchCodexThreads } from './thread-identity.js';

/**
 * Resolve one hook's native thread against fresh official terminal titles.
 * No hook environment pane id, subscription, persisted mapping or TUI input is used.
 * @param threadId Full session_id supplied by the native hook payload.
 * @param opts Selected terminal/home, fresh snapshot and diagnostic sink.
 * @returns Unique native origin; missing/ambiguous/unavailable sources defer to TUI.
 * @example await resolveCodexHookOrigin(threadId, { terminalId, listPanes, onError });
 */
export async function resolveCodexHookOrigin(threadId: string, opts: {
  terminalId: TerminalId; home?: string;
  listPanes(): Promise<readonly TermPaneInfo[]>;
  onError(err: unknown): void;
  timeoutMs?: number;
}): Promise<PaneOrigin | undefined> {
  const timeoutMs = opts.timeoutMs ?? 800;
  const client = connectCodexLocal({ home: opts.home ?? codexHome(), timeoutMs, onError: opts.onError });
  let timer: NodeJS.Timeout | undefined;
  try {
    const lookup = (async (): Promise<PaneOrigin> => {
      const [panes, loaded] = await Promise.all([opts.listPanes(), (async () => {
        await client.ready;
        return listLoadedCodexThreads(client);
      })()]);
      const paneId = matchCodexThreads(panes, loaded).get(threadId);
      if (paneId === undefined) throw new Error('Codex thread identity is missing or ambiguous; IM forwarding paused. Enable thread-id in /terminal-title, verify the selected Codex home, and keep one pane per thread. Native terminal handling remains available.');
      return { termId: opts.terminalId, paneId };
    })();
    return await Promise.race([lookup, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Codex thread identity lookup timed out; use the terminal and check the terminal API/local App Server.')), timeoutMs);
    })]);
  } catch (err) { opts.onError(err); return undefined; }
  finally { clearTimeout(timer); client.close(); }
}
