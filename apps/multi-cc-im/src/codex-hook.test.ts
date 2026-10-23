import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigStore } from '@multi-cc-im/storage-files';
import { resolveAppPaths } from './config-paths.js';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), name: vi.fn(), receive: vi.fn(), list: vi.fn(), wezterm: vi.fn(), iterm: vi.fn(), weztermPath: vi.fn(), pythonPath: vi.fn() }));
vi.mock('@multi-cc-im/cli-codex', async original => ({ ...await original<object>(),
  resolveCodexHookOrigin: mocks.resolve, resolveCodexSessionName: mocks.name, runHookReceiver: mocks.receive }));
vi.mock('@multi-cc-im/term-wezterm', () => ({ resolveWezTermPath: mocks.weztermPath,
  createWezTermAdapter: mocks.wezterm }));
vi.mock('@multi-cc-im/term-iterm2', () => ({ resolvePython3Path: mocks.pythonPath,
  createITerm2Adapter: mocks.iterm }));
vi.mock('./start.js', () => ({ resolveIterm2HelperPath: async () => '/fixture/helper.py' }));
const { runCodexHookCommand } = await import('./codex-hook.js');

const payload = { hook_event_name: 'Stop', session_id: 'native-thread', cwd: '/fixture', transcript_path: null,
  model: 'fixture', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'answer', turn_id: 'turn' };
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; vi.resetAllMocks(); });

describe('production Codex hook entry', () => {
  it.each([
    ['wezterm', 'PreToolUse'], ['iterm2', 'PreToolUse'],
    ['wezterm', 'PermissionRequest'], ['iterm2', 'PermissionRequest'],
  ] as const)('uses the configured %s terminal for %s hooks', async (terminal, event) => {
    root = await mkdtemp(join(tmpdir(), 'codex-entry-'));
    const paths = resolveAppPaths({ env: { MULTI_CC_IM_HOME: root } });
    const store = createConfigStore({ filePath: paths.configToml });
    const config = await store.load();
    await store.save({ ...config, cli: { ...config.cli, enabled: ['codex'], aiRouter: 'codex' }, terminal: { type: terminal } });
    mocks.wezterm.mockReturnValue({ listPanes: mocks.list }); mocks.iterm.mockReturnValue({ listPanes: mocks.list });
    mocks.weztermPath.mockResolvedValue('/fixture/wezterm'); mocks.pythonPath.mockResolvedValue('/fixture/python3');
    mocks.list.mockResolvedValue([]);
    mocks.resolve.mockResolvedValue({ termId: terminal, paneId: 'verified-pane' });
    mocks.receive.mockImplementation(async (opts: { resolvePaneOrigin(threadId: string): Promise<unknown> }) => { await opts.resolvePaneOrigin(payload.session_id); });
    await runCodexHookCommand(JSON.stringify({ ...payload, hook_event_name: event, tool_name: 'shell', tool_input: {}, tool_use_id: 'tool' }), { paths, onError: vi.fn() });
    const selected = terminal === 'wezterm' ? mocks.wezterm : mocks.iterm;
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ listTimeoutMs: 600 }));
    expect(mocks.resolve).toHaveBeenCalledWith('native-thread', expect.objectContaining({ terminalId: terminal }));
    const dependencies = mocks.resolve.mock.calls[0]![1] as { listPanes(): Promise<unknown> };
    await dependencies.listPanes(); expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.name).not.toHaveBeenCalled();
  });
  it.each(['wezterm', 'iterm2'] as const)('resolves the Stop session name with %s selected and unavailable terminal binaries', async terminal => {
    root = await mkdtemp(join(tmpdir(), 'codex-stop-entry-'));
    const paths = resolveAppPaths({ env: { MULTI_CC_IM_HOME: root } });
    const store = createConfigStore({ filePath: paths.configToml });
    const config = await store.load();
    await store.save({ ...config, cli: { ...config.cli, enabled: ['codex'], aiRouter: 'codex' }, terminal: { type: terminal } });
    mocks.weztermPath.mockRejectedValue(new Error('terminal binary unavailable'));
    mocks.pythonPath.mockRejectedValue(new Error('terminal binary unavailable'));
    mocks.name.mockResolvedValue('native-session-name');
    mocks.receive.mockImplementation(async (opts: { stop: { termId: string; resolveSessionName(threadId: string): Promise<unknown> } }) => {
      expect(opts.stop.termId).toBe(terminal);
      expect(await opts.stop.resolveSessionName(payload.session_id)).toBe('native-session-name');
    });
    const onError = vi.fn();
    await runCodexHookCommand(JSON.stringify(payload), { paths, onError });
    expect(mocks.name).toHaveBeenCalledWith(payload.session_id, { onError });
    expect(mocks.weztermPath).not.toHaveBeenCalled();
    expect(mocks.pythonPath).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.wezterm).not.toHaveBeenCalled();
    expect(mocks.iterm).not.toHaveBeenCalled();
  });
  it('leaves hooks in native control when Codex bridging is disabled', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-disabled-'));
    const paths = resolveAppPaths({ env: { MULTI_CC_IM_HOME: root } });
    await runCodexHookCommand(JSON.stringify(payload), { paths, onError: vi.fn() });
    expect(mocks.receive).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.name).not.toHaveBeenCalled();
  });
  it('does not register a server pane on native SessionStart', async () => {
    await runCodexHookCommand(JSON.stringify({ ...payload, hook_event_name: 'SessionStart', source: 'startup' }), { onError: vi.fn() });
    expect(mocks.receive).not.toHaveBeenCalled(); expect(mocks.wezterm).not.toHaveBeenCalled();
    expect(mocks.name).not.toHaveBeenCalled();
  });
});
