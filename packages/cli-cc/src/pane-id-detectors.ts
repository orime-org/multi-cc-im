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

import type { PaneId, TerminalId } from '@multi-cc-im/shared';

/**
 * Detector signature: given the subprocess `process.env`, return a branded
 * `PaneId` if this terminal's env var is present and well-formed, else
 * `undefined`. Detectors must be **pure** — no I/O, no side effects.
 */
export type PaneIdDetector = (
  env: NodeJS.ProcessEnv,
) => PaneId | undefined;

/**
 * Source-of-truth pair: which terminal a hook subprocess detected itself
 * in (`termId`), and the pane id within that terminal (`paneId`). Carried
 * end-to-end from hook entry through state files into daemon-side gates
 * so we never have to "infer" the terminal from `typeof paneId` (which
 * would be brittle for any future detector that uses a numeric or UUID
 * id format — kitty/alacritty/etc.).
 */
export interface PaneOrigin {
  termId: TerminalId;
  paneId: PaneId;
}

/**
 * A detector paired with the terminal id it represents. Used inside
 * `DEFAULT_DETECTORS` so `runDetectors` can return both pieces of info
 * (which terminal matched + the pane id within it) from a single pass.
 */
export interface TaggedDetector {
  termId: TerminalId;
  detect: PaneIdDetector;
}

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
 * iTerm2 `ITERM_SESSION_ID` format. Per
 * [DD: iTerm2 adapter §8](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#8-protocol-facts-from-upstream-research-source-cited):
 * iTerm2 auto-exports this env in every child shell as
 * `"w<W>t<T>p<P>:<UUID>"`. The `w/t/p` prefix is position-based and
 * shifts when other panes close; only the UUID suffix is stable.
 *
 * The detector accepts either:
 *   - full `w0t1p0:UUID` form (live iTerm2 shells), or
 *   - bare UUID (if a user already stripped it manually — defensive
 *     branch that costs nothing to keep)
 *
 * UUID is a standard hyphen-separated 36-char hex string. We don't
 * loosen the regex further: anything else is rejected as "not iTerm2"
 * and falls through to the next detector / silent-exit.
 */
const ITERM2_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const detectIterm2PaneId: PaneIdDetector = (env) => {
  const value = env.ITERM_SESSION_ID;
  if (!value) return undefined;

  // Strip the unstable `w<W>t<T>p<P>:` prefix if present.
  const colonIdx = value.indexOf(':');
  const uuid = colonIdx >= 0 ? value.slice(colonIdx + 1) : value;

  if (!ITERM2_UUID_RE.test(uuid)) return undefined;
  return uuid as unknown as PaneId;
};

/**
 * Run a list of tagged detectors in order; return the first match as a
 * `PaneOrigin` carrying BOTH `termId` (which terminal matched) and
 * `paneId` (the id within it). Order matters: list the most specific /
 * most reliable detector first. If no detector matches, returns
 * `undefined` and the hook receiver silently exits (cc running outside
 * any supported terminal).
 *
 * Returning `termId` alongside `paneId` is load-bearing: downstream
 * gates (`IM<TermType>` lookup, per-terminal IM-mode files) need the
 * fact of "which terminal" without re-deriving it from `paneId` shape,
 * which would be brittle for any future detector whose id format
 * collides with an existing one. Per issue 378 root-cause framing.
 */
export function runDetectors(
  detectors: readonly TaggedDetector[],
  env: NodeJS.ProcessEnv,
): PaneOrigin | undefined {
  for (const d of detectors) {
    const paneId = d.detect(env);
    if (paneId !== undefined) return { termId: d.termId, paneId };
  }
  return undefined;
}

/**
 * Default detector set wired into the hook receiver. Order is
 * **wezterm before iterm2**: a hook subprocess could in principle
 * inherit both env vars (e.g. user opens iTerm2 inside a wezterm
 * session, or vice versa), and the wezterm pane id is more reliable
 * (stable numeric vs UUID position-prefix) so it wins ties. In
 * practice the two terminals never co-export their env, so the order
 * is a defensive tiebreaker rather than load-bearing.
 *
 * Per the [iTerm2 adapter DD milestone chain](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#9-implementation-milestone-plan-to-be-detailed-after-lock):
 * P1 wired the WezTerm detector only; P2 appended iTerm2; issue 378
 * fix wraps each as a `TaggedDetector` so `runDetectors` can surface
 * the matched `termId` to callers.
 */
export const DEFAULT_DETECTORS: readonly TaggedDetector[] = [
  { termId: 'wezterm', detect: detectWezTermPaneId },
  { termId: 'iterm2', detect: detectIterm2PaneId },
];
