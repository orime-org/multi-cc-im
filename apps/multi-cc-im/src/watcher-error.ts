/**
 * Build the user-facing message shown when the state-dir watcher fails and
 * the daemon has to stop.
 *
 * `EMFILE` can indicate exhausted file descriptors or file-watch resources;
 * it does not identify which process consumed them. macOS can report it when
 * FSEvents refuses a client; Linux inotify also has watch and instance limits.
 * The message gives platform-specific checks before suggesting recovery.
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
    `    multi-cc-im does not stop your Claude Code / Codex sessions or other development processes.`,
  ];
  if (code === 'EMFILE' || code === 'ENOSPC') {
    lines.push(
      code === 'EMFILE'
        ? `    The OS could not allocate file descriptors or file-watch resources. EMFILE alone does not identify the exhausted limit or the process responsible.`
        : `    The OS file-watch limit has been reached. Check the limit and current usage before changing it.`,
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
    if (code === 'EMFILE') {
      lines.push(`    Check open-file limits: ulimit -n (the daemon's effective limit can differ from this shell).`);
    }
    lines.push(
      `    Fix: review watcher/open-file usage (for example \`tsx watch\`, vite, or editors). Close only processes you no longer need, or adjust the confirmed configurable limit, then run \`multi-cc-im start\` again.`,
    );
  } else {
    lines.push(`    Fix the error above, then run \`multi-cc-im start\` again.`);
  }
  return lines.join('\n');
}
