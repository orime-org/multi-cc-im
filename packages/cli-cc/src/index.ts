// Hook payload runtime validation (zod) — pairs with type-only declarations
// in @multi-cc-im/shared/adapter/cli.ts. cli-cc package owns runtime schemas
// because the cc hook stdin is external input requiring zod-validated entry.
export {
  HookPayloadSchema,
  PostToolUseToolResponseSchema,
  PostToolUsePayloadSchema,
  PreToolUsePayloadSchema,
  SessionEndPayloadSchema,
  SessionStartPayloadSchema,
  StopPayloadSchema,
  UserPromptSubmitPayloadSchema,
  parseHookPayload,
} from './payloads.js';
export type { ParsedHookPayload } from './payloads.js';

// State-file IO for cc session lifecycle (cc-pid / ended / last-hook-at).
// PaneAlive multi-signal (term-wezterm, future PR) consumes these.
export {
  readCcPid,
  readEnded,
  readLastHookAt,
  touchLastHookAt,
  writeCcPid,
  writeEnded,
} from './state-files.js';
export type {
  CcPidEntry,
  CcPidIO,
  EndedEntry,
  EndedIO,
  LastHookIO,
} from './state-files.js';

// Hook receiver entry point — invoked by `multi-cc-im hook <event>` CLI
// subcommand (future CLI package).
export { runHookReceiver } from './hook-receiver.js';
export type { RunHookReceiverOpts } from './hook-receiver.js';
