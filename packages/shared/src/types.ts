import { z } from 'zod';
import { ReplyContextSchema } from './adapter/im.js';

// Brand helper for nominal types
declare const __brand: unique symbol;
export type Brand<T, B> = T & { readonly [__brand]: B };

// Common branded primitives (used across multiple adapters)
export type SessionId = Brand<string, 'SessionId'>;
export type CwdAbs = Brand<string, 'CwdAbs'>;
export type TranscriptPath = Brand<string, 'TranscriptPath'>;
/**
 * Opaque per-pane identifier used throughout the bridge to address terminal
 * panes. The concrete representation is **terminal-adapter-specific**:
 *
 * - **WezTerm**: numeric pane index from `wezterm cli list` / the
 *   `WEZTERM_PANE` env var (stable, non-negative integer).
 * - **iTerm2** (per [DD: iTerm2 adapter](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md)):
 *   UUID suffix of `ITERM_SESSION_ID` (e.g. `"C3D91F33-3805-47E2-A3F6-B8AED6EC2209"`).
 *   The full env value `w<W>t<T>p<P>:UUID` has an unstable `w/t/p` prefix
 *   that shifts when other panes close — the cli-cc pane-id detector
 *   strips it before branding.
 *
 * Consumers must treat `PaneId` as opaque: no arithmetic, no ordering, no
 * substring assumptions. Equality / map-key / serialization-as-string are
 * the only supported operations.
 */
export type PaneId = Brand<number | string, 'PaneId'>;

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

/**
 * PaneId runtime validator. Accepts either:
 *   - **non-negative integer** (WezTerm-style; source: `WEZTERM_PANE` env)
 *   - **non-empty string** (iTerm2-style; source: UUID suffix of
 *     `ITERM_SESSION_ID`)
 *
 * The schema does not enforce UUID format on the string variant; the
 * pane-id detector that produces the value is responsible for that. Schema
 * stays permissive so future terminals can plug in without re-versioning.
 */
export const PaneIdSchema = z
  .union([
    z.number().int().nonnegative(),
    z.string().min(1),
  ])
  .transform((v) => v as PaneId);

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
   * IM-native id of the message this one is a *reply* to (if any). Distinct
   * from {@link IncomingMessageSchema.replyCtx} (which is *outbound* threading
   * context for daemon→IM responses). Per [DD: IM image to cc §6 C.1](../../docs/superpowers/specs/2026-05-19-im-image-to-cc-dd.md)
   * the orchestrator uses this id to look up the parent image in `pendingImages`
   * and joint-route image+text to the cc tab. Adapters that don't surface a
   * native reply concept simply leave it `undefined`.
   */
  replyToMessageId: z.string().min(1).optional(),
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
