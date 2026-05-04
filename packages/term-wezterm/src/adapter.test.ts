import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PaneId } from '@multi-cc-im/shared';

const mockRunWezTermCli = vi.hoisted(() => vi.fn());
vi.mock('./cli.js', () => ({ runWezTermCli: mockRunWezTermCli }));

const { createWezTermAdapter } = await import('./adapter.js');

const PANE = 20 as PaneId;

beforeEach(() => {
  mockRunWezTermCli.mockReset().mockResolvedValue('');
});

function makeAdapter() {
  return createWezTermAdapter({
    wezterm: { path: '/opt/homebrew/bin/wezterm' },
  });
}

describe('createWezTermAdapter — core', () => {
  it('exposes name = "wezterm"', () => {
    expect(makeAdapter().name).toBe('wezterm');
  });

  it('start() is a no-op for v1 (no terminal-side lifecycle subscription yet)', async () => {
    const adapter = makeAdapter();
    await expect(adapter.start({})).resolves.toBeUndefined();
    await adapter.stop();
  });

  it('stop() is idempotent', async () => {
    const adapter = makeAdapter();
    await adapter.start({});
    await adapter.stop();
    await expect(adapter.stop()).resolves.toBeUndefined();
  });
});

describe('createWezTermAdapter — sendText (Step 1: paste content)', () => {
  it('runs `wezterm cli send-text --pane-id <p>` with content piped via stdin (default paste mode)', async () => {
    const adapter = makeAdapter();
    await adapter.sendText(PANE, '你好 $world ✨\n多行\n');
    expect(mockRunWezTermCli).toHaveBeenCalledTimes(1);
    expect(mockRunWezTermCli).toHaveBeenCalledWith(
      expect.objectContaining({
        wezterm: '/opt/homebrew/bin/wezterm',
        args: ['cli', 'send-text', '--pane-id', '20'],
        stdin: '你好 $world ✨\n多行\n',
      }),
    );
  });

  it('does NOT include --no-paste in Step 1 (per DD: paste mode protects content)', async () => {
    const adapter = makeAdapter();
    await adapter.sendText(PANE, 'safe-content');
    const call = mockRunWezTermCli.mock.calls[0]?.[0] as {
      args: readonly string[];
    };
    expect(call.args).not.toContain('--no-paste');
  });

  it('preserves shell metachars / Unicode / emoji exactly (no escaping)', async () => {
    const adapter = makeAdapter();
    const tricky = "echo \"hello $world `pwd`\" probe-4";
    await adapter.sendText(PANE, tricky);
    expect(mockRunWezTermCli).toHaveBeenCalledWith(
      expect.objectContaining({ stdin: tricky }),
    );
  });
});

describe('createWezTermAdapter — sendKeystroke (Step 2: --no-paste keystroke)', () => {
  it('runs `wezterm cli send-text --pane-id <p> --no-paste` with keystroke via stdin', async () => {
    const adapter = makeAdapter();
    await adapter.sendKeystroke(PANE, '\r');
    expect(mockRunWezTermCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['cli', 'send-text', '--pane-id', '20', '--no-paste'],
        stdin: '\r',
      }),
    );
  });

  it('rejects empty keystroke (would silently send nothing → footgun)', async () => {
    const adapter = makeAdapter();
    await expect(adapter.sendKeystroke(PANE, '')).rejects.toThrow(
      /keystroke must not be empty/i,
    );
    expect(mockRunWezTermCli).not.toHaveBeenCalled();
  });
});

describe('createWezTermAdapter — sendText / sendKeystroke order matches DD lock', () => {
  it('two-step submission: sendText then sendKeystroke produces expected argv pair', async () => {
    const adapter = makeAdapter();
    await adapter.sendText(PANE, 'hello');
    await adapter.sendKeystroke(PANE, '\r');
    const argvPair = mockRunWezTermCli.mock.calls.map((c) => (c[0] as { args: readonly string[] }).args);
    expect(argvPair).toEqual([
      ['cli', 'send-text', '--pane-id', '20'],
      ['cli', 'send-text', '--pane-id', '20', '--no-paste'],
    ]);
  });
});

describe('createWezTermAdapter — error propagation', () => {
  it('sendText surfaces wezterm cli errors verbatim (e.g. dead pane)', async () => {
    mockRunWezTermCli.mockRejectedValueOnce(
      new Error('wezterm cli failed: exit 1 — pane-id 99: not found'),
    );
    const adapter = makeAdapter();
    await expect(adapter.sendText(99 as PaneId, 'x')).rejects.toThrow(
      /pane-id 99: not found/,
    );
  });

  it('sendKeystroke surfaces wezterm cli errors verbatim', async () => {
    mockRunWezTermCli.mockRejectedValueOnce(
      new Error('wezterm cli failed: exit 1 — broken socket'),
    );
    const adapter = makeAdapter();
    await expect(adapter.sendKeystroke(PANE, '\r')).rejects.toThrow(
      /broken socket/,
    );
  });
});
