// Hook payload runtime validation (zod) — pairs with type-only declarations
// in @multi-cc-im/shared/adapter/cli.ts. cli-cc package owns runtime schemas
// because the cc hook stdin is external input requiring zod-validated entry.
export {
  HookPayloadSchema,
  SessionEndPayloadSchema,
  SessionStartPayloadSchema,
  StopPayloadSchema,
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
export type { HookDecision, RunHookReceiverOpts } from './hook-receiver.js';

// Append-only event log (writer in receiver, reader in adapter).
export {
  appendEvent,
  resolveEventsLogPath,
  tailNewEvents,
} from './events-log.js';
export type {
  AppendEventOpts,
  EventsLogPath,
  TailNewEventsOpts,
  TailNewEventsResult,
} from './events-log.js';

// Stop-hook injection queue (bridge enqueues; receiver pops).
export {
  enqueueInjection,
  popInjection,
  resolveInjectionQueuePath,
} from './injection-queue.js';
export type {
  EnqueueInjectionOpts,
  InjectionQueuePath,
} from './injection-queue.js';

// File-watching CLIAdapter for bridge core.
export { createCcCliAdapter } from './adapter.js';
export type { CreateCcCliAdapterOpts } from './adapter.js';
