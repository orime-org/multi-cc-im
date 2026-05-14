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
export async function runHookCommand(
  opts: RunHookCommandOpts,
): Promise<HookCommandResult> {
  if (opts.stdin.length === 0) {
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

  let decision;
  try {
    decision = await runHookReceiver({
      stateDir: opts.stateDir,
      payload,
      ...(originOverride ? { resolvePaneOrigin: originOverride } : {}),
    });
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `multi-cc-im hook: receiver failed: ${
        err instanceof Error ? err.message : String(err)
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
