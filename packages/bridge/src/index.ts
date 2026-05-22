// Bridge core: routes IM IncomingMessage → cc sessions in wezterm panes.
// Per [DD: pane-keyed state files](../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
// daemon doesn't track sessionId; routing key is wezterm tab title (cc /rename),
// state file naming uses paneId.

export { parse } from './parser.js';
export type { ParsedMessage } from './parser.js';

export { matchSession } from './matcher.js';
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

export {
  routeViaAI,
  renderRoutingPrompt,
  buildClaudeArgs,
  parseRoutingOutput,
} from './ai-router.js';
export type { AIRoutingOpts, AIRoutingResult } from './ai-router.js';

// Codex-flavored AI router (`codex exec --output-schema`) — used when
// daemon starts with `--cli=codex` per DD §7.1.
export { routeViaCodex } from './ai-router-codex.js';
export type { CodexRoutingOpts } from './ai-router-codex.js';
