// Hook payload runtime validation (zod) — pairs with type-only declarations
// in @multi-cc-im/shared/adapter/cli.ts. cli-cc package owns runtime schemas
// because the cc hook stdin is external input requiring zod-validated entry.
export {
  HookPayloadSchema,
  PreToolUsePayloadSchema,
  SessionEndPayloadSchema,
  SessionStartPayloadSchema,
  StopPayloadSchema,
  parseHookPayload,
} from './payloads.js';
export type { ParsedHookPayload } from './payloads.js';

// State-file IO for cc session lifecycle.
// Per-event-type files: <sid>.SessionStart / <sid>.Stop.<ts> / <sid>.SessionEnd
// Daemon's chokidar adapter watches the directory for these patterns.
// PaneAlive (term-wezterm) reads SessionStart/SessionEnd for liveness.
export {
  SESSION_START_SUFFIX,
  SESSION_END_SUFFIX,
  STOP_PREFIX,
  PERMISSION_REQUEST_PREFIX,
  PERMISSION_RESPONSE_PREFIX,
  formatStopTimestamp,
  sessionStartPath,
  sessionEndPath,
  stopFilePath,
  permissionRequestPath,
  permissionResponsePath,
  writeSessionStartFile,
  readSessionStartFile,
  deleteSessionStartFile,
  writeSessionEndFile,
  existsSessionEndFile,
  deleteSessionEndFile,
  writeStopFile,
  readStopFile,
  deleteStopFile,
  listStopFiles,
  writePermissionRequestFile,
  readPermissionRequestFile,
  deletePermissionRequestFile,
  writePermissionResponseFile,
  readPermissionResponseFile,
  deletePermissionResponseFile,
  listPermissionRequestFiles,
  listPermissionResponseFiles,
} from './state-files.js';
export type {
  PerSessionIO,
  SessionStartFile,
  StopFile,
  PermissionRequestFile,
  PermissionResponseFile,
} from './state-files.js';

// Hook receiver entry point — invoked by `multi-cc-im hook <event>` CLI
// subcommand (future CLI package).
export { runHookReceiver } from './hook-receiver.js';
export type { HookDecision, RunHookReceiverOpts } from './hook-receiver.js';

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
