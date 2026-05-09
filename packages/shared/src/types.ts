import { z } from 'zod';
import { ReplyContextSchema } from './adapter/im.js';

// Brand helper for nominal types
declare const __brand: unique symbol;
export type Brand<T, B> = T & { readonly [__brand]: B };

// Common branded primitives (used across multiple adapters)
export type SessionId = Brand<string, 'SessionId'>;
export type CwdAbs = Brand<string, 'CwdAbs'>;
export type TranscriptPath = Brand<string, 'TranscriptPath'>;
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
 * @deprecated Per [DD: pane-keyed state files](../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
 * daemon no longer maintains a paneId↔sessionId reverse map. Bridge router
 * uses `TermListPanes.listPanes()` directly as the source of truth.
 *
 * No active consumers remain after the wechat purge (DD #86 §11.2). Kept
 * exported for now only as a defensive marker — new code should not
 * implement or consume this.
 */
export interface PaneToSessionMap {
  get(paneId: PaneId): SessionId | null;
}

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
  /**
   * Adapter-specific reply context, discriminated by `imType`. Bridge stores
   * it per-pane (`<paneId>.IMOrigin`) so that when cc Stop hook fires for
   * that pane, the reply can be routed back via `IMAdapter.send(content,
   * replyCtx)`. Per [DD: pane-keyed state files](../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)
   * the union is locked at compile time; multi-IM threading uses the
   * discriminator at runtime.
   */
  replyCtx: ReplyContextSchema,
});
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
