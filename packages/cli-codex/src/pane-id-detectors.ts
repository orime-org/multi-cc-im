/**
 * Codex inherits the parent terminal's env when spawning hook
 * subprocesses (verified against
 * `codex-rs/hooks/src/engine/command_runner.rs` — only
 * `handler.env` is added to the env block; the parent env block is
 * inherited by default). That means `WEZTERM_PANE` /
 * `ITERM_SESSION_ID` (set by the user's wezterm / iTerm tab when
 * codex was launched) flow through to our hook receiver untouched,
 * so the cli-cc detector chain works verbatim for codex.
 *
 * Rather than duplicating the detectors module here, we re-export
 * cli-cc's. If a future codex version introduces its own pane env
 * convention we'll add a codex-specific detector here (run-before
 * the cli-cc chain via `runDetectors([...codexDetectors,
 * ...DEFAULT_DETECTORS], env)`).
 */
export {
  DEFAULT_DETECTORS,
  detectIterm2PaneId,
  detectWezTermPaneId,
  runDetectors,
} from '@multi-cc-im/cli-cc';
export type {
  PaneIdDetector,
  PaneOrigin,
  TaggedDetector,
} from '@multi-cc-im/cli-cc';
