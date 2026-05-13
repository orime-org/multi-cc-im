// Hook payload runtime validation (zod) — pairs with type-only declarations
// in @multi-cc-im/shared/adapter/cli.ts. cli-cc package owns runtime schemas
// because the cc hook stdin is external input requiring zod-validated entry.
export {
  HookPayloadSchema,
  PreToolUsePayloadSchema,
  StopPayloadSchema,
  parseHookPayload,
} from './payloads.js';
export type { ParsedHookPayload } from './payloads.js';

// State-file IO for cc session lifecycle. Per
// [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
// hook subprocess writes <paneId>_<sid>.<event> (the file format itself is
// the proof "this came from cc fired in wezterm"). Per
// [DD: IMOrigin global](../../../docs/superpowers/specs/2026-05-08-imorigin-global-dd.md):
// daemon writes a single global state/IMOrigin (no paneId — owner-only ACL
// makes per-pane unnecessary; every inbound overwrites; daemon start/stop
// always-fresh, mirroring IMWork lifecycle).
//
// SessionStart / SessionEnd hooks + files removed (DD #61):
//   - cc lifecycle no longer needs file-based markers: wezterm cli list is
//     the live source of truth for "which panes have cc"
//   - daemon doesn't validate cc liveness via PID + lstart anymore;
//     trusts user-side knowledge from /start IM listing
export {
  STOP_PREFIX,
  PERMISSION_REQUEST_PREFIX,
  PERMISSION_RESPONSE_PREFIX,
  IM_WORK_FILE_NAME,
  IM_ORIGIN_FILE_NAME,
  DAEMON_PID_FILE_NAME,
  formatStopTimestamp,
  parseStopFilename,
  parsePermissionFilename,
  parseLegacyPaneOriginFilename,
  extractPaneIdFromFilename,
  stopFilePath,
  permissionRequestPath,
  permissionResponsePath,
  imWorkPath,
  imOriginPath,
  daemonPidPath,
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
  deletePermissionFileByPath,
  listPermissionRequestFiles,
  listPermissionResponseFiles,
  listPendingPermissionRequests,
  writeIMWorkFile,
  readIMWorkFile,
  existsIMWorkFile,
  deleteIMWorkFile,
  IMWorkFileSchema,
  writeIMOriginFile,
  readIMOriginFile,
  existsIMOriginFile,
  deleteIMOriginFile,
  writeDaemonPidFile,
  readDaemonPidFile,
  deleteDaemonPidFile,
  captureProcessLstart,
  isDaemonAlive,
  PermissionResponseFileSchema,
  PermissionDialogResponseFileSchema,
  permissionDialogRequestPath,
  permissionDialogResponsePath,
  writePermissionDialogRequestFile,
  readPermissionDialogRequestFile,
  writePermissionDialogResponseFile,
  readPermissionDialogResponseFile,
  deletePermissionDialogRequestFile,
  deletePermissionDialogResponseFile,
  listPermissionDialogRequestFiles,
  listPermissionDialogResponseFiles,
  listPendingPermissionDialogs,
  parsePermissionDialogFilename,
  PERMISSION_DIALOG_REQUEST_PREFIX,
  PERMISSION_DIALOG_RESPONSE_PREFIX,
} from './state-files.js';
export type {
  PerPaneIO,
  StopFile,
  PermissionRequestFile,
  PermissionResponseFile,
  PendingPermissionRequest,
  DaemonPidFile,
  ParsedStopFilename,
  ParsedPermissionFilename,
  ParsedPermissionDialogFilename,
  ParsedLegacyPaneOriginFilename,
  IMWorkFile,
  PermissionDialogRequestFile,
  PermissionDialogResponseFile,
  PendingPermissionDialog,
} from './state-files.js';

// Hook receiver entry point — invoked by `multi-cc-im hook <event>` CLI
// subcommand. Per DD #61: only PreToolUse + Stop are subscribed (cc
// settings.json hook list is 2 events, down from 4 — SessionStart and
// SessionEnd dropped).
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
