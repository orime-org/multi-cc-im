import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunWezTermCli = vi.hoisted(() => vi.fn());
vi.mock('./cli.js', () => ({ runWezTermCli: mockRunWezTermCli }));

const { listAllTabs, getTabTitleByPaneId } = await import('./tab-title.js');

const WEZTERM = '/opt/homebrew/bin/wezterm';

/**
 * Realistic fixture matching the shape of `wezterm cli list --format json`
 * actually observed in the user's environment (real cwd URLs, mix of cc
 * panes with `✳`/`⠐` status prefixes, plain-shell panes with no title).
 */
const REAL_FIXTURE = [
  {
    window_id: 2,
    tab_id: 15,
    pane_id: 15,
    workspace: 'default',
    title: '✳ frontend',
    cwd: 'file:///private/tmp/cc-smoke',
  },
  {
    window_id: 2,
    tab_id: 16,
    pane_id: 16,
    workspace: 'default',
    title: '⠐ breatic_frontend',
    cwd: 'file:///Users/me/work/breatic',
  },
  {
    window_id: 2,
    tab_id: 17,
    pane_id: 17,
    workspace: 'default',
    title: '',
    cwd: 'file:///Users/me',
  },
  {
    window_id: 2,
    tab_id: 18,
    pane_id: 18,
    workspace: 'default',
    title: 'node',
    cwd: 'file:///Users/me/work/node-stuff',
  },
];

beforeEach(() => {
  mockRunWezTermCli.mockReset();
});

describe('listAllTabs', () => {
  it('parses real-shape JSON output and returns a Map keyed by pane_id', async () => {
    mockRunWezTermCli.mockResolvedValue(JSON.stringify(REAL_FIXTURE));

    const tabs = await listAllTabs({ wezterm: WEZTERM });

    expect(mockRunWezTermCli).toHaveBeenCalledWith({
      wezterm: WEZTERM,
      args: ['cli', 'list', '--format', 'json'],
    });
    expect(tabs.size).toBe(4);
    expect([...tabs.keys()].sort((a, b) => a - b)).toEqual([15, 16, 17, 18]);
    expect(tabs.get(15)).toEqual({
      paneId: 15,
      title: 'frontend',
      cwd: 'file:///private/tmp/cc-smoke',
    });
  });

  it('strips `✳ ` (cc running status) from the title', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([
        { pane_id: 15, title: '✳ frontend', cwd: 'file:///x' },
      ]),
    );
    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect(tabs.get(15)?.title).toBe('frontend');
  });

  it('strips `⠐ ` (cc busy spinner) from the title', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([
        { pane_id: 16, title: '⠐ breatic_frontend', cwd: 'file:///y' },
      ]),
    );
    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect(tabs.get(16)?.title).toBe('breatic_frontend');
  });

  it('keeps an empty title empty (user has not run /rename)', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([{ pane_id: 17, title: '', cwd: 'file:///z' }]),
    );
    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect(tabs.get(17)?.title).toBe('');
  });

  it('keeps a non-prefixed title unchanged', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([{ pane_id: 18, title: 'node', cwd: 'file:///n' }]),
    );
    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect(tabs.get(18)?.title).toBe('node');
  });

  it('skips entries with missing or non-numeric pane_id', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([
        { pane_id: 15, title: 'keep me', cwd: 'file:///a' },
        { pane_id: 'not-a-number', title: 'nope', cwd: 'file:///b' },
        { title: 'no pane id at all', cwd: 'file:///c' },
        { pane_id: null, title: 'null pane id', cwd: 'file:///d' },
        { pane_id: 42, title: 'also keep', cwd: 'file:///e' },
      ]),
    );

    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect([...tabs.keys()].sort((a, b) => a - b)).toEqual([15, 42]);
  });

  it('defaults missing / null title to empty string', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([
        { pane_id: 1, cwd: 'file:///a' },
        { pane_id: 2, title: null, cwd: 'file:///b' },
      ]),
    );
    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect(tabs.get(1)?.title).toBe('');
    expect(tabs.get(2)?.title).toBe('');
  });

  it('rejects when stdout is not valid JSON', async () => {
    mockRunWezTermCli.mockResolvedValue('not json at all {{{');
    await expect(listAllTabs({ wezterm: WEZTERM })).rejects.toThrow(
      /failed to parse JSON/,
    );
  });

  it('rejects when stdout parses as null (not an array)', async () => {
    mockRunWezTermCli.mockResolvedValue('null');
    await expect(listAllTabs({ wezterm: WEZTERM })).rejects.toThrow(
      /expected JSON array.*null/,
    );
  });

  it('rejects when stdout parses as an object (not an array)', async () => {
    mockRunWezTermCli.mockResolvedValue('{}');
    await expect(listAllTabs({ wezterm: WEZTERM })).rejects.toThrow(
      /expected JSON array.*object/,
    );
  });

  it('propagates errors thrown by runWezTermCli', async () => {
    mockRunWezTermCli.mockRejectedValue(
      new Error('wezterm cli failed: code=1 — not running'),
    );
    await expect(listAllTabs({ wezterm: WEZTERM })).rejects.toThrow(
      /not running/,
    );
  });

  it('cc default title "Claude Code" → empty string (treated as un-renamed)', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([
        { pane_id: 30, title: 'Claude Code', cwd: 'file:///x' },
      ]),
    );
    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect(tabs.get(30)?.title).toBe('');
  });

  it('cc default title with model annotation "Claude Code [1m]" → empty string', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([
        { pane_id: 31, title: 'Claude Code [1m]', cwd: 'file:///x' },
      ]),
    );
    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect(tabs.get(31)?.title).toBe('');
  });

  it('default title with status prefix "✳ Claude Code" → empty string', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([
        { pane_id: 32, title: '✳ Claude Code', cwd: 'file:///x' },
      ]),
    );
    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect(tabs.get(32)?.title).toBe('');
  });

  it('user /rename to "Claude Code stuff" still preserved (only exact default matches)', async () => {
    mockRunWezTermCli.mockResolvedValue(
      JSON.stringify([
        { pane_id: 33, title: 'Claude Code stuff', cwd: 'file:///x' },
      ]),
    );
    const tabs = await listAllTabs({ wezterm: WEZTERM });
    expect(tabs.get(33)?.title).toBe('Claude Code stuff');
  });
});

describe('getTabTitleByPaneId', () => {
  it('returns the cleaned title for a known pane', async () => {
    mockRunWezTermCli.mockResolvedValue(JSON.stringify(REAL_FIXTURE));
    const title = await getTabTitleByPaneId(15, { wezterm: WEZTERM });
    expect(title).toBe('frontend');
  });

  it('returns undefined for a pane not in the listing', async () => {
    mockRunWezTermCli.mockResolvedValue(JSON.stringify(REAL_FIXTURE));
    const title = await getTabTitleByPaneId(99, { wezterm: WEZTERM });
    expect(title).toBeUndefined();
  });
});
