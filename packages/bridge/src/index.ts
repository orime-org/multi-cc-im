// Bridge core: routes wechat IncomingMessage → cc sessions per [DD: 路由语法
// G'](../../docs/superpowers/specs/2026-05-04-routing-syntax-dd.md). This
// package provides the pure routing logic; adapter wiring + main loop comes
// in follow-up PRs.

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
  SessionRegistry,
} from './router.js';
