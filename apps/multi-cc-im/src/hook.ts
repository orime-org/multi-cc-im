import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  parseHookPayload,
  runHookReceiver,
  type PaneOrigin,
} from '@multi-cc-im/cli-cc';
import type { PaneId } from '@multi-cc-im/shared';

export interface RunHookCommandOpts {
  /** Raw stdin payload (JSON string from cc hook protocol). */
  stdin: string;
  /** Where state files live (e.g. `~/.multi-cc-im/state/`). */
  stateDir: string;
  /**
   * Event name as passed on the CLI (`Stop` / `PreToolUse` /
   * `PermissionRequest`). Recorded verbatim in the entry trace before
   * stdin is parsed so the trace shows which command cc actually
   * invoked, independent of payload content. Falls back to
   * `<unknown>` if caller (tests) omits.
   */
  event?: string;
  /**
   * Override the hook-trace log path. Default writes to
   * `<dirname(stateDir)>/hook-trace.log` (= `~/.multi-cc-im/hook-trace.log`
   * in production). Tests pass `null` to disable the file write (keeps
   * test tmp dirs clean) or a custom path to assert format.
   *
   * Trace is a best-effort diagnostic — failures swallowed so the hook
   * never breaks cc's turn.
   *
   * Per issue 377 diagnostic 2026-05-14: needed to determine whether
   * cc actually invokes the hook for iTerm cc sessions (and what env
   * it passes) since the receiver's silent-exit branches leave no
   * disk footprint and daemon.log shows nothing.
   */
  traceLogPath?: string | null;
  /**
   * Override the pane-origin detector chain for tests / sandboxed
   * environments. Returning undefined simulates "cc not in a supported
   * terminal" — hook silently exits per
   * [DD: pane-keyed state files](../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md).
   *
   * A `PaneOrigin` carries BOTH `termId` and `paneId` so the receiver
   * can pick the right `IM<TermType>` file without inferring terminal
   * from `typeof paneId` (issue 378 root cause framing). For
   * convenience, tests may pass a function returning only `PaneId` —
   * we wrap it as `{termId: 'wezterm', paneId}` for back-compat (the
   * legacy hook only ever saw wezterm).
   */
  resolvePaneId?: () => PaneId | undefined;
  /**
   * Full origin override. Preferred when tests need iterm2 behavior
   * or to assert the receiver-internal `termId` plumbing.
   */
  resolvePaneOrigin?: () => PaneOrigin | undefined;
}

export interface HookCommandResult {
  /** Process exit code: 0 normal, 1 on parse / runtime failure. */
  exitCode: number;
  /**
   * Bytes to write to `process.stdout`. Either empty (no decision) or a
   * one-line JSON `{decision:"block",reason:"..."}` per the CLAUDE.md "key
   * rules" carve-out for controlled JSON. **Never** anything else —
   * non-protocol stdout pollutes cc's system context.
   */
  stdout: string;
  /** Bytes to write to `process.stderr` (errors / diagnostic). */
  stderr: string;
}

/**
 * Implement the `multi-cc-im hook <event>` subcommand. cc invokes this from
 * its `settings.json` `hooks` config; this entry:
 *
 * 1. Parse + zod-validate stdin payload (`@multi-cc-im/cli-cc` `parseHookPayload`)
 * 2. Run state-file side-effects via `runHookReceiver` (touch last-hook-at,
 *    write cc-pid on SessionStart, write ended on SessionEnd, append events.jsonl,
 *    pop injection queue on Stop)
 * 3. If receiver returned a `HookDecision`, JSON-stringify to stdout
 * 4. Errors → stderr + exit 1 (cc treats non-zero exit as hook failure but
 *    doesn't crash the session)
 *
 * The function is **pure-ish**: takes stdin string, returns
 * `{ exitCode, stdout, stderr }` instead of writing to process streams. CLI
 * dispatcher does the actual write — this keeps the function unit-testable
 * (no fixture dependence on `process.stdout` capture).
 */
/**
 * Best-effort append to the hook-trace log. Used both for the
 * entry-trace one-liner AND for inner-receiver gate decisions
 * (issue 377 follow-up). Failures (ENOENT parent / EACCES / disk
 * full) are swallowed — this is a diagnostic only; the hook must
 * never break cc's turn.
 */
async function appendTraceLine(
  traceLogPath: string,
  line: string,
): Promise<void> {
  try {
    const ts = new Date().toISOString();
    await appendFile(traceLogPath, `${ts} ${line}\n`, { mode: 0o600 });
  } catch {
    /* swallow — diagnostic only */
  }
}

/**
 * Heartbeat trace written BEFORE any parsing / detector / IMWork
 * gate runs. Records env state at hook-subprocess entry so we can
 * diagnose "cc invoked the hook with what env" without instrumenting
 * cc itself.
 *
 * Per issue 377 diagnostic 2026-05-14 (PR #177).
 */
async function writeHookEntryTrace(
  traceLogPath: string,
  args: { event: string; stdinBytes: number },
): Promise<void> {
  const iterm = process.env.ITERM_SESSION_ID ?? '';
  const wez = process.env.WEZTERM_PANE ?? '';
  await appendTraceLine(
    traceLogPath,
    `hook event=${args.event} pid=${process.pid} ` +
      `ITERM_SESSION_ID=${iterm} WEZTERM_PANE=${wez} stdin-bytes=${args.stdinBytes}`,
  );
}

/**
 * Hook diagnostic trace is **env-gated** by `MULTI_CC_IM_DEBUG`. When
 * the env is not set, no trace is written — keeps the steady-state
 * I/O footprint at zero (every cc turn fires 1-3 hook subprocesses;
 * even a tiny per-invocation append would accumulate). Set the env to
 * any non-empty value in the shell that launches both the daemon AND
 * the relevant cc instances:
 *
 *   export MULTI_CC_IM_DEBUG=1
 *   ./bin/multi-cc-im start
 *   # then `claude` in the relevant terminal tab
 *
 * cc subprocesses inherit shell env so the hook sees the flag; daemon
 * uses the same gate so the two sides match without a second knob.
 *
 * Per issue 377 follow-up (PR #177 + #178 introduced the trace as a
 * permanent gateable knob, not a temporary band-aid).
 */
function isHookTraceEnabled(): boolean {
  const v = process.env.MULTI_CC_IM_DEBUG;
  return v !== undefined && v.length > 0 && v !== '0';
}

export async function runHookCommand(
  opts: RunHookCommandOpts,
): Promise<HookCommandResult> {
  // Heartbeat trace BEFORE every other check so we capture invocations
  // that would silent-exit downstream (empty stdin / parse fail /
  // missing env / IMWork gate). Resolution order:
  //   1. `opts.traceLogPath === null` → tests opt out explicitly
  //   2. `opts.traceLogPath` set → tests override path
  //   3. else → file write only when `MULTI_CC_IM_DEBUG` env is set
  //     (silent in steady state; opt-in for debugging)
  const traceLogPath =
    opts.traceLogPath === null
      ? null
      : opts.traceLogPath ??
        (isHookTraceEnabled()
          ? join(dirname(opts.stateDir), 'hook-trace.log')
          : null);
  if (traceLogPath !== null) {
    await writeHookEntryTrace(traceLogPath, {
      event: opts.event ?? '<unknown>',
      stdinBytes: opts.stdin.length,
    });
  }

  if (opts.stdin.length === 0) {
    if (traceLogPath !== null) {
      await appendTraceLine(traceLogPath, `empty-stdin exit=1`);
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'multi-cc-im hook: empty stdin (cc must pipe hook payload JSON)',
    };
  }

  let payload;
  try {
    payload = parseHookPayload(opts.stdin);
  } catch (err) {
    if (traceLogPath !== null) {
      // Truncate to keep trace lines parsable; include first 200 stdin
      // chars so we can reconstruct what cc actually sent (the missing /
      // unexpected field is usually obvious from a peek).
      const msg = err instanceof Error ? err.message : String(err);
      const stdinHead = opts.stdin.slice(0, 200).replace(/\n/g, '\\n');
      await appendTraceLine(
        traceLogPath,
        `parse-fail event=${opts.event ?? '<unknown>'} err=${JSON.stringify(msg)} stdin-head=${JSON.stringify(stdinHead)}`,
      );
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr: `multi-cc-im hook: failed to parse stdin: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Compose detector overrides. Preference order:
  //   1. `resolvePaneOrigin` (full info — used by iterm2 tests / cross-
  //      terminal assertions)
  //   2. `resolvePaneId` (legacy — wraps as wezterm origin)
  // If neither set, `runHookReceiver` uses its production
  // `defaultResolvePaneOrigin` against `process.env`.
  let originOverride: (() => PaneOrigin | undefined) | undefined;
  if (opts.resolvePaneOrigin) {
    originOverride = opts.resolvePaneOrigin;
  } else if (opts.resolvePaneId) {
    const resolveId = opts.resolvePaneId;
    originOverride = () => {
      const paneId = resolveId();
      return paneId === undefined
        ? undefined
        : { termId: 'wezterm' as const, paneId };
    };
  }

  // Async-safe trace channel into runHookReceiver. We can't await
  // inside the synchronous `trace` callback that the receiver calls,
  // so we buffer messages and flush them after the receiver returns
  // (or throws). Order preserved.
  const receiverTraces: string[] = [];
  const receiverTrace =
    traceLogPath === null ? undefined : (line: string) => receiverTraces.push(line);

  let decision;
  let receiverErr: unknown = null;
  try {
    decision = await runHookReceiver({
      stateDir: opts.stateDir,
      payload,
      ...(originOverride ? { resolvePaneOrigin: originOverride } : {}),
      ...(receiverTrace ? { trace: receiverTrace } : {}),
    });
  } catch (err) {
    receiverErr = err;
  }

  // Flush receiver trace lines to disk (best-effort).
  if (traceLogPath !== null) {
    for (const line of receiverTraces) {
      await appendTraceLine(traceLogPath, line);
    }
    if (receiverErr !== null) {
      const msg =
        receiverErr instanceof Error ? receiverErr.message : String(receiverErr);
      await appendTraceLine(
        traceLogPath,
        `receiver-throw err=${JSON.stringify(msg)}`,
      );
    }
  }

  if (receiverErr !== null) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `multi-cc-im hook: receiver failed: ${
        receiverErr instanceof Error ? receiverErr.message : String(receiverErr)
      }`,
    };
  }

  if (decision) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(decision),
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: '', stderr: '' };
}
