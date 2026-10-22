import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigStore } from '@multi-cc-im/storage-files';
import { resolveAppPaths } from './config-paths.js';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), receive: vi.fn(), list: vi.fn(), wezterm: vi.fn(), iterm: vi.fn() }));
vi.mock('@multi-cc-im/cli-codex', async original => ({ ...await original<object>(),
  resolveCodexHookOrigin: mocks.resolve, runHookReceiver: mocks.receive }));
vi.mock('@multi-cc-im/term-wezterm', () => ({ resolveWezTermPath: async () => '/fixture/wezterm',
  createWezTermAdapter: mocks.wezterm }));
vi.mock('@multi-cc-im/term-iterm2', () => ({ resolvePython3Path: async () => '/fixture/python3',
  createITerm2Adapter: mocks.iterm }));
vi.mock('./start.js', () => ({ resolveIterm2HelperPath: async () => '/fixture/helper.py' }));
const { runCodexHookCommand } = await import('./codex-hook.js');

const payload = { hook_event_name: 'Stop', session_id: 'native-thread', cwd: '/fixture', transcript_path: null,
  model: 'fixture', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'answer', turn_id: 'turn' };
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; vi.resetAllMocks(); });

describe('production Codex hook entry', () => {
  it.each(['wezterm', 'iterm2'] as const)('uses the configured %s terminal and native thread id', async terminal => {
    root = await mkdtemp(join(tmpdir(), 'codex-entry-'));
    const paths = resolveAppPaths({ env: { MULTI_CC_IM_HOME: root } });
    const store = createConfigStore({ filePath: paths.configToml });
    const config = await store.load();
    await store.save({ ...config, cli: { ...config.cli, enabled: ['codex'], aiRouter: 'codex' }, terminal: { type: terminal } });
    mocks.wezterm.mockReturnValue({ listPanes: mocks.list }); mocks.iterm.mockReturnValue({ listPanes: mocks.list });
    mocks.list.mockResolvedValue([]);
    mocks.resolve.mockResolvedValue({ termId: terminal, paneId: 'verified-pane' });
    mocks.receive.mockImplementation(async (opts: { resolvePaneOrigin(threadId: string): Promise<unknown> }) => { await opts.resolvePaneOrigin(payload.session_id); });
    await runCodexHookCommand(JSON.stringify(payload), { paths, onError: vi.fn() });
    const selected = terminal === 'wezterm' ? mocks.wezterm : mocks.iterm;
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ listTimeoutMs: 600 }));
    expect(mocks.resolve).toHaveBeenCalledWith('native-thread', expect.objectContaining({ terminalId: terminal }));
    const dependencies = mocks.resolve.mock.calls[0]![1] as { listPanes(): Promise<unknown> };
    await dependencies.listPanes(); expect(mocks.list).toHaveBeenCalledOnce();
  });
  it('leaves hooks in native control when Codex bridging is disabled', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-disabled-'));
    const paths = resolveAppPaths({ env: { MULTI_CC_IM_HOME: root } });
    await runCodexHookCommand(JSON.stringify(payload), { paths, onError: vi.fn() });
    expect(mocks.receive).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('does not register a server pane on native SessionStart', async () => {
    await runCodexHookCommand(JSON.stringify({ ...payload, hook_event_name: 'SessionStart', source: 'startup' }), { onError: vi.fn() });
    expect(mocks.receive).not.toHaveBeenCalled(); expect(mocks.wezterm).not.toHaveBeenCalled();
  });
});
