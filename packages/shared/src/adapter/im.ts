import { z } from 'zod';
import type { IncomingMessage } from '../types.js';

/**
 * Handler that an IMAdapter pushes events into.
 * Per adapter DD (TS-first hybrid): callback inject via `start(handler)`,
 * not EventEmitter / AsyncIterator.
 */
export interface Handler {
  /** Called when a new message arrives from the IM channel. */
  onMessage(msg: IncomingMessage): Promise<void>;
  /** Called when the IM connection is dropped. */
  onDisconnect?: (reason: string) => Promise<void>;
  /** Called for non-fatal adapter errors that the bridge should be aware of. */
  onError?: (err: Error) => Promise<void>;
}

/**
 * Adapter-specific reply context — used by the bridge to route cc replies
 * back to the originating IM thread.
 *
 * **Discriminated union** on `imType`. Each variant carries the per-IM
 * fields needed by that adapter's `send()`:
 *
 *   - `lark`    : `{ imType: 'lark', openId, chatId }` — Feishu CN
 *                  self-built app, IM v1 messaging via official
 *                  `@larksuiteoapi/node-sdk`. Per [DD #86](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md).
 *   - `telegram`: `{ imType: 'telegram', chatId, messageId }` — reserved
 *                  for tg adapter (not implemented yet).
 *
 * The bridge **switches on `imType`** to dispatch to the correct adapter.
 * Persisted form (`<paneId>.IMOrigin` file) is the JSON of one variant.
 *
 * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md).
 *
 * **History note**: `'wechat'` was the original variant (Tencent OpenClaw
 * iLink protocol). Removed in DD #86 §11.2 / M1 wechat purge after
 * undici-upgrade instability (PRs #76 / #78 / #82) made the path not worth
 * maintaining.
 */
export type ReplyContext = LarkReplyContext | TelegramReplyContext;

export interface LarkReplyContext {
  imType: 'lark';
  openId: string;
  chatId: string;
}

export interface TelegramReplyContext {
  imType: 'telegram';
  chatId: number;
  messageId: number;
}

/**
 * Zod schema for `ReplyContext` runtime validation. Used by storage layer
 * (`<paneId>.IMOrigin` file reader) to defend against disk corruption and
 * unknown future imType values written by a newer daemon then read by an
 * older client (rejected with a parse error rather than silently routed
 * to the wrong adapter).
 */
export const ReplyContextSchema = z.discriminatedUnion('imType', [
  z.object({
    imType: z.literal('lark'),
    openId: z.string(),
    chatId: z.string(),
  }),
  z.object({
    imType: z.literal('telegram'),
    chatId: z.number(),
    messageId: z.number(),
  }),
]);

/**
 * Core IMAdapter interface — every IM channel implementation (lark / telegram /
 * slack / etc.) must satisfy this. Capabilities below extend this with optional
 * features; use type guards in `../guards.ts` to narrow before calling them.
 */
export interface Adapter {
  /** Stable identifier for log / config keys (e.g. `'lark'`). */
  readonly name: string;
  /** Begin polling / connecting. Hands events to the supplied handler. */
  start(handler: Handler): Promise<void>;
  /** Send plain text back to the conversation identified by `replyCtx`. */
  send(content: string, replyCtx: ReplyContext): Promise<void>;
  /** Stop polling, drain in-flight requests, release sockets. */
  stop(): Promise<void>;
}

/** Capability: send an image attachment to a conversation. */
export interface ImageSender extends Adapter {
  sendImage(localPath: string, replyCtx: ReplyContext): Promise<void>;
}

/** Capability: send a generic file attachment to a conversation. */
export interface FileSender extends Adapter {
  sendFile(localPath: string, replyCtx: ReplyContext): Promise<void>;
}

/** Capability: send a voice attachment to a conversation. */
export interface VoiceSender extends Adapter {
  sendVoice(localPath: string, replyCtx: ReplyContext): Promise<void>;
}

/**
 * Capability: show a "typing" indicator. Returns a function that the caller
 * MUST invoke when processing finishes (turn-scoped, not session-scoped).
 */
export interface TypingIndicator extends Adapter {
  startTyping(replyCtx: ReplyContext): Promise<() => void>;
}
