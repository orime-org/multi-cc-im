import { z } from 'zod';
import type { IncomingMessage } from '../types.js';

/**
 * Card-button callback payload — what the bridge embeds in
 * `behaviors:[{type:'callback', value: ...}]` so the adapter can route
 * the click back to the originating workflow.
 *
 * Per [DD 2026-05-19](../../../docs/superpowers/specs/2026-05-19-auq-pretooluse-card-buttons-dd.md)
 * γ pickup (P5: auq / P4: permission). Future P6+ can extend the
 * discriminated union without touching the adapter layer.
 *
 * `auq` shape mirrors lodestar `session-ask.ts` state-machine ids:
 *   - toolUseId — pairs the click back with the original cc tool call
 *   - questionIdx — which question in the AskUserQuestion array
 *   - optionIdx — `undefined` when the user picked the free-text option
 *   - customText — free-text answer; only set on form-submit callback
 *
 * `permission` shape mirrors PR #131-#135 v1.9 PermissionRequest:
 *   - requestId — the cc-issued request id we are responding to
 *   - decision — `allow` (one-shot) / `allow_always` (writes
 *     PermissionUpdate to `decision.updatedPermissions`) / `deny`
 */
export const CardActionValueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('auq'),
    toolUseId: z.string().min(1),
    questionIdx: z.number().int().nonnegative(),
    optionIdx: z.number().int().nonnegative().optional(),
    customText: z.string().optional(),
  }),
  z.object({
    kind: z.literal('permission'),
    requestId: z.string().min(1),
    decision: z.enum(['allow', 'allow_always', 'deny']),
  }),
]);
export type CardActionValue = z.infer<typeof CardActionValueSchema>;

/**
 * Lark `card.action.trigger` event payload — the SDK passes this raw
 * shape into the `EventDispatcher` `card.action.trigger` handler. The
 * adapter zod-parses it before invoking `onCardAction` so the bridge
 * sees a typed, validated value.
 *
 * Source: larksuite/node-sdk + lodestar/daemon.ts:206 handleCardAction
 * (MIT). Free-text submissions land under `form_value` / `input_value`
 * (key drift across schema versions — see lodestar comment).
 */
export const CardActionEventSchema = z.object({
  action: z.object({
    value: CardActionValueSchema,
    tag: z.string().optional(),
    form_value: z.record(z.string(), z.unknown()).optional(),
    input_value: z.unknown().optional(),
  }),
  context: z
    .object({
      open_chat_id: z.string().optional(),
      open_message_id: z.string().optional(),
    })
    .optional(),
  operator: z
    .object({
      open_id: z.string().optional(),
    })
    .optional(),
});
export type CardActionEvent = z.infer<typeof CardActionEventSchema>;

/**
 * Adapter return shape for `onCardAction`. Lark renders the `toast`
 * as a transient bubble on the user's screen acknowledging the click.
 */
export interface CardActionResponse {
  toast?: {
    type: 'success' | 'error' | 'info' | 'warning';
    content: string;
  };
}

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
  /**
   * Called when the user clicks a card button. Adapter has already
   * zod-parsed the IM-native payload into `CardActionEvent`. Return a
   * `CardActionResponse` to surface a toast back on the IM client.
   */
  onCardAction?: (event: CardActionEvent) => Promise<CardActionResponse | void>;
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

/**
 * Single question inside an AskUserQuestion forward payload.
 *
 * Mirrors the cc tool input shape, projected to just what the IM
 * adapter needs to render. Free-text submit always available via the
 * `customText` branch of `CardActionValue.kind='auq'`.
 */
export interface AUQQuestion {
  /** Index of this question inside the original tool_input.questions array. */
  questionIdx: number;
  /** The question prose (rendered as the card title / lead line). */
  text: string;
  /** Optional short header label (≤ 12 chars per cc convention). */
  header?: string;
  /** True when cc allows multi-select (P5 stub: still single-select UI). */
  multiSelect?: boolean;
  /** Option list. Buttons render one per entry. */
  options: { label: string; description?: string }[];
}

/**
 * AskUserQuestion forward payload — what the bridge hands to an
 * adapter capable of native button rendering.
 */
export interface AUQRequest {
  /** Pairs the click back with the originating cc tool call. */
  toolUseId: string;
  /** Cc tab title surfaced as `sourceTag` in the card prefix. */
  tabName: string;
  /** All questions in this AskUserQuestion turn; usually 1. */
  questions: AUQQuestion[];
}

/**
 * Capability: render an AskUserQuestion forward as a native button
 * card. Adapter is responsible for emitting click callbacks under
 * `behaviors:[{type:'callback', value:{kind:'auq', ...}}]` so the
 * bridge's `onCardAction` handler can match clicks back to a pending
 * AUQ.
 *
 * Per [DD 2026-05-19](../../../docs/superpowers/specs/2026-05-19-auq-pretooluse-card-buttons-dd.md)
 * γ P5: implementing adapters (Lark) render buttons; non-implementing
 * adapters fall through the bridge's text-path fallback (numbered list
 * + user types `/1` etc.).
 */
export interface AUQSender extends Adapter {
  sendAUQ(
    req: AUQRequest,
    replyCtx: ReplyContext,
    opts?: SendOptions,
  ): Promise<void>;
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
