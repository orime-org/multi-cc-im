import { spawn } from 'node:child_process';

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
 * Thin spawn wrapper for the `wezterm` CLI. **Never spawns a shell** — args
 * are passed as an array, satisfying CLAUDE.md "Forbidden list" "no shell
 * string concatenation (use execFile arrays)". Existence as a separate file
 * isolates the test seam: adapter tests mock this module rather than
 * `node:child_process`.
 *
 * Why `spawn` (not `execFile {input}`):
 *
 * `execFile` with the `input` option does not reliably half-close the child's
 * stdin on macOS — observed against `wezterm cli send-text` which then waits
 * forever for EOF. `echo "..." | wezterm cli send-text` (real pipe) works
 * because the producer's exit closes the write end. We replicate that
 * explicitly: write the payload to `child.stdin`, then call `child.stdin.end()`
 * to half-close. Verified empirically: `execFile {input}` hangs, `spawn` with
 * explicit `end()` returns immediately with the text injected into the pane.
 *
 * Errors are wrapped with code + signal + stderr context — wezterm CLI prints
 * failure reasons (e.g. `pane-id 99: not found`) to stderr.
 */
export function runWezTermCli(opts: RunWezTermCliOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(opts.wezterm, [...opts.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      settle(() =>
        reject(
          new Error(
            `wezterm cli timed out after ${timeoutMs}ms: ${[opts.wezterm, ...opts.args].join(' ')}`,
          ),
        ),
      );
    }, timeoutMs);

    child.on('error', (err) => {
      settle(() =>
        reject(new Error(`wezterm cli failed to spawn: ${err.message}`)),
      );
    });

    child.on('exit', (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const stderrTrim = stderr.trim();
        const detail = stderrTrim ? ` — ${stderrTrim}` : '';
        reject(
          new Error(
            `wezterm cli failed: code=${code} signal=${signal}${detail}`,
          ),
        );
      });
    });

    // Half-close stdin explicitly. `execFile {input}` does not reliably do
    // this on macOS for long-lived child processes that wait on EOF.
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
