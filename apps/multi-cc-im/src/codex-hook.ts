import { parseHookPayload, resolveCodexHookOrigin, resolveCodexSessionName, runHookReceiver, type HookReceiverOutput } from '@multi-cc-im/cli-codex';
import { createConfigStore } from '@multi-cc-im/storage-files';
import { createWezTermAdapter, resolveWezTermPath } from '@multi-cc-im/term-wezterm';
import { createITerm2Adapter, resolvePython3Path } from '@multi-cc-im/term-iterm2';
import { resolveIterm2HelperPath } from './start.js';
import { resolveAppPaths, type AppPaths } from './config-paths.js';

/**
 * Dispatch native Stop replies by session name and permission hooks by pane origin.
 * @param rawStdin Native hook JSON; SessionStart remains a side-effect-free no-op.
 * @param opts Paths and diagnostics, injectable to avoid real dotfiles in tests.
 * @returns Native hook output, or no opinion when identity cannot be established.
 * @throws Invalid input, configuration or terminal installation errors.
 * @example await runCodexHookCommand(stdin, { onError });
 */
export async function runCodexHookCommand(rawStdin: string, opts: {
  paths?: AppPaths;
  onError(err: unknown): void;
}): Promise<HookReceiverOutput> {
  const paths = opts.paths ?? resolveAppPaths();
  const payload = parseHookPayload(rawStdin);
  if (payload.hook_event_name === 'SessionStart') return;
  const config = await createConfigStore({ filePath: paths.configToml }).load();
  if (!config.cli.enabled.includes('codex')) return;
  const terminalId = config.terminal.type;
  if (payload.hook_event_name === 'Stop') {
    return runHookReceiver({ stateDir: paths.stateDir, payload,
      stop: { termId: terminalId,
        resolveSessionName: threadId => resolveCodexSessionName(threadId, { onError: opts.onError }) },
    });
  }
  // Bound only the owned listing subprocess; never signal a user terminal/TUI.
  const term = terminalId === 'wezterm'
    ? createWezTermAdapter({ wezterm: { path: await resolveWezTermPath({ cachedPath: config.external_paths.wezterm }) }, listTimeoutMs: 600 })
    : createITerm2Adapter({ python: { path: await resolvePython3Path({ cachedPath: config.external_paths.python3 }) },
      helperScript: { path: await resolveIterm2HelperPath() }, listTimeoutMs: 600 });
  return runHookReceiver({ stateDir: paths.stateDir, payload,
    resolvePaneOrigin: threadId => resolveCodexHookOrigin(threadId, { terminalId,
      listPanes: () => term.listPanes(), onError: opts.onError }),
  });
}
