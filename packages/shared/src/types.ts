import { z } from 'zod';

// Brand helper for nominal types
declare const __brand: unique symbol;
export type Brand<T, B> = T & { readonly [__brand]: B };

// Common branded primitives (used across multiple adapters)
export type SessionId = Brand<string, 'SessionId'>;
export type CwdAbs = Brand<string, 'CwdAbs'>;
export type TranscriptPath = Brand<string, 'TranscriptPath'>;
export type FriendlyName = Brand<string, 'FriendlyName'>;
export type PaneId = Brand<number, 'PaneId'>;

/** UUID v4 issued by Claude Code as session_id (hook+wezterm DD H1). */
export const SessionIdSchema = z
  .string()
  .uuid()
  .transform((s) => s as SessionId);

/** Absolute path (must start with `/`); already realpath'd by Claude Code (CLAUDE_PROJECT_DIR / stdin.cwd). */
export const CwdAbsSchema = z
  .string()
  .min(1)
  .startsWith('/')
  .transform((s) => s as CwdAbs);

/** Absolute path to a `.jsonl` transcript file (Claude Code provides this directly via hook stdin). */
export const TranscriptPathSchema = z
  .string()
  .startsWith('/')
  .endsWith('.jsonl')
  .transform((s) => s as TranscriptPath);

/** WezTerm pane id (non-negative integer). Hook env `WEZTERM_PANE` is the source. */
export const PaneIdSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((n) => n as PaneId);

/**
 * Reverse lookup `pane_id → session_id`. Bridge router owns the map (built
 * from `WEZTERM_PANE` env captured at SessionStart hook); term-wezterm's
 * PaneAlive capability consumes via DI.
 */
export interface PaneToSessionMap {
  /** Returns the session_id tracked for this pane, or `null` if unknown. */
  get(paneId: PaneId): SessionId | null;
}

/** User-given short name for a session (used for `@friendly` routing). */
export const FriendlyNameSchema = z
  .string()
  .min(1)
  .max(64)
  .transform((s) => s as FriendlyName);

/** Kind of attachment that can ride on an IM message. */
export const AttachmentKindSchema = z.enum(['image', 'file', 'voice']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

/** A file received from / sent to an IM. */
export const AttachmentSchema = z.object({
  kind: AttachmentKindSchema,
  localPath: z.string().min(1),
  mimetype: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Message arriving from an IM, normalized for routing. */
export const IncomingMessageSchema = z.object({
  msgId: z.string().min(1),
  from: z.string().min(1),
  text: z.string().nullable(),
  attachments: z.array(AttachmentSchema).default([]),
  timestamp: z.number(),
});
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
