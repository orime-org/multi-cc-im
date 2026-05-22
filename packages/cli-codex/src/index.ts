/**
 * @multi-cc-im/cli-codex — OpenAI Codex CLI adapter.
 *
 * Mirror of `@multi-cc-im/cli-cc` for Claude Code, adapted for Codex CLI's
 * native lifecycle hook system (GA 2026-05). Per
 * [DD: codex CLI adapter](../../../docs/superpowers/specs/2026-05-22-codex-cli-adapter-dd.md)
 * — independent adapter (option B) rather than a refactor of cli-cc into
 * a shared base + two forks (option C, deferred until commonalities surface).
 *
 * Codex hook payloads are delivered as JSON over stdin (same model as cc)
 * but the field shapes differ — see `payloads.ts` for the codex-specific
 * zod schemas. Notable differences from cc: `tool_use_id` is non-empty
 * at PreToolUse time (cc emits empty string); PermissionRequest is its
 * own lifecycle event (cc overloads PreToolUse + AskUserQuestion); default
 * hook timeout 600s (cc 60s); config lives in `~/.codex/config.toml` (TOML)
 * or `~/.codex/hooks.json` (JSON), not `~/.claude/settings.json`.
 *
 * Implementation lands incrementally across PRs; see DD §6 task table.
 */
export {};
