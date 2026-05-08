// Bridge core: routes IM IncomingMessage → cc sessions in wezterm panes.
// Per [DD: pane-keyed state files](../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
// daemon doesn't track sessionId; routing key is wezterm tab title (cc /rename),
// state file naming uses paneId.

export { parse } from './parser.js';
export type { ParsedMessage } from './parser.js';

export { matchSession, RESERVED_BRIDGE_NAME } from './matcher.js';
export type { MatchResult, SessionInfo } from './matcher.js';

export { route } from './router.js';
export type {
  RouterDispatch,
  RouterOpts,
  RouterResult,
  RouterState,
  PaneRegistry,
} from './router.js';

export { createOrchestrator } from './orchestrator.js';
export type {
  BridgeOrchestrator,
  CreateOrchestratorOpts,
} from './orchestrator.js';
