// Bridge core: routes wechat IncomingMessage → cc sessions per [DD:
// routing-syntax G'](../../docs/superpowers/specs/2026-05-04-routing-syntax-dd.md).
// This package provides the pure routing logic; adapter wiring + main loop
// comes in follow-up PRs.

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
  SessionRegistry,
} from './router.js';

export { createSessionRegistry } from './session-registry.js';
export type {
  CreateSessionRegistryOpts,
  SessionRegistryAndMap,
} from './session-registry.js';

export { createPersistentRouterState } from './persistent-state.js';
export type { CreatePersistentRouterStateOpts } from './persistent-state.js';

export { createOrchestrator } from './orchestrator.js';
export type {
  BridgeOrchestrator,
  CreateOrchestratorOpts,
} from './orchestrator.js';
