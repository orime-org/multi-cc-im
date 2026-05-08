import { resolveAppPaths } from './config-paths.js';
import { sweepStaleStateFiles } from './state-sweep.js';
import { listAllTabs, resolveWezTermPath } from '@multi-cc-im/term-wezterm';

export interface RunCleanupCommandOpts {
  /** Override `~/.multi-cc-im` root (env or for tests). */
  root?: string;
  /**
   * Preview-only mode — count what would be deleted without actually
   * deleting anything. Maps to `--dry-run` on the CLI.
   */
  dryRun?: boolean;
  /**
   * Logger for progress lines. Default writes to `process.stderr`.
   */
  log?: (line: string) => void;
  /**
   * Test seam — override the wezterm path resolver. Production resolves via
   * `resolveWezTermPath()`. If both this and the resolution fail (and no
   * `livePaneIds` override is provided), cleanup refuses to run because the
   * sweep would otherwise treat all pane-keyed files as orphans and wipe
   * live cc state.
   */
  resolveWezTerm?: () => Promise<string>;
  /**
   * Test seam — directly override the live paneId source, bypassing wezterm
   * entirely. Used by unit tests to exercise sweep behavior without a real
   * wezterm install.
   */
  livePaneIds?: () => Promise<readonly number[]>;
}

export interface CleanupCommandResult {
  exitCode: number;
  stderr: string;
}

/**
 * Implement `multi-cc-im cleanup` — manual trigger for the same sweep that
 * runs at daemon startup. Per [DD: pane-keyed state files](../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
 *
 * The sweep treats wezterm cli list paneId set as the ground truth — files
 * for paneIds not in the live set are orphan (cc and tab gone). Pre-DD-#61
 * sid-keyed legacy files are also swept.
 *
 * **Safe to run while the daemon is running**: live cc's pane files are
 * never wiped (their paneId is in the wezterm live set). Live `daemon.pid`
 * is also kept — only stale (PID dead / lstart mismatch) gets cleaned.
 *
 * **Refuses to run** if wezterm path can't be resolved: without the live
 * paneId set, sweep would treat all pane-keyed files as orphans and wipe
 * live cc state. Better to error out than do that.
 */
export async function runCleanupCommand(
  opts: RunCleanupCommandOpts = {},
): Promise<CleanupCommandResult> {
  const paths = opts.root
    ? resolveAppPaths({ env: { MULTI_CC_IM_HOME: opts.root } })
    : resolveAppPaths();
  const log = opts.log ?? defaultLog;
  const dryRun = opts.dryRun ?? false;

  log(`multi-cc-im cleanup${dryRun ? ' (dry-run)' : ''}`);
  log(`  state dir: ${paths.stateDir}`);

  // Resolve the live paneId source. Tests can inject `livePaneIds` directly;
  // production resolves via wezterm. If wezterm path can't be found AND no
  // override is given, cleanup refuses to run — without the live set, sweep
  // would treat all pane-keyed files as orphans and wipe live cc state.
  let livePaneIds: () => Promise<readonly number[]>;
  if (opts.livePaneIds) {
    livePaneIds = opts.livePaneIds;
  } else {
    let wezterm: string;
    try {
      const resolveFn = opts.resolveWezTerm ?? defaultResolveWezTerm;
      wezterm = await resolveFn();
    } catch (err) {
      return {
        exitCode: 1,
        stderr:
          `multi-cc-im cleanup: cannot resolve wezterm path — ${err instanceof Error ? err.message : String(err)}\n` +
          `  Without wezterm cli list, the sweep cannot tell live cc panes from orphans. Refusing to run.`,
      };
    }
    livePaneIds = async () => {
      const tabs = await listAllTabs({ wezterm });
      return [...tabs.keys()];
    };
  }

  const result = await sweepStaleStateFiles(paths.stateDir, {
    dryRun,
    livePaneIds,
  });

  const verb = dryRun ? 'would delete' : 'deleted';
  if (
    result.orphanPaneFilesCleaned +
      result.legacyCleaned +
      result.staleDaemonPidCleaned ===
    0
  ) {
    log(`  ✓ already clean — nothing to do.`);
  } else {
    log(`  ✓ ${verb}:`);
    log(`    - ${result.orphanPaneFilesCleaned} orphan pane file(s)`);
    log(`    - ${result.legacyCleaned} legacy file(s)`);
    log(`    - ${result.staleDaemonPidCleaned} stale daemon.pid file(s)`);
  }

  if (dryRun) {
    log(`  (dry-run — no files were modified. Run without \`--dry-run\` to apply.)`);
  }

  return { exitCode: 0, stderr: '' };
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function defaultResolveWezTerm(): Promise<string> {
  return resolveWezTermPath({});
}
