/**
 * Pane-id detection from the hook-receiver subprocess environment.
 *
 * cli-cc runs as a short-lived subprocess per cc hook event. Its job at
 * the entry gate is to figure out which terminal pane fired the hook —
 * without that, multi-cc-im has nothing to route. Each supported terminal
 * exposes its current pane via a different env var with a different value
 * shape:
 *
 *   - WezTerm: `WEZTERM_PANE` = numeric pane index (stable)
 *   - iTerm2:  `ITERM_SESSION_ID` = `"w<W>t<T>p<P>:UUID"` where only the
 *              UUID suffix is stable (the `w/t/p` prefix shifts when other
 *              panes close — see [DD: iTerm2 adapter §8](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#8-protocol-facts-from-upstream-research-source-cited))
 *
 * A `PaneIdDetector` reads one env var, validates its shape, and returns a
 * branded `PaneId` or `undefined` (env not set / value malformed → this
 * terminal isn't in play, try the next detector).
 *
 * The detector list is short and process-local (cli-cc owns it). We do not
 * try to push detectors into each `term-<name>` adapter package because:
 *
 *   1. cli-cc is hook-side, runs in cc's child process — separate from the
 *      daemon-side adapter instance, so adapter DI doesn't help here.
 *   2. Each detector is ~5 lines of env parsing; adapter packages adding
 *      a full DI layer for that would be pure ceremony.
 *
 * Per [DD: iTerm2 adapter §3](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#3-audit-of-current-wezterm-coupled-surface-area)
 * row 2 (the "deepest leak"): abstracting this gate is the architectural
 * unlock for any second `TermAdapter`. P1 only wires the WezTerm detector;
 * iTerm2's lands with the iTerm2 adapter in P2.
 */

import type { PaneId } from '@multi-cc-im/shared';

/**
 * Detector signature: given the subprocess `process.env`, return a branded
 * `PaneId` if this terminal's env var is present and well-formed, else
 * `undefined`. Detectors must be **pure** — no I/O, no side effects.
 */
export type PaneIdDetector = (
  env: NodeJS.ProcessEnv,
) => PaneId | undefined;

/**
 * Detect a WezTerm pane id from `WEZTERM_PANE`. Returns `undefined` when
 * the env is unset or non-numeric (corrupt env / cc running outside
 * WezTerm).
 */
export const detectWezTermPaneId: PaneIdDetector = (env) => {
  const value = env.WEZTERM_PANE;
  if (value && /^\d+$/.test(value)) {
    return Number(value) as PaneId;
  }
  return undefined;
};

/**
 * Run a list of detectors in order; return the first non-`undefined`
 * result. Order matters: list the most specific / most reliable detector
 * first. If no detector matches, returns `undefined` and the hook
 * receiver silently exits (cc running outside any supported terminal).
 */
export function runDetectors(
  detectors: readonly PaneIdDetector[],
  env: NodeJS.ProcessEnv,
): PaneId | undefined {
  for (const detect of detectors) {
    const result = detect(env);
    if (result !== undefined) return result;
  }
  return undefined;
}

/**
 * Default detector set wired into the hook receiver. P1 ships only the
 * WezTerm detector — iTerm2 detector lands in P2 of the
 * [iTerm2 adapter milestone chain](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#9-implementation-milestone-plan-to-be-detailed-after-lock).
 */
export const DEFAULT_DETECTORS: readonly PaneIdDetector[] = [
  detectWezTermPaneId,
];
