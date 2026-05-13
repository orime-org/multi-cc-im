// Common types + zod schemas
export * from './types.js';

// AskUserQuestion tool I/O schemas (cc's built-in clarifying-question tool)
export {
  AskUserQuestionToolInputSchema,
  AskUserQuestionAnswerSchema,
  AskUserQuestionAIOutputSchema,
} from './ask-user-question.js';
export type {
  AskUserQuestionToolInput,
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserQuestionAnswer,
  AskUserQuestionAnswerEntry,
  AskUserQuestionAIOutput,
} from './ask-user-question.js';

// IM adapter (re-exported with category prefixes for flat top-level API)
export type {
  Adapter as IMAdapter,
  Handler as IMHandler,
  ReplyContext as IMReplyContext,
  TelegramReplyContext as IMTelegramReplyContext,
  LarkReplyContext as IMLarkReplyContext,
  ImageSender as IMImageSender,
  FileSender as IMFileSender,
  VoiceSender as IMVoiceSender,
  TypingIndicator as IMTypingIndicator,
} from './adapter/im.js';
export { ReplyContextSchema as IMReplyContextSchema } from './adapter/im.js';

// Term adapter
export type {
  Adapter as TermAdapter,
  Handler as TermHandler,
  ListPanes as TermListPanes,
  PaneInfo as TermPaneInfo,
} from './adapter/term.js';

// CLI adapter (incl. cc hook payload union types)
export type {
  Adapter as CLIAdapter,
  Handler as CLIHandler,
  HookPayload,
  HookDecision,
  PreToolUsePayload,
  PermissionRequestPayload,
  StopPayload,
} from './adapter/cli.js';

// Storage capability interfaces (concrete impl in packages/storage-files)
export type {
  CursorStore,
  ConfigStore,
  CredentialStore,
  PendingQueue,
  PendingMsg,
  Config,
  ACLConfig,
  ExternalPaths,
} from './adapter/storage.js';
export {
  ConfigSchema,
  ACLConfigSchema,
  ExternalPathsSchema,
} from './adapter/storage.js';

// Adapter setup wizard interface (W2 — DD §9.D5 hybrid pattern)
export type {
  AdapterSetupSchema,
  SetupField,
} from './adapter/setup.js';

// Type guards
export * from './guards.js';

// Error formatting
export { formatErrorWithCause } from './format-error.js';
