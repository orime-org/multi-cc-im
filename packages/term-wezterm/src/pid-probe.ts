import { execFile } from 'node:child_process';

/**
 * Test seam for OS-level process probes used by PaneAlive's multi-signal
 * state machine. Default impl uses `process.kill(pid, 0)` + `ps -o lstart=`;
 * tests inject stubs to avoid spawning real processes.
 *
 * Per [pane-alive strategy DD section g](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md):
 * - `isAlive(pid)`: POSIX `kill(pid, 0)` returns true iff signal 0 reaches
 *   process pid (validates pid existence without sending a signal). Throws on
 *   ESRCH (no such process) or EPERM (process exists but not ours) — we treat
 *   the latter as "alive" because PID is real (just not signal-able).
 * - `getLstart(pid)`: `ps -o lstart= -p <pid>` outputs the process start time
 *   stamp (e.g. `Tue May  4 16:38:00 2026`); cross-platform on macOS / Linux.
 *   Used to detect PID reuse — comparing string-equality with the value
 *   captured at SessionStart.
 */
export interface PidProbe {
  isAlive(pid: number): boolean;
  /** Throws if pid does not exist; returns trimmed lstart string otherwise. */
  getLstart(pid: number): Promise<string>;
}

const PS_TIMEOUT_MS = 5_000;

/** Default PidProbe — uses POSIX kill(0) + `ps -o lstart=`. */
export const defaultPidProbe: PidProbe = {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false; // No such process
      if (code === 'EPERM') return true; // Process exists but signal not permitted
      // EINVAL / unexpected — surface as dead conservatively
      return false;
    }
  },

  getLstart(pid: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        { timeout: PS_TIMEOUT_MS },
        (err, stdout) => {
          if (err) {
            reject(
              new Error(
                `ps -o lstart= -p ${pid} failed: ${err.message}`,
              ),
            );
            return;
          }
          const trimmed = stdout.trim();
          if (!trimmed) {
            reject(new Error(`ps returned empty lstart for pid ${pid}`));
            return;
          }
          resolve(trimmed);
        },
      );
    });
  },
};
