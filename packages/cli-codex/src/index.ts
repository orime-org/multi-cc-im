/**
 * @multi-cc-im/cli-codex — OpenAI Codex CLI adapter.
 *
 * Mirror of `@multi-cc-im/cli-cc` for Claude Code, adapted for Codex
 * CLI's native lifecycle hook system (GA 2026-05). Per
 * [DD: codex CLI adapter](../../../docs/superpowers/specs/2026-05-22-codex-cli-adapter-dd.md)
 * — independent adapter (option B in the DD) rather than refactoring
 * cli-cc into a shared base + two forks (option C, deferred).
 *
 * Codex hook payloads are delivered as JSON over stdin (same model
 * as cc) but the field shapes differ — see `payloads.ts` for the
 * codex-specific zod schemas. Notable differences from cc:
 * `tool_use_id` is non-empty at PreToolUse time (cc emits empty
 * string); `PermissionRequest` is its own lifecycle event (cc
 * overloads PreToolUse + AskUserQuestion); default hook timeout
 * 600s (cc 60s); config lives in `~/.codex/config.toml` (TOML) or
 * `~/.codex/hooks.json` (JSON), not `~/.claude/settings.json`.
 *
 * Daemon-side dispatch (state-file watcher + handler routing) is
 * CLI-agnostic and lives in cli-cc; cli-codex's `createCodexCliAdapter`
 * is a thin re-export wrapper that swaps the `name` field to `'codex'`.
 */

// Hook payload zod schemas (codex stdin JSON validation).
export {
  HookPayloadSchema,
  SessionStartPayloadSchema,
  PreToolUsePayloadSchema,
  PermissionRequestPayloadSchema,
  StopPayloadSchema,
  parseHookPayload,
} from './payloads.js';
export type {
  ParsedHookPayload,
  SessionStartPayload,
  PreToolUsePayload,
  PermissionRequestPayload,
  StopPayload,
} from './payloads.js';

// Hook receiver — invoked by `multi-cc-im hook-receiver-codex` CLI
// subcommand registered in `~/.codex/config.toml` by `setup-hooks.ts`.
export { runHookReceiver, runFromStdin } from './hook-receiver.js';
export type {
  RunHookReceiverOpts,
  HookReceiverOutput,
  StopBlockOutput,
  PreToolUseHookOutput,
  PermissionRequestHookOutput,
} from './hook-receiver.js';

// One-shot installer that registers multi-cc-im hooks into
// `~/.codex/config.toml`. Backs up existing config + idempotent
// rerun safe + smol-toml round-trip preserves non-hooks tables.
export {
  runCodexSetupHooks,
  defaultCodexConfigPath,
  pruneExistingHooks,
  buildMultiCcImHookGroups,
  WARN_CODEX_RESTART_LINE,
} from './setup-hooks.js';
export type {
  RunCodexSetupHooksOpts,
  CodexSetupHooksResult,
  CodexHookEntry,
  CodexHookGroup,
  CodexHooksMap,
} from './setup-hooks.js';

// Daemon-side CLIAdapter — thin re-export wrapper over cli-cc's
// adapter with the `name` field rewritten to `'codex'`. State file
// classification + chokidar watch logic is shared with cli-cc
// because the filename protocol is CLI-agnostic.
export { createCodexCliAdapter } from './adapter.js';
export type { CreateCodexCliAdapterOpts } from './adapter.js';

// Pane-origin detector chain — re-export from cli-cc; codex inherits
// parent terminal env so the detectors work verbatim.
export {
  DEFAULT_DETECTORS,
  detectIterm2PaneId,
  detectWezTermPaneId,
  runDetectors,
} from './pane-id-detectors.js';
export type {
  PaneIdDetector,
  PaneOrigin,
  TaggedDetector,
} from './pane-id-detectors.js';
