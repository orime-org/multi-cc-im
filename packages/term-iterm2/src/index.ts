// Barrel export for the iTerm2 term adapter.
// Per [DD: iTerm2 adapter](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md):
// daemon orchestrator depends only on the abstract `TermAdapter` /
// `TermListPanes` interfaces from `@multi-cc-im/shared`; it picks an
// implementation at startup based on user's `start <terminal>` choice.

export { createITerm2Adapter } from './adapter.js';
export type { CreateITerm2AdapterOpts } from './adapter.js';

export { resolvePython3Path } from './path-resolver.js';
export type { ResolvePython3PathOpts } from './path-resolver.js';

export { cleanTitle, cleanCwd } from './tab-title.js';
