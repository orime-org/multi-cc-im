import { describe, expect, it } from 'vitest';
import type { PaneId, TermPaneInfo } from '@multi-cc-im/shared';
import { matchCodexThreads } from './thread-identity.js';

const a = '019a15e0-329d-7343-9e8c-2d694c948237';
const b = '019a15e0-329d-7343-9e8c-2d694c94ffff';
const c = '019a15e1-329d-7343-9e8c-2d694c948237';
const title = (id: string): string => `project · ${id.slice(0, 29)}... ⠋`;
const pane = (id: number, raw?: string): TermPaneInfo => ({ paneId: id as PaneId, title: 'friendly', cwd: '/same', terminalTitle: raw });

describe('official Codex title identity', () => {
  it('matches distinct native titles in the same project without trusting friendly names', () => {
    expect([...matchCodexThreads([pane(1, title(a)), pane(2, title(c))], [a, c])]).toEqual([[a, 1], [c, 2]]);
  });
  it('rejects missing, shortened, unknown and multiple title ids', () => {
    for (const raw of [undefined, a.slice(0, 8), title(c), `${title(a)} ${title(c)}`, `x${a.slice(0, 29)}...`, `${a.slice(0, 29)}....`]) {
      expect(matchCodexThreads([pane(1, raw)], [a]).size).toBe(0);
    }
    expect(matchCodexThreads([{ ...pane(1), title: title(a) }], [a]).size).toBe(0);
  });
  it('rejects native-prefix collisions and a thread shown in two panes', () => {
    expect(matchCodexThreads([pane(1, title(a))], [a, b]).size).toBe(0);
    expect(matchCodexThreads([pane(1, title(a)), pane(2, title(a))], [a]).size).toBe(0);
  });
  it('accepts an exact full UUID but never a nonloaded thread', () => {
    expect([...matchCodexThreads([pane(1, a)], [a, b])]).toEqual([[a, 1]]);
    expect(matchCodexThreads([pane(1, a)], []).size).toBe(0);
  });
});
