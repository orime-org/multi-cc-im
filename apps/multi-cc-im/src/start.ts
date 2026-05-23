import { formatErrorWithCause, type PaneId } from '@multi-cc-im/shared';
import {
  createOrchestrator,
  routeViaCodex,
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
import { createCodexCliAdapter } from '@multi-cc-im/cli-codex';
import { createConfigStore } from '@multi-cc-im/storage-files';
import {
  createWezTermAdapter,
  listAllTabs,
  resolveWezTermPath,
} from '@multi-cc-im/term-wezterm';
import {
  createITerm2Adapter,
  resolvePython3Path,
} from '@multi-cc-im/term-iterm2';
import {
  startMonitor,
  ErrorRingBuffer,
  DEFAULT_MONITOR_PORT,
  type MonitorHandle,
  type DaemonStateSnapshot,
  type SessionSnapshot,
} from '@multi-cc-im/monitor';
import type { TerminalId } from '@multi-cc-im/shared';
import {
  selectTerminal,
  type SelectTerminalResult,
} from './terminal-selector.js';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, constants, mkdir } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { adapters, type AdapterRegistryEntry } from './adapters.js';
import {
  selectAndConfigureAdapter,
  type SelectAdapterResult,
} from './adapter-selector.js';
import { selectCLIs, type SelectCLIsResult } from './cli-selector.js';
import {
  selectAIRouter,
  type SelectAIRouterResult,
} from './ai-router-selector.js';
import { resolveAppPaths } from './config-paths.js';
import { runSetupHooksCommand } from './setup-hooks.js';
import { runCodexSetupHooks } from '@multi-cc-im/cli-codex';
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
  /**
   * Optional positional CLI arg `multi-cc-im start [<adapter>]`. When set,
   * skips the interactive adapter-selection menu and looks up the named
   * adapter in the registry directly. Per
   * [DD §4](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#4-d1--locked-decision-single-start-command).
   */
  adapterArg?: string;
  /**
   * Override the CLI multiselect wizard step (step 1 of 4). Tests stub
   * this to return a synthetic CLI selection without prompting. Default
   * runs `selectCLIs` from `cli-selector.ts`.
   */
  selectCLIs?: (opts: {
    currentEnabled?: readonly import('@multi-cc-im/shared').CLIId[];
  }) => Promise<import('./cli-selector.js').SelectCLIsResult>;
  /**
   * Override the AI router single-select wizard step (step 2 of 4).
   * Tests stub this to bypass the prompt. Default runs `selectAIRouter`
   * from `ai-router-selector.ts`.
   */
  selectAIRouter?: (opts: {
    enabledCLIs: readonly import('@multi-cc-im/shared').CLIId[];
    currentAIRouter?: import('@multi-cc-im/shared').CLIId;
  }) => Promise<import('./ai-router-selector.js').SelectAIRouterResult>;
  /**
   * Override the codex setup-hooks runner (writes `~/.codex/config.toml`).
   * Default runs `runCodexSetupHooks` from `@multi-cc-im/cli-codex`.
   * Tests stub to avoid touching the real user config.
   */
  setupHooksCodex?: (opts: {
    binaryPath: string;
    log?: (line: string) => void;
  }) => Promise<{ changed: boolean; configPath: string }>;

  /**
   * Override the adapter registry consulted by the default selector.
   * Tests inject a fixture registry (with stubbed `buildAdapterRuntime`)
   * to avoid spinning up real IM adapters. Production passes nothing
   * (defaults to the package-level `adapters` array).
   */
  registry?: readonly AdapterRegistryEntry[];

  /**
   * Override the adapter selection / wizard flow. Default uses
   * `selectAndConfigureAdapter` (interactive menu / arg lookup / wizard
   * branch per DD D1). Tests stub this to return a chosen adapter
   * synthetically without prompting.
   */
  selectAdapter?: () => Promise<SelectAdapterResult>;
  /**
   * Override the terminal-adapter selection wizard. Default uses
   * `selectTerminal` (interactive wezterm/iterm2 picker with iterm2
   * setup pipeline). Tests inject a stub that returns a fixed terminal
   * choice without prompting.
   *
   * Per [DD: iTerm2 adapter P4](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#9-implementation-milestone-plan-to-be-detailed-after-lock).
   */
  selectTerminal?: (opts: {
    currentTerminal?: TerminalId;
  }) => Promise<SelectTerminalResult>;
  /**
   * Override python3 resolver (iterm2 path). Default delegates to
   * `defaultResolvePython3` (cache-then-PATH-scan). Tests stub to skip
   * filesystem.
   */
  resolvePython3?: (cachedPath?: string) => Promise<string>;
  /**
   * Override iterm2-helper.py resolver. Default delegates to
   * `resolveIterm2HelperPath`. Tests stub to return a fixed path
   * (typically a stub script).
   */
  resolveIterm2Helper?: () => Promise<string>;
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
 *    - Verify `credentials/lark.json` exists (else error "run login lark first")
 *    - Resolve & cache wezterm absolute path (config.toml `[external_paths].wezterm`)
 *    - Double-start guard via `state/daemon.pid` (DD: daemon liveness)
 *    - State-dir sweep + IMWork/IMOrigin reset + daemon.pid write
 * 2. **Build adapters**:
 *    - `ConfigStore` (TOML user config)
 *    - `CredentialStore<LarkCredentials>` (`credentials/lark.json`)
 *    - `LarkAdapter` (im-lark IMAdapter — `lark.WSClient` long-connection
 *      inbound + `client.im.v1.message.create` outbound, per DD #86)
 *    - `WezTermAdapter & TermListPanes` (term-wezterm)
 *    - `CcCliAdapter` (cli-cc file-watching CLIAdapter)
 *    - `BridgeOrchestrator` (wires the 3 adapters + state through router)
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

  // Diagnostic daemon log file. Only created when caller does NOT inject
  // `opts.log` — production daemon gets the dual-write (stderr + file)
  // logger; tests pass their own `opts.log` stub and bypass file I/O.
  // File is append-only across daemon restarts so post-mortem inspection
  // survives Ctrl+C / SIGKILL.
  let logStream: WriteStream | null = null;
  if (opts.log === undefined) {
    try {
      await mkdir(paths.root, { recursive: true });
      logStream = createWriteStream(paths.daemonLog, {
        flags: 'a',
        mode: 0o600,
      });
      // Swallow stream-level errors (disk full / permission revoked mid-
      // run); the daemon should keep running even if the log file goes
      // bad — stderr is the primary output.
      logStream.on('error', () => {
        /* intentional swallow */
      });
      const ts = new Date().toISOString();
      logStream.write(
        `${ts} === daemon started PID=${process.pid} root=${paths.root} ===\n`,
      );
    } catch {
      // If the file can't be opened at all, fall back to stderr-only.
      logStream = null;
    }
  }

  const log = opts.log ?? ((line: string) => {
    process.stderr.write(`${line}\n`);
    if (logStream) {
      const ts = new Date().toISOString();
      logStream.write(`${ts} ${line}\n`);
    }
  });
  /**
   * File-only sink. Same destination as `log`'s file half, but skips
   * stderr — used for high-volume / low-signal traces (iterm2-helper
   * per-invocation lines, etc.) that AI needs for post-mortem but
   * users shouldn't see clutter their daemon console. Tests inject
   * `opts.log` and bypass file I/O entirely → fileOnlyLog falls back
   * to a no-op so tests stay clean. Per user feedback 2026-05-14
   * after PR #175 real-account smoke: iterm2-helper lines were
   * flooding the daemon console.
   */
  const fileOnlyLog =
    opts.log === undefined && logStream
      ? (line: string) => {
          const ts = new Date().toISOString();
          logStream!.write(`${ts} ${line}\n`);
        }
      : () => {};

  log(`multi-cc-im start (root: ${paths.root})`);

  // Load persisted config FIRST so the CLI multiselect can pre-check
  // the user's last selection (and same for terminal / AI router below).
  // Per [DD 2026-05-23 revision](../../../docs/superpowers/specs/2026-05-22-codex-cli-adapter-dd.md):
  // wizard order is now CLI multi → AI router → terminal → IM.
  const configStore = createConfigStore({ filePath: paths.configToml });
  let config = await configStore.load();
  let persistedConfigChanged = false;

  // ===== Step 1. CLI multiselect =====
  // Pick which CLI agents (Claude Code / Codex / etc.) the daemon
  // bridges to IM. Probes installed status via `command -v` so the
  // user sees disk state inline. Multi-pick supports the "wezterm has
  // both a cc tab and a codex tab; both reachable from phone IM" use
  // case. Persisted to `[cli].enabled` for next-start pre-check.
  const cliFn =
    opts.selectCLIs ??
    ((cliOpts) => selectCLIs(cliOpts));
  const cliResult = await cliFn({ currentEnabled: config.cli.enabled });
  if (cliResult.status === 'cancelled') {
    return { exitCode: 0, stderr: '' };
  }
  if (cliResult.status === 'error') {
    return { exitCode: cliResult.exitCode, stderr: cliResult.message };
  }
  const enabledCLIs = cliResult.ids;
  log(`  ✓ enabled CLIs: ${enabledCLIs.join(', ')}`);
  if (
    config.cli.enabled.length !== enabledCLIs.length ||
    config.cli.enabled.some((id, i) => id !== enabledCLIs[i])
  ) {
    config = {
      ...config,
      cli: { ...config.cli, enabled: [...enabledCLIs] },
    };
    persistedConfigChanged = true;
  }

  // ===== Step 1b. Auto-register hooks for each enabled CLI =====
  // Per enabled CLI id: cc → `~/.claude/settings.json` via
  // `runSetupHooksCommand`; codex → `~/.codex/config.toml` via
  // `runCodexSetupHooks`. Both are idempotent — repeat starts on an
  // already-configured machine are no-ops + leave no .bak.<ts> noise.
  // Hook writers backup before edit per [[feedback_user_dotfile_backup]].
  if (!opts.skipSetupHooks) {
    if (enabledCLIs.includes('cc')) {
      const setupFn = opts.setupHooks ?? runSetupHooksCommand;
      const setupResult = await setupFn({ log });
      if (setupResult.exitCode !== 0) {
        return {
          exitCode: 1,
          stderr:
            `multi-cc-im start: cc setup-hooks failed — cannot proceed.\n` +
            setupResult.stderr,
        };
      }
    }
    if (enabledCLIs.includes('codex')) {
      // Codex hooks need the resolved multi-cc-im binary path so the
      // hook command can re-exec us. Mirror the same resolution
      // cli-cc setup-hooks uses (process.argv[1] = the bin script we
      // were launched as).
      const codexFn = opts.setupHooksCodex ?? runCodexSetupHooks;
      try {
        await codexFn({
          binaryPath: process.argv[1] ?? 'multi-cc-im',
          log,
        });
      } catch (err) {
        return {
          exitCode: 1,
          stderr:
            `multi-cc-im start: codex setup-hooks failed — cannot proceed.\n` +
            (err instanceof Error ? err.message : String(err)),
        };
      }
    }
  }

  // ===== Step 2. AI router single-select =====
  // Pick which CLI runs the daemon's IM triage subprocess. Even when
  // enabledCLIs.length === 1 the wizard still asks — per explicit user
  // direction 2026-05-23 ("第 2 步不能跳过"). Persisted to
  // `[cli].aiRouter` for next-start pre-select.
  const routerFn =
    opts.selectAIRouter ??
    ((routerOpts) => selectAIRouter(routerOpts));
  const routerResult = await routerFn({
    enabledCLIs,
    currentAIRouter: config.cli.aiRouter,
  });
  if (routerResult.status === 'cancelled') {
    return { exitCode: 0, stderr: '' };
  }
  if (routerResult.status === 'error') {
    return { exitCode: routerResult.exitCode, stderr: routerResult.message };
  }
  const aiRouterCLI = routerResult.id;
  log(`  ✓ AI router: ${aiRouterCLI}`);
  if (config.cli.aiRouter !== aiRouterCLI) {
    config = {
      ...config,
      cli: { ...config.cli, aiRouter: aiRouterCLI },
    };
    persistedConfigChanged = true;
  }

  // ===== Step 3. Terminal-adapter selection =====
  // Per [DD: iTerm2 adapter P4](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md):
  // Persisted terminal type pre-selects the current choice; a brand-new
  // config defaults to wezterm. iterm2 branch runs setup (prefs check +
  // pip install + cache python3 path).
  const termFn =
    opts.selectTerminal ??
    ((termOpts) => selectTerminal(termOpts));
  const termResult = await termFn({ currentTerminal: config.terminal.type });
  if (termResult.status === 'cancelled') {
    return { exitCode: 0, stderr: '' };
  }
  if (termResult.status === 'error') {
    return { exitCode: termResult.exitCode, stderr: termResult.message };
  }
  const termId = termResult.id;
  log(`  ✓ terminal: ${termId}`);
  // Persist new terminal id + (iterm2) python3 path. Tests confirm an
  // already-aligned config skips the rewrite (no spurious file mtime
  // churn). `persistedConfigChanged` is hoisted up to step 1 (CLI
  // multiselect) so all wizard steps share one save() at the end.
  if (config.terminal.type !== termId) {
    config = { ...config, terminal: { type: termId } };
    persistedConfigChanged = true;
  }
  if (
    termId === 'iterm2' &&
    termResult.python3 &&
    config.external_paths.python3 !== termResult.python3
  ) {
    config = {
      ...config,
      external_paths: {
        ...config.external_paths,
        python3: termResult.python3,
      },
    };
    persistedConfigChanged = true;
  }
  if (persistedConfigChanged) {
    await configStore.save(config);
  }

  // ===== 1. Pre-flight: adapter selection + credentials =====
  // Per [DD §4 D1](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#4-d1--locked-decision-single-start-command):
  // single `start [<adapter>]` command — no-arg renders an interactive
  // adapter menu, with-arg looks up the registry directly. If the picked
  // adapter has no creds, branches into the W4 wizard (or returns
  // 'cancelled'/'error' so the caller can exit cleanly).
  const registry = opts.registry ?? adapters;
  const selectFn =
    opts.selectAdapter ??
    (() =>
      selectAndConfigureAdapter({
        adapterArg: opts.adapterArg,
        registry,
        paths,
        deps: {
          persistCredentials: async (entry, values) => {
            // Default persistence: delegate to the registry entry.
            // Selector's deps default already does this when called via
            // `selectAndConfigureAdapter` directly, but we re-thread it
            // here so the dep is explicit at this layer too.
            await defaultPersistCredentials(entry, values, paths);
          },
        },
      }));
  const selection = await selectFn();
  if (selection.status === 'cancelled') {
    return { exitCode: 0, stderr: '' };
  }
  if (selection.status === 'error') {
    return { exitCode: selection.exitCode, stderr: selection.message };
  }
  const selectedEntry = selection.adapter;
  log(
    `  ✓ ${selectedEntry.id} credentials at ${paths.credentialFor(selectedEntry.id)}`,
  );

  // ===== 1b. Pre-flight: terminal-adapter path resolution =====
  // Branch on the user's terminal choice from §0a. wezterm path stays
  // backward-compatible (cache-in-config-then-resolve); iterm2 path
  // resolves python3 + the bundled helper script via P3 infra.
  let wezterm: string | null = null;
  let python3: string | null = null;
  let iterm2HelperPath: string | null = null;
  if (termId === 'wezterm') {
    try {
      const resolveFn = opts.resolveWezTerm ?? defaultResolveWezTerm;
      wezterm = await resolveFn(config.external_paths.wezterm);
    } catch (err) {
      return {
        exitCode: 1,
        stderr: `multi-cc-im start: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
  } else {
    // iterm2 — python3 typically already cached from P4 wizard step,
    // but the resolver gracefully re-discovers on a stale path so
    // upgrades / brew reinstalls don't break startup.
    try {
      const resolveFn = opts.resolvePython3 ?? defaultResolvePython3;
      python3 = await resolveFn(config.external_paths.python3);
    } catch (err) {
      return {
        exitCode: 1,
        stderr: `multi-cc-im start: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (config.external_paths.python3 !== python3) {
      config = {
        ...config,
        external_paths: { ...config.external_paths, python3 },
      };
      await configStore.save(config);
      log(`  ✓ python3 at ${python3} (cached to config.toml)`);
    } else {
      log(`  ✓ python3 at ${python3}`);
    }
    try {
      const helperFn = opts.resolveIterm2Helper ?? resolveIterm2HelperPath;
      iterm2HelperPath = await helperFn();
    } catch (err) {
      return {
        exitCode: 1,
        stderr: `multi-cc-im start: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    log(`  ✓ iterm2-helper.py at ${iterm2HelperPath}`);
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
  // For wezterm we can ask `wezterm cli list` directly. For iterm2 we
  // skip the ground-truth probe at startup — the iterm2 adapter's
  // `listPanes()` is the same source of truth at runtime, and the sweep
  // doesn't need to fire until the adapter is actually live.
  const sweepResult = await sweepStaleStateFiles(paths.stateDir, {
    livePaneIds:
      termId === 'wezterm' && wezterm
        ? async () => {
            const tabs = await listAllTabs({ wezterm: wezterm! });
            return [...tabs.keys()];
          }
        : undefined,
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
  // Delete BOTH per-terminal IM<TermType> tombstones on start (issue
  // 378 split). At this point we know which terminal the daemon was
  // configured for, but wiping both is cheap and removes any stale
  // file left by a previous-terminal session — defensive only.
  try {
    await deleteIMWorkFile(paths.stateDir, 'wezterm');
    await deleteIMWorkFile(paths.stateDir, 'iterm2');
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
  // `termAdapter.listPanes()` on each IM event for live tab data. Pre-flight
  // pane count is wezterm-only; iterm2 startup banner already shows the
  // helper script + python3 paths so the user has confidence the adapter
  // is wired.
  if (termId === 'wezterm' && wezterm) {
    const livePanes = await listAllTabs({ wezterm }).catch(() => null);
    if (livePanes !== null) {
      const renamed = [...livePanes.values()].filter((t) => t.title.length > 0);
      log(
        `  ✓ wezterm panes: ${livePanes.size} total, ${renamed.length} /rename'd${livePanes.size === 0 ? ' (open a wezterm tab + run cc to see panes appear)' : ''}`,
      );
    }
  }

  const imAdapter = selectedEntry.buildAdapterRuntime({ paths, log });
  const termAdapter =
    termId === 'wezterm'
      ? createWezTermAdapter({ wezterm: { path: wezterm! } })
      : createITerm2Adapter({
          python: { path: python3! },
          helperScript: { path: iterm2HelperPath! },
          // Use `fileOnlyLog` (NOT `log`): iterm2-helper fires on every
          // listSessions / sendText / sendKeystroke — high volume, low
          // signal for users. Goes into `~/.multi-cc-im/daemon.log` for
          // AI post-mortem but is silent on the daemon console.
          // Per user feedback 2026-05-14 after PR #175 smoke.
          log: fileOnlyLog,
        });
  // CLI adapter — `cli-cc` and `cli-codex` adapters share the SAME
  // state-file protocol (chokidar watcher reads `<paneId>_<sid>.<event>`
  // filenames CLI-agnostically), so the daemon only needs ONE watcher
  // regardless of how many CLIs the user enabled in wizard step 1. We
  // pick the adapter factory whose `name` field matches `enabled[0]` so
  // monitor / log lines reflect the user's primary CLI. Per
  // [DD §7 + 2026-05-23 revision](../../../docs/superpowers/specs/2026-05-22-codex-cli-adapter-dd.md).
  const cliAdapter =
    enabledCLIs[0] === 'codex'
      ? createCodexCliAdapter({ stateDir: paths.stateDir })
      : createCcCliAdapter({ stateDir: paths.stateDir });

  // Shared error ring buffer for the monitor dashboard. Orchestrator's
  // onError pushes here; monitor reads at render time. N=200 per
  // [DD 2026-05-15](../../docs/superpowers/specs/2026-05-15-cc-monitor-dashboard-dd.md) §4.
  const errorBuffer = new ErrorRingBuffer({ capacity: 200 });

  // AI router selection — wizard step 2 picks which CLI runs the
  // headless triage subprocess. `aiRouterCLI === 'codex'` → spawn
  // `codex exec --output-schema`; `'cc'` → orchestrator's built-in
  // `routeViaAI` (spawns `claude --print`).
  const aiRouter =
    aiRouterCLI === 'codex'
      ? async (o: Parameters<typeof routeViaCodex>[0]) => routeViaCodex(o)
      : undefined;
  // Human-readable label for daemon.log lines so operators can tell at
  // a glance which CLI ran each triage.
  const aiRouterName =
    aiRouterCLI === 'codex' ? 'Codex AI Agent' : 'Claude Code AI Agent';

  // ===== 3. Build + start orchestrator =====
  const orchestrator = opts.buildOrchestrator
    ? opts.buildOrchestrator()
    : createOrchestrator({
        imAdapter,
        termAdapter,
        cliAdapter,
        ...(aiRouter !== undefined ? { aiRouter } : {}),
        aiRouterName,
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
          // Mirror into the monitor ring buffer so the dashboard's
          // "recent errors" panel reflects production failures.
          errorBuffer.push(ctx.phase, msg);
        },
      });

  await orchestrator.start();
  log(`  ✓ orchestrator started — bridge running. Ctrl+C to stop.`);

  // ===== 3b. Start monitor dashboard =====
  // Local-only web dashboard for daemon health + sessions + cost.
  // Port 40719 fixed (DD 2026-05-15 D1). Failures (port collision) are
  // surfaced to the user but DO NOT abort daemon — IM bridge still
  // works, just no dashboard.
  const daemonStartedAt = new Date();
  const activeTerminalId: TerminalId = termId;
  let monitorHandle: MonitorHandle | null = null;
  try {
    monitorHandle = await startMonitor({
      port: DEFAULT_MONITOR_PORT,
      log,
      errorBuffer,
      getDaemonState: (): DaemonStateSnapshot => ({
        pid: process.pid,
        startedAt: daemonStartedAt.toISOString(),
        uptimeSeconds: Math.floor(
          (Date.now() - daemonStartedAt.getTime()) / 1000,
        ),
        activeTerminal: activeTerminalId,
        imAdapter: selectedEntry.id,
        // v1: don't probe lark WS state; just report "connected" if
        // orchestrator is up (lark's own retry loop logs to stderr).
        // Future enhancement: expose connection state via IMAdapter API.
        imConnection: 'connected',
        imLastReconnectAt: null,
        imReconnectAttempts: 0,
      }),
      getSessions: async (): Promise<SessionSnapshot[]> => {
        try {
          const panes = await termAdapter.listPanes();
          return panes.map((p) => ({
            paneId: String(p.paneId),
            title: p.title,
            cwd: p.cwd,
            hasRenamed: p.title.length > 0,
            addressable: p.title.length > 0,
          }));
        } catch {
          return [];
        }
      },
    });
  } catch (err) {
    log(
      `  ⚠️  monitor dashboard failed to start: ${formatErrorWithCause(err)}`,
    );
    log(
      `     (port ${DEFAULT_MONITOR_PORT} in use? bridge still runs without dashboard)`,
    );
  }

  // Next-step hint — IMWork starts OFF on every daemon launch (per
  // DD #8 §5.3 always-fresh lifecycle), so the user MUST send `/start`
  // from their IM session before the bridge actually routes anything.
  // The 'IMWork: OFF (run `/start` from IM to enable)' status line
  // appears mid-setup; this final line repeats the action at the
  // bottom so it's the last thing the user sees.
  log(`  ⏳ Next: send \`/start\` from your IM to enable bridge routing.`);

  return {
    exitCode: 0,
    stderr: '',
    shutdown: async () => {
      // Stop monitor BEFORE orchestrator so a slow /api/sessions call
      // doesn't race with termAdapter.stop().
      if (monitorHandle) {
        await monitorHandle.stop().catch(() => {});
      }
      await orchestrator.stop();
      // Close the diagnostic log stream cleanly so the shutdown banner
      // ends up on disk before the process exits. Tests with injected
      // opts.log never created logStream so this is a no-op for them.
      if (logStream) {
        const ts = new Date().toISOString();
        logStream.write(
          `${ts} === daemon stopped PID=${process.pid} ===\n`,
        );
        await new Promise<void>((r) => logStream!.end(r));
      }
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

/**
 * Default python3 resolver — mirrors `defaultResolveWezTerm`. Used when the
 * user's terminal adapter is iTerm2; daemon caches the resolved absolute
 * path to `~/.multi-cc-im/config.toml` `external_paths.python3` so
 * subsequent starts skip rediscovery. Per
 * [DD: iTerm2 adapter](../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md).
 *
 * P3 ships the resolver only; the call site that wires it into adapter
 * creation lands in P5 (orchestrator wiring), since `start.ts` currently
 * hardcodes `createWezTermAdapter`.
 */
export async function defaultResolvePython3(
  cachedPath?: string,
): Promise<string> {
  return resolvePython3Path(cachedPath ? { cachedPath } : {});
}

/**
 * Locate the bundled `iterm2-helper.py` script at runtime.
 *
 * tsup copies the helper from
 * `packages/term-iterm2/bin/iterm2-helper.py` next to the bundled
 * `dist/cli.js` (see `tsup.config.ts` `onSuccess`). After bundling, the
 * helper lives at `<dist>/iterm2-helper.py` regardless of where the user
 * installed `multi-cc-im` — we resolve it via `import.meta.url` so it
 * works for both bundled (`dist/cli.js`) and unbundled (`tsx
 * src/cli.ts`) execution paths.
 *
 * For the unbundled (dev) case `import.meta.url` points at
 * `apps/multi-cc-im/src/start.ts`, so we fall back to the source
 * location under `packages/term-iterm2/bin/`.
 *
 * Throws if neither location holds the file (broken install / missing
 * post-build copy).
 */
export async function resolveIterm2HelperPath(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));

  // Bundled case: dist/cli.js → sibling dist/iterm2-helper.py
  const bundled = resolvePath(here, 'iterm2-helper.py');
  if (await isReadable(bundled)) return bundled;

  // Dev (tsx) case: apps/multi-cc-im/src/start.ts →
  //   ../../../packages/term-iterm2/bin/iterm2-helper.py
  // (three levels up: src → apps/multi-cc-im → apps → repo root)
  const sourceTree = resolvePath(
    here,
    '../../../packages/term-iterm2/bin/iterm2-helper.py',
  );
  if (await isReadable(sourceTree)) return sourceTree;

  throw new Error(
    'iterm2-helper.py not found. Looked at:\n' +
      `  ${bundled} (bundled location)\n` +
      `  ${sourceTree} (dev source-tree location)\n` +
      'Run `pnpm --filter multi-cc-im build` to repopulate the bundled copy.',
  );
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default credential persistence — delegates to the registry entry's own
 * `persist` so adapter-specific Zod schemas stay encapsulated. Used by
 * the default selector when the wizard completes.
 */
async function defaultPersistCredentials(
  entry: AdapterRegistryEntry,
  values: Record<string, unknown>,
  paths: ReturnType<typeof resolveAppPaths>,
): Promise<void> {
  await entry.persist(values, paths);
}
