/**
 * Low-level terminal environment detectors shared with cli-cc.
 * These values identify the process environment, which may belong to a shared
 * Codex App Server. Native hook dispatch uses official thread-title identity
 * instead; these detectors cannot establish a native thread-to-pane origin.
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
