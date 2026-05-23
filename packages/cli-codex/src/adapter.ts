import {
  createCcCliAdapter,
  type CreateCcCliAdapterOpts,
} from '@multi-cc-im/cli-cc';
import type { CLIAdapter } from '@multi-cc-im/shared';

export interface CreateCodexCliAdapterOpts extends CreateCcCliAdapterOpts {}

/**
 * Daemon-side CLI adapter for codex. The daemon watches the shared
 * `stateDir` for hook-fired state files (Stop / PermissionRequest /
 * PermissionDialogRequest) keyed by `<paneId>_<sid>.<event>` filenames.
 * Codex's `hook-receiver.ts` writes those filenames using cli-cc's
 * `writeStopFile` / `writePermissionRequestFile` /
 * `writePermissionDialogRequestFile` writers (same prefix constants,
 * same atomicWrite mode 0600, same payload schema), so the daemon
 * side is **CLI-agnostic** at this layer.
 *
 * Concretely: cli-codex's `createCodexCliAdapter` is currently a thin
 * re-export of cli-cc's `createCcCliAdapter` with the `name` field
 * rewritten to `'codex'`. The chokidar watcher inside doesn't care
 * which CLI fired the event — only that the file name matches one of
 * the three classified shapes (parsed by `parseStopFilename` /
 * `parsePermissionFilename` / `parsePermissionDialogFilename`).
 *
 * **Why thin re-export instead of refactor cli-cc into a shared base
 * + two forks?** Per DD §1 candidate C is deferred: refactoring
 * cli-cc (which is already production with 1100+ tests) carries
 * regression risk; cleaner to land cli-codex as a thin wrapper
 * (option B in the DD) and only refactor to a shared base if a
 * third CLI adapter exposes the same shape.
 *
 * **What this re-export does NOT preclude**: future codex-specific
 * dispatch logic (e.g. surfacing `agent_id` / `agent_type` from
 * codex Stop events into IM threading, or per-event PostToolUse
 * handlers) can be added here as wrapped adapter handlers that fire
 * BEFORE the cli-cc handlers run. For v0.2.0 first cut we have no
 * such codex-only logic identified.
 */
export function createCodexCliAdapter(
  opts: CreateCodexCliAdapterOpts,
): CLIAdapter {
  const base = createCcCliAdapter(opts);
  return {
    ...base,
    name: 'codex',
  };
}
