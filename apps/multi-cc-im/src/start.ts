import { stat } from 'node:fs/promises';
import { formatErrorWithCause, type PaneId } from '@multi-cc-im/shared';
import {
  createOrchestrator,
  type BridgeOrchestrator,
} from '@multi-cc-im/bridge';
import type { RouterState } from '@multi-cc-im/bridge';
import {
  captureProcessLstart,
  createCcCliAdapter,
  deleteIMOriginFile,
  deleteIMWorkFile,
  isDaemonAlive,
  readDaemonPidFile,
  writeDaemonPidFile,
} from '@multi-cc-im/cli-cc';
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
import { runSetupHooksCommand } from './setup-hooks.js';
import { sweepStaleStateFiles } from './state-sweep.js';

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
   * Skip the auto-`setup-hooks` step at the top of `start`. Default `false`:
   * `runStartCommand` runs `runSetupHooksCommand` first so users don't have
   * to remember a separate command — it's idempotent (no-op when already
   * up-to-date). Tests set this to `true` to keep their fake state dir from
   * touching `~/.claude/settings.json`.
   */
  skipSetupHooks?: boolean;
  /**
   * Override the auto-setup-hooks function. Default: real
   * `runSetupHooksCommand`. Tests inject a spy to assert the call without
   * actually rewriting `~/.claude/settings.json`. Ignored when
   * `skipSetupHooks=true`.
   */
  setupHooks?: (opts: { log: (line: string) => void }) => Promise<{
    exitCode: number;
    stderr: string;
  }>;
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

  // ===== 0. Auto-register cc hooks =====
  // Idempotent — same as `multi-cc-im setup-hooks`. Run unconditionally so
  // users don't have to remember a separate setup step; if hooks are already
  // up-to-date this is a no-op (no .bak file, no log noise beyond the
  // "already up-to-date" line).
  if (!opts.skipSetupHooks) {
    const setupFn = opts.setupHooks ?? runSetupHooksCommand;
    const setupResult = await setupFn({ log });
    if (setupResult.exitCode !== 0) {
      return {
        exitCode: 1,
        stderr:
          `multi-cc-im start: setup-hooks failed — cannot proceed.\n` +
          setupResult.stderr,
      };
    }
  }

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

  // ===== 1b'. Double-start check =====
  // Per [DD: daemon liveness](../../docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md).
  // If state/daemon.pid points at a still-alive daemon (PID + lstart match),
  // refuse to start a second one — iLink getupdates cursor is global so two
  // daemons would steal each other's messages, creating a debug black hole.
  // Stale lock (PID dead OR lstart mismatch) → silently overwrite later.
  if (await isDaemonAlive(paths.stateDir)) {
    const existing = await readDaemonPidFile(paths.stateDir);
    return {
      exitCode: 1,
      stderr:
        `multi-cc-im start: another daemon already running.\n` +
        `  PID:    ${existing?.pid ?? 'unknown'}\n` +
        `  Start:  ${existing?.startedAt ?? 'unknown'}\n` +
        `  Stop:   pkill -f 'multi-cc-im start'   (or kill ${existing?.pid ?? '<pid>'})\n` +
        `\n` +
        `If you're sure no daemon is running, the lock file may be stale:\n` +
        `  rm ${paths.stateDir}/daemon.pid`,
    };
  }

  // ===== 1c. Sweep stale state files BEFORE chokidar starts watching =====
  // Per [DD: pane-keyed state files](../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
  // wezterm cli list paneId set is the ground truth — files for paneIds not
  // in the live set are orphan (cc + tab gone). Pre-DD-#61 sid-keyed legacy
  // files are also swept here.
  const sweepResult = await sweepStaleStateFiles(paths.stateDir, {
    livePaneIds: async () => {
      const tabs = await listAllTabs({ wezterm });
      return [...tabs.keys()];
    },
  });
  if (
    sweepResult.orphanPaneFilesCleaned +
      sweepResult.legacyCleaned +
      sweepResult.staleDaemonPidCleaned >
    0
  ) {
    log(
      `  ✓ state sweep: ${sweepResult.orphanPaneFilesCleaned} orphan pane file(s), ${sweepResult.legacyCleaned} legacy, ${sweepResult.staleDaemonPidCleaned} stale daemon.pid cleaned`,
    );
  }

  // ===== 1d. Reset IMWork + IMOrigin to clean state on every daemon start =====
  // Per [DD: IMWork+IMOrigin](../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md)
  // §5.3 — daemon start auto-resets IM mode to off, forcing user to re-issue
  // `/start` from IM if they want remote mode again. Safer than
  // honoring stale "user was in IM mode last week" state.
  //
  // Per [DD: IMOrigin global](../../docs/superpowers/specs/2026-05-08-imorigin-global-dd.md):
  // IMOrigin is also wiped on start as a crash-path safety net. Stale
  // `context_token` from a SIGKILL'd / OOM'd previous daemon would 4xx /
  // RST against the iLink server (server only honors latest token issued
  // for the current user-bot conversation).
  try {
    await deleteIMWorkFile(paths.stateDir);
  } catch (err) {
    log(
      `  ⚠️  failed to reset IMWork on start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await deleteIMOriginFile(paths.stateDir);
  } catch (err) {
    log(
      `  ⚠️  failed to reset IMOrigin on start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log(
    `  ✓ IMWork: OFF (run \`/start\` from IM to enable)`,
  );

  // ===== 1e. Write daemon.pid lock file =====
  // Per [DD: daemon liveness](../../docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md).
  // Hook subprocesses (cc child processes) read this file to verify the
  // daemon is alive before walking the forward path; if missing or stale
  // they emit `permissionDecision: ask` so cc TUI handles approvals.
  try {
    const lstart = await captureProcessLstart(process.pid);
    if (lstart === null) {
      log(
        `  ⚠️  failed to capture daemon lstart — hook liveness check will fail`,
      );
    } else {
      await writeDaemonPidFile({
        stateDir: paths.stateDir,
        pid: process.pid,
        startedAt: lstart,
      });
      log(`  ✓ daemon.pid: PID ${process.pid}, lstart "${lstart}"`);
    }
  } catch (err) {
    log(
      `  ⚠️  failed to write daemon.pid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ===== 2. Build adapters =====
  const credentialStore = createCredentialStore<WeixinCredentials>({
    filePath: credentialPath,
    schema: WeixinCredentialsSchema,
  });
  const cursorStore = createCursorStore({
    filePath: `${paths.stateDir}/wechat-cursor`,
  });
  // In-memory sticky `current_pane` — last-explicit-mention pointer.
  // Does NOT persist across daemon restart (the user re-binds by sending
  // `@<name> <body>` from IM after restart).
  let currentPaneId: PaneId | null = null;
  const routerState: RouterState = {
    getCurrent: () => currentPaneId,
    setCurrent: (id) => {
      currentPaneId = id;
    },
  };

  // No session registry anymore (DD #61). Bridge router queries
  // `termAdapter.listPanes()` on each IM event for live tab data.
  const livePanes = await listAllTabs({ wezterm }).catch(() => null);
  if (livePanes !== null) {
    const renamed = [...livePanes.values()].filter((t) => t.title.length > 0);
    log(
      `  ✓ wezterm panes: ${livePanes.size} total, ${renamed.length} /rename'd${livePanes.size === 0 ? ' (open a wezterm tab + run cc to see panes appear)' : ''}`,
    );
  }

  const imAdapter = createWeixinAdapter({
    configStore,
    cursorStore,
    credentialStore,
    inboundMediaDir: paths.inboundFor('wechat'),
  });
  const termAdapter = createWezTermAdapter({
    wezterm: { path: wezterm },
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
        stateDir: paths.stateDir,
        state: routerState,
        log,
        onError: (err, ctx) => {
          const msg = formatErrorWithCause(err);
          const tag =
            ctx.paneId !== undefined
              ? `pane=${ctx.paneId}`
              : ctx.sessionId
                ? `sid=${ctx.sessionId.slice(0, 8)}`
                : '';
          log(
            `  ⚠️  orchestrator [${ctx.phase}${tag ? ' ' + tag : ''}]: ${msg}`,
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
 * Default wezterm path resolver: try cached path first, fall back to PATH +
 * macOS bundle discovery via `resolveWezTermPath` from `@multi-cc-im/term-wezterm`.
 */
async function defaultResolveWezTerm(cachedPath?: string): Promise<string> {
  return resolveWezTermPath(cachedPath ? { cachedPath } : {});
}
