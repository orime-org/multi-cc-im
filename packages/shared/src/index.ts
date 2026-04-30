// Common types + zod schemas
export * from './types.js';

// IM adapter (re-exported with category prefixes for flat top-level API)
export type {
  Adapter as IMAdapter,
  Handler as IMHandler,
  ReplyContext as IMReplyContext,
  ImageSender as IMImageSender,
  FileSender as IMFileSender,
  VoiceSender as IMVoiceSender,
  TypingIndicator as IMTypingIndicator,
} from './adapter/im.js';

// Term adapter
export type {
  Adapter as TermAdapter,
  Handler as TermHandler,
  PaneAlive as TermPaneAlive,
} from './adapter/term.js';

// CLI adapter (incl. cc hook payload union types)
export type {
  Adapter as CLIAdapter,
  Handler as CLIHandler,
  HookPayload,
  HookDecision,
  SessionStartPayload,
  UserPromptSubmitPayload,
  PreToolUsePayload,
  PostToolUsePayload,
  StopPayload,
} from './adapter/cli.js';

// Storage capability interfaces (concrete impl in packages/storage-files)
export type {
  CursorStore,
  ConfigStore,
  PendingQueue,
  PendingMsg,
  Config,
  FriendlyNames,
  ACLConfig,
  ExternalPaths,
} from './adapter/storage.js';
export {
  ConfigSchema,
  FriendlyNamesSchema,
  ACLConfigSchema,
  ExternalPathsSchema,
} from './adapter/storage.js';

// Type guards
export * from './guards.js';
