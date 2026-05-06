import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface RunWezTermCliOpts {
  /** Pre-resolved absolute path to the wezterm binary (see `path-resolver.ts`). */
  wezterm: string;
  /** CLI argv (e.g. `['cli', 'list', '--format', 'json']`). */
  args: readonly string[];
  /** Optional stdin payload (for `send-text` paste content). */
  stdin?: string;
  /** Hard timeout (ms) — default 10s. */
  timeoutMs?: number;
}

/**
 * Thin `execFile` wrapper for the `wezterm` CLI. **Never spawns a shell** —
 * args are passed as an array, satisfying CLAUDE.md "Forbidden list" "no
 * shell string concatenation (use execFile arrays)". Existence as a separate
 * file isolates the test seam: adapter tests mock this module rather than
 * `node:child_process`.
 *
 * Errors are wrapped with stderr context — wezterm CLI prints failure reasons
 * (e.g. `pane-id 99: not found`) to stderr.
 */
export function runWezTermCli(opts: RunWezTermCliOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      opts.wezterm,
      [...opts.args],
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(opts.stdin !== undefined ? { input: opts.stdin } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          const stderrTrim = (stderr ?? '').trim();
          const detail = stderrTrim ? ` — ${stderrTrim}` : '';
          reject(new Error(`wezterm cli failed: ${err.message}${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
