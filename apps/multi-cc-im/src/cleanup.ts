import { resolveAppPaths } from './config-paths.js';
import { sweepStaleStateFiles } from './state-sweep.js';

export interface RunCleanupCommandOpts {
  /** Override `~/.multi-cc-im` root (env or for tests). */
  root?: string;
  /**
   * Preview-only mode — count what would be deleted without actually
   * deleting anything. Maps to `--dry-run` on the CLI.
   */
  dryRun?: boolean;
  /**
   * Logger for progress lines. Default writes to `process.stderr` (consistent
   * with `setup-hooks` / `start` banner). Tests inject a spy.
   */
  log?: (line: string) => void;
}

export interface CleanupCommandResult {
  exitCode: number;
  stderr: string;
}

/**
 * Implement `multi-cc-im cleanup` — manual trigger for the same sweep that
 * runs at daemon startup. Use cases:
 *
 * - daemon has been running for weeks, lots of cc sessions came + went;
 *   `~/.multi-cc-im/state/` accumulated paired SessionStart+SessionEnd
 *   files from completed sessions (the daemon reads SessionEnd to mark a
 *   session dead but does NOT auto-cleanup the file, since a future
 *   `claude --resume` of the same sid is supposed to clean its own).
 * - want to preview what would be cleaned (`--dry-run`) before actually
 *   running.
 *
 * The sweep deletes:
 * - paired `<sid>.SessionStart` + `<sid>.SessionEnd` (cc died)
 * - orphan `<sid>.Stop.<ts>` files (daemon-down accumulation that can't
 *   be forwarded — the in-memory wechat replyCtx is gone)
 * - legacy state files from pre-redesign installs (`<sid>.cc-pid`,
 *   `<sid>.events.jsonl`, `<sid>.ended`, `<sid>.last-hook-at`,
 *   `current-session`)
 *
 * **Safe to run while the daemon is running**: deletions are limited to
 * `<sid>.SessionStart` for sids that ALSO have a `<sid>.SessionEnd` (= cc
 * already dead, daemon already noticed). Live cc's `<sid>.SessionStart`
 * files are NEVER touched.
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

  const result = await sweepStaleStateFiles(paths.stateDir, { dryRun });

  const verb = dryRun ? 'would delete' : 'deleted';
  if (
    result.pairedCleaned +
      result.orphanStopsCleaned +
      result.legacyCleaned +
      result.orphanPermissionCleaned +
      result.orphanIMOriginCleaned +
      result.staleDaemonPidCleaned ===
    0
  ) {
    log(`  ✓ already clean — nothing to do.`);
  } else {
    log(`  ✓ ${verb}:`);
    log(`    - ${result.pairedCleaned} completed cc session(s)`);
    log(`    - ${result.orphanStopsCleaned} orphan Stop file(s)`);
    log(`    - ${result.legacyCleaned} legacy file(s)`);
    log(`    - ${result.orphanPermissionCleaned} orphan Permission file(s)`);
    log(`    - ${result.orphanIMOriginCleaned} orphan IMOrigin file(s)`);
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
