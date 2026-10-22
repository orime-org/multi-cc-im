import type { PaneId, TermPaneInfo } from '@multi-cc-im/shared';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-';
// Codex 0.163.0 renders this item with 29 characters followed by three dots.
const TITLE_ID = new RegExp(`(?<![a-zA-Z0-9_.-])${UUID}(?:[0-9a-f]{12}|[0-9a-f]{5}\\.\\.\\.)(?![a-zA-Z0-9_.-])`, 'g');

/**
 * Match official title ids against a fresh list of loaded native threads.
 * Both directions must be unique; friendly names and cwd are never identities.
 * @param panes Structured terminal snapshots with unmodified terminal titles.
 * @param loadedIds Native `thread/loaded/list` ids from the selected Codex home.
 * @returns Thread-to-pane associations; missing or ambiguous entries are omitted.
 * @example matchCodexThreads(panes, loadedIds).get(threadId);
 */
export function matchCodexThreads(panes: readonly TermPaneInfo[], loadedIds: readonly string[]): Map<string, PaneId> {
  const candidates = new Map<string, PaneId[]>();
  for (const pane of panes) {
    const tokens = [...(pane.terminalTitle ?? '').matchAll(TITLE_ID)];
    if (tokens.length !== 1) continue;
    const token = tokens[0]![0];
    const matches = [...new Set(loadedIds)].filter(id => token.endsWith('...') ? id.startsWith(token.slice(0, -3)) : id === token);
    if (matches.length !== 1) continue;
    const id = matches[0]!;
    candidates.set(id, [...(candidates.get(id) ?? []), pane.paneId]);
  }
  return new Map([...candidates].flatMap(([id, ids]) => ids.length === 1 ? [[id, ids[0]!]] : []));
}
