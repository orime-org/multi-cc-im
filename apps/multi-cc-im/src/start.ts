import { stat } from 'node:fs/promises';
import {
  createOrchestrator,
  createPersistentRouterState,
  createSessionRegistry,
  type BridgeOrchestrator,
} from '@multi-cc-im/bridge';
import { createCcCliAdapter } from '@multi-cc-im/cli-cc';
import {
  createWeixinAdapter,
  WeixinCredentialsSchema,
  type WeixinCredentials,
} from '@multi-cc-im/im-wechat';
import {
  createConfigStore,
  createCredentialStore,
  createCursorStore,
} from '@multi-cc-im/storage-files';
import {
  createWezTermAdapter,
  resolveWezTermPath,
} from '@multi-cc-im/term-wezterm';
import { resolveAppPaths } from './config-paths.js';

export interface RunStartCommandOpts {
  /** Override `~/.multi-cc-im` root (env or for tests). */
  root?: string;
  /**
   * Override wezterm path resolution. Default uses `resolveWezTermPath` from
   * `@multi-cc-im/term-wezterm` with cached path from `config.toml
   * [external_paths].wezterm`. Tests stub this to avoid real PATH lookups.
   */
  resolveWezTerm?: (cachedPath?: string) => Promise<string>;
  /**
   * Override orchestrator construction. Tests stub to avoid real adapter
   * lifecycle / IM long-poll.
   */
  buildOrchestrator?: () => BridgeOrchestrator;
}

export interface StartCommandResult {
  exitCode: number;
  stderr: string;
  /**
   * Graceful shutdown handle when `exitCode === 0`. Caller (CLI dispatcher)
   * binds SIGINT/SIGTERM to this. Awaits orchestrator.stop + flushes
   * persistent state before returning.
   */
  shutdown?: () => Promise<void>;
}

/**
 * Implement `multi-cc-im start` — the main bridge daemon. Wiring order:
 *
 * 1. **Pre-flight**:
 *    - Resolve `~/.multi-cc-im/...` paths
 *    - Verify `credentials/wechat.json` exists (else error "run login first")
 *    - Resolve & cache wezterm absolute path (config.toml `[external_paths].wezterm`)
 * 2. **Build adapters**:
 *    - `ConfigStore` (TOML user config)
 *    - `CursorStore` (iLink long-poll cursor under `state/wechat-cursor`)
 *    - `CredentialStore<WeixinCredentials>` (`credentials/wechat.json`)
 *    - `SessionRegistry & PaneToSessionMap` (scan `state/*.cc-pid` + friendly_names)
 *    - `PersistentRouterState` (`state/current-session`)
 *    - `WeixinAdapter` (im-wechat IMAdapter)
 *    - `WezTermAdapter & TermPaneAlive` (term-wezterm with paneToSession injection)
 *    - `CcCliAdapter` (cli-cc file-watching CLIAdapter)
 *    - `BridgeOrchestrator` (wires the 3 adapters + registry + state through router)
 * 3. **Start** orchestrator + return shutdown handle.
 *
 * Tests stub `resolveWezTerm` + `buildOrchestrator` to exercise the pre-flight
 * branches without spawning real OS processes.
 */
export async function runStartCommand(
  opts: RunStartCommandOpts = {},
): Promise<StartCommandResult> {
  const paths = opts.root
    ? resolveAppPaths({ env: { MULTI_CC_IM_HOME: opts.root } })
    : resolveAppPaths();

  // ===== 1. Pre-flight: credentials =====
  const credentialPath = paths.credentialFor('wechat');
  try {
    await stat(credentialPath);
  } catch {
    return {
      exitCode: 1,
      stderr: `multi-cc-im start: wechat credentials not found at ${credentialPath}\n  Run \`multi-cc-im login wechat\` first to scan QR + save bot_token.`,
    };
  }

  // ===== 1b. Pre-flight: wezterm path resolution =====
  const configStore = createConfigStore({ filePath: paths.configToml });
  let config = await configStore.load();
  let wezterm: string;
  try {
    const resolveFn = opts.resolveWezTerm ?? defaultResolveWezTerm;
    wezterm = await resolveFn(config.external_paths.wezterm);
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `multi-cc-im start: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Cache the resolved path back to config.toml if it changed
  if (config.external_paths.wezterm !== wezterm) {
    config = {
      ...config,
      external_paths: { ...config.external_paths, wezterm },
    };
    await configStore.save(config);
  }

  // ===== 2. Build adapters =====
  const credentialStore = createCredentialStore<WeixinCredentials>({
    filePath: credentialPath,
    schema: WeixinCredentialsSchema,
  });
  const cursorStore = createCursorStore({
    filePath: `${paths.stateDir}/wechat-cursor`,
  });
  const registry = createSessionRegistry({
    stateDir: paths.stateDir,
    configStore,
  });
  const routerState = await createPersistentRouterState({
    stateDir: paths.stateDir,
  });

  const imAdapter = createWeixinAdapter({
    configStore,
    cursorStore,
    credentialStore,
    inboundMediaDir: paths.inboundFor('wechat'),
  });
  const termAdapter = createWezTermAdapter({
    wezterm: { path: wezterm },
    paneAlive: {
      stateDir: paths.stateDir,
      paneToSession: registry,
    },
  });
  const cliAdapter = createCcCliAdapter({
    stateDir: paths.stateDir,
  });

  // ===== 3. Build + start orchestrator =====
  const orchestrator = opts.buildOrchestrator
    ? opts.buildOrchestrator()
    : createOrchestrator({
        imAdapter,
        termAdapter,
        cliAdapter,
        registry,
        state: routerState,
      });

  await orchestrator.start();

  return {
    exitCode: 0,
    stderr: '',
    shutdown: async () => {
      await orchestrator.stop();
      await routerState.flush();
    },
  };
}

/**
 * Default wezterm path resolver: try cached path first, fall back to PATH +
 * macOS bundle discovery via `resolveWezTermPath` from `@multi-cc-im/term-wezterm`.
 */
async function defaultResolveWezTerm(cachedPath?: string): Promise<string> {
  return resolveWezTermPath(cachedPath ? { cachedPath } : {});
}
