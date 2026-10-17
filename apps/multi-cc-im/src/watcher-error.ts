/**
 * Build the user-facing message shown when the state-dir watcher fails and
 * the daemon has to stop.
 *
 * `EMFILE` / `ENOSPC` from a watch call mean the OS-wide file-watch budget is
 * used up by other processes: on macOS fseventsd allows 1024 clients in the
 * whole system and libuv reports a refused `FSEventStreamStart` as `EMFILE`;
 * on Linux the inotify limits report `ENOSPC` / `EMFILE`. For those codes the
 * message names the limit and gives a platform-specific check command.
 *
 * @param err - The error chokidar emitted.
 * @param stateDir - Absolute path of the watched state directory.
 * @param platform - `process.platform` value selecting the check command.
 * @returns Multi-line message, ready to print as-is.
 * @example
 * formatStateWatcherError(err, '/Users/u/.multi-cc-im/state', process.platform)
 */
export function formatStateWatcherError(
  err: unknown,
  stateDir: string,
  platform: NodeJS.Platform,
): string {
  const detail = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String(err.code)
      : undefined;
  const lines = [
    `  ✗ cannot watch the state directory ${stateDir}: ${detail}`,
    `    multi-cc-im stopped: without this watcher, cc replies and permission requests cannot reach IM.`,
  ];
  if (code === 'EMFILE' || code === 'ENOSPC') {
    lines.push(
      `    The OS file-watch limit is used up by other processes (dev servers such as \`tsx watch\` / vite, editors).`,
    );
    if (platform === 'darwin') {
      lines.push(
        `    Check: /usr/bin/log show --last 5m --predicate 'process == "fseventsd"' | grep "too many clients"`,
      );
    } else if (platform === 'linux') {
      lines.push(
        `    Check: sysctl fs.inotify.max_user_watches fs.inotify.max_user_instances`,
      );
    }
    lines.push(
      `    Fix: stop watchers you don't need (or reboot), then run \`multi-cc-im start\` again.`,
    );
  } else {
    lines.push(`    Fix the error above, then run \`multi-cc-im start\` again.`);
  }
  return lines.join('\n');
}
