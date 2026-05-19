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
  /**
   * Sender's `open_id` from `event.sender.sender_id.open_id`. Identifies the
   * person we're replying to. Used by interactive card callbacks (M5) to
   * scope `/1` `/2` decisions to the original prompter.
   */
  openId: string;
  /**
   * `event.message.chat_id` — the chat the message arrived in. Used as
   * `receive_id` with `receive_id_type='chat_id'` when `client.im.v1.message.create`
   * sends a reply. Works for both 1-1 (`chat_type='p2p'`) and group chats.
   */
  chatId: string;
  /**
   * `event.message.message_id` — the original inbound message. Optional;
   * passed as `reply_in_thread` / referenced by M5 card actions to thread
   * tool-permission flow back to the prompt that triggered it.
   */
  messageId?: string;
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
    messageId: z.string().optional(),
  }),
  z.object({
    imType: z.literal('telegram'),
    chatId: z.number(),
    messageId: z.number(),
  }),
]);

/**
 * Optional per-send metadata. Lets the bridge tell the adapter *who* produced
 * this message so the adapter can render the source identity in an IM-native
 * way (Lark: section-marker prefix; Telegram: reply-quote; etc.).
 *
 * **Why an opts param instead of stuffing `[tab]` into `content`**: when the
 * adapter splits a long reply across multiple IM messages (Lark Card Kit
 * ≤ 3 tables per card — see `reference_feishu_cardkit_limits` memory) the
 * source tag must appear on every chunk, not just the first. Carrying it as
 * metadata lets each adapter decide how to repeat / format it per chunk.
 *
 * **Per [project_future_im_adapters]**: this is a base-interface concept —
 * tg / wechat will also want to disclose the source cc tab — so it lives in
 * shared, not in lark-specific code.
 */
export interface SendOptions {
  /**
   * Human-readable identifier of the message producer (e.g. cc tab title
   * `"operations"`, system role `"daemon"`). Adapters may render it as a
   * card prefix, reply quote, sender alias, or ignore it entirely. Leave
   * undefined for daemon-self echo (`/list` output, error notifications)
   * where the source is the daemon itself and surfacing a tag would clutter.
   */
  sourceTag?: string;
}

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
  /**
   * Send a message back to the conversation identified by `replyCtx`. The
   * optional `opts.sourceTag` lets callers disclose the producer (e.g. cc
   * tab title) so the adapter can prefix / quote it on every chunk when the
   * message gets split across multiple IM messages. See `SendOptions`.
   */
  send(content: string, replyCtx: ReplyContext, opts?: SendOptions): Promise<void>;
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
