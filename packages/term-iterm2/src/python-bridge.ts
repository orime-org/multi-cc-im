import { spawn } from 'node:child_process';

/**
 * RPC contract with `bin/iterm2-helper.py`. Each call spawns a fresh
 * Python subprocess (mirrors cli-cc's ephemeral-subprocess model), writes
 * one JSON request to stdin, reads one JSON response from stdout,
 * exits. No persistent connection state.
 *
 * Action shapes (kept in lockstep with iterm2-helper.py):
 *   {action: 'listSessions'}
 *     → result: ReadonlyArray<{paneId: string, title: string, cwd: string}>
 *   {action: 'sendText',      sessionId: string, text: string}
 *     → result: {sent: number}
 *   {action: 'sendKeystroke', sessionId: string, key: string}
 *     → result: {sent: number}
 */
export type IterM2HelperRequest =
  | { action: 'listSessions' }
  | { action: 'sendText'; sessionId: string; text: string }
  | { action: 'sendKeystroke'; sessionId: string; key: string };

export interface IterM2RawSession {
  paneId: string;
  title: string;
  cwd: string;
}

/**
 * One successful invocation's payload, action-dependent. Callers narrow
 * based on the request action they sent.
 */
export type IterM2HelperResult =
  | ReadonlyArray<IterM2RawSession>
  | { sent: number };

export interface IterM2HelperFailure {
  ok: false;
  error: string;
}

export interface IterM2HelperSuccess<T extends IterM2HelperResult> {
  ok: true;
  result: T;
}

export interface RunIterM2HelperOpts {
  /** Absolute path to `python3` binary (from `resolvePython3Path`). */
  python: { path: string };
  /** Absolute path to `iterm2-helper.py`. */
  helperScript: { path: string };
  /** Request payload to write on the subprocess's stdin. */
  request: IterM2HelperRequest;
  /**
   * Subprocess timeout (ms). On expiry the subprocess is killed and a
   * timeout error is raised. Default 8 seconds — long enough to cover
   * cold WebSocket open + first action + Automation permission prompt
   * (one-time on first run); too tight invites flake on a slow runner.
   */
  timeoutMs?: number;
  /**
   * Optional diagnostic log sink. When provided, every invocation prints
   * a single line before the subprocess spawns
   * (`[iterm2-helper] action=<X> ...`) and another line on result
   * (`[iterm2-helper] action=<X> ok` / `[iterm2-helper] action=<X> error: <msg>`).
   * Default: silent — production wires this from `start.ts` so daemon
   * stderr surfaces helper invocations alongside its other lifecycle
   * logs; tests pass nothing.
   */
  log?: (line: string) => void;
}

/**
 * Format a one-line action signature for logging. UUIDs are truncated
 * to keep the log readable; text payloads are length-summarized rather
 * than dumped verbatim (avoids spilling sensitive content to terminal
 * logs).
 */
function summarizeRequest(req: IterM2HelperRequest): string {
  switch (req.action) {
    case 'listSessions':
      return 'action=listSessions';
    case 'sendText':
      return `action=sendText sessionId=${req.sessionId.slice(0, 8)}… textLen=${req.text.length}`;
    case 'sendKeystroke':
      return `action=sendKeystroke sessionId=${req.sessionId.slice(0, 8)}… key=${JSON.stringify(req.key)}`;
  }
}

/**
 * Spawn `python3 <helperScript>`, deliver the JSON request on stdin,
 * collect stdout, parse, return the response. Throws on any failure
 * (non-zero exit / unparseable stdout / `ok:false`).
 *
 * Per CLAUDE.md memory `feedback_execfile_input_footgun`: we use
 * `spawn` + explicit `child.stdin.end()` rather than `execFile({input})`
 * because the latter doesn't reliably close stdin on macOS, hanging
 * child processes that block on stdin EOF.
 */
export async function runIterM2Helper(
  opts: RunIterM2HelperOpts,
): Promise<IterM2HelperResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const log = opts.log;
  const sig = summarizeRequest(opts.request);
  log?.(`[iterm2-helper] ${sig} (timeout=${timeoutMs}ms)`);

  return new Promise<IterM2HelperResult>((resolve, reject) => {
    const child = spawn(opts.python.path, [opts.helperScript.path], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    // Live-stream stderr line-by-line to `log` so the helper's
    // `[helper HH:MM:SS] start action=... / iterm2 module imported /
    // WebSocket opened ...` progress lands in daemon.log in real time.
    // Without this the user only sees stderr aggregated AFTER the
    // helper exits (and only on failure), which loses the timeline of
    // where the connection got stuck. Per P7 follow-up 2026-05-14.
    let stderrCarry = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (!log) return;
      stderrCarry += chunk.toString('utf8');
      const lines = stderrCarry.split('\n');
      stderrCarry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) log(line);
      }
    });

    child.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(
        new Error(`iterm2-helper spawn failed: ${err.message}`, { cause: err }),
      );
    });

    // Swallow stdin EPIPE / ECONNRESET. The subprocess is free to ignore
    // stdin entirely (test stubs do this when they just echo a canned
    // response; the real iterm2-helper.py reads stdin before doing
    // anything, so this branch is dead code in production). What matters
    // is the 'close' handler, which decides success/failure based on
    // exit code + stdout. Without this listener, an unhandled error
    // event on stdin crashes the process on Linux CI where bash exits
    // faster than Node can flush the write — see 2026-05-13 PR #163 CI.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
        clearTimeout(timer);
        reject(err);
      }
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (timedOut) {
        log?.(`[iterm2-helper] ${sig} timeout after ${timeoutMs}ms`);
        reject(
          new Error(
            `iterm2-helper timed out after ${timeoutMs}ms ` +
              `(signal=${signal}, stderr=${stderr.trim() || '<empty>'})`,
          ),
        );
        return;
      }

      if (code !== 0) {
        log?.(`[iterm2-helper] ${sig} exit=${code} stderr=${stderr.trim() || '<empty>'}`);
        // helper script may have emitted a JSON {ok:false,error:"..."} on stdout
        // before exiting 1; surface that error string verbatim if present.
        const parsed = tryParseHelperFailure(stdout);
        if (parsed) {
          reject(new Error(`iterm2-helper: ${parsed.error}`));
          return;
        }
        reject(
          new Error(
            `iterm2-helper exited ${code} (signal=${signal}), ` +
              `stderr=${stderr.trim() || '<empty>'}`,
          ),
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        reject(
          new Error(
            `iterm2-helper stdout not valid JSON: ${(err as Error).message}\n` +
              `stdout: ${stdout}`,
          ),
        );
        return;
      }

      if (!isHelperResponse(parsed)) {
        reject(new Error(`iterm2-helper response has wrong shape: ${stdout}`));
        return;
      }

      if (!parsed.ok) {
        reject(new Error(`iterm2-helper: ${parsed.error}`));
        return;
      }

      resolve(parsed.result);
    });

    // Per CLAUDE.md memory feedback_execfile_input_footgun: explicit end().
    child.stdin.write(JSON.stringify(opts.request));
    child.stdin.end();
  });
}

function tryParseHelperFailure(stdout: string): IterM2HelperFailure | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'ok' in parsed &&
      (parsed as { ok: unknown }).ok === false &&
      'error' in parsed &&
      typeof (parsed as { error: unknown }).error === 'string'
    ) {
      return parsed as IterM2HelperFailure;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function isHelperResponse(
  v: unknown,
): v is IterM2HelperSuccess<IterM2HelperResult> | IterM2HelperFailure {
  if (v === null || typeof v !== 'object') return false;
  const o = v as { ok?: unknown; result?: unknown; error?: unknown };
  if (o.ok === true) return true; // result type validated by callers
  if (o.ok === false && typeof o.error === 'string') return true;
  return false;
}
