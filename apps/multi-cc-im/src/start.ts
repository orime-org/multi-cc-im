import { stat } from 'node:fs/promises';
import type { SessionId } from '@multi-cc-im/shared';
import {
  createOrchestrator,
  createSessionRegistry,
  type BridgeOrchestrator,
} from '@multi-cc-im/bridge';
import type { RouterState } from '@multi-cc-im/bridge';
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
  listAllTabs,
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
  /**
   * Logger for pre-flight banner + ready / error lines. Default writes to
   * `process.stderr` (CLAUDE.md "multi-cc-im hook must not write non-protocol
   * stdout" reserves stdout for hook decision JSON; the start subcommand isn't
   * a hook but stays consistent so stderr is the default diagnostic channel).
   * Tests inject a spy to assert log content without polluting test
   * stdout/stderr.
   */
  log?: (line: string) => void;
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
  const log = opts.log ?? defaultLog;

  log(`multi-cc-im start (root: ${paths.root})`);

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
  log(`  ✓ wechat credentials at ${credentialPath}`);

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
    log(`  ✓ wezterm at ${wezterm} (cached to config.toml)`);
  } else {
    log(`  ✓ wezterm at ${wezterm}`);
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
    getTabTitles: () => listAllTabs({ wezterm }),
  });
  // In-memory sticky `current_session` — last-explicit-mention pointer per
  // routing G' DD. Does NOT persist across daemon restart by design (cc reply
  // contexts in `lastReplyCtxBySession` are also in-memory; the user re-binds
  // by sending `@<name> <body>` from WeChat after restart).
  let currentSid: SessionId | null = null;
  const routerState: RouterState = {
    getCurrent: () => currentSid,
    setCurrent: (id) => {
      currentSid = id;
    },
  };

  const aliveSessions = await registry.listAlive();
  log(
    `  ✓ session registry: ${aliveSessions.length} alive cc session(s)${aliveSessions.length === 0 ? ' (start cc in any wezterm tab to see them appear)' : ''}`,
  );

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
        log,
        onError: (err, ctx) => {
          const msg = formatErrorWithCause(err);
          log(
            `  ⚠️  orchestrator [${ctx.phase}${ctx.sessionId ? ` ${ctx.sessionId.slice(0, 8)}` : ''}]: ${msg}`,
          );
        },
      });

  await orchestrator.start();
  log(`  ✓ orchestrator started — bridge running. Ctrl+C to stop.`);

  return {
    exitCode: 0,
    stderr: '',
    shutdown: async () => {
      await orchestrator.stop();
    },
  };
}

/** Default log sink writes to stderr (stdout reserved for hook protocol). */
function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Render an error including its cause chain. Node 22+ `fetch` rejects with a
 * generic `Error: fetch failed` whose `.cause` carries the real reason
 * (`ECONNREFUSED`, `ETIMEDOUT`, undici socket errors, etc.). The default
 * logger only printed `err.message` and dropped that, leaving messages like
 * "fetch failed" with no diagnostic value. Walk the chain so the daemon log
 * shows e.g. `fetch failed (cause: connect ECONNREFUSED 14.18.180.207:443
 * [code=ECONNREFUSED])`.
 */
function formatErrorWithCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  let depth = 0;
  let cur: unknown = (err as Error & { cause?: unknown }).cause;
  while (cur !== undefined && cur !== null && depth < 5) {
    if (cur instanceof Error) {
      const code = (cur as Error & { code?: unknown }).code;
      const codeStr = typeof code === 'string' ? ` [code=${code}]` : '';
      parts.push(`cause: ${cur.message}${codeStr}`);
      cur = (cur as Error & { cause?: unknown }).cause;
    } else {
      parts.push(`cause: ${String(cur)}`);
      break;
    }
    depth++;
  }
  return parts.length === 1 ? parts[0]! : `${parts[0]} (${parts.slice(1).join('; ')})`;
}

/**
 * Default wezterm path resolver: try cached path first, fall back to PATH +
 * macOS bundle discovery via `resolveWezTermPath` from `@multi-cc-im/term-wezterm`.
 */
async function defaultResolveWezTerm(cachedPath?: string): Promise<string> {
  return resolveWezTermPath(cachedPath ? { cachedPath } : {});
}
