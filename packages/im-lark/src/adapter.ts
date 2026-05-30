import * as lark from '@larksuiteoapi/node-sdk';
import {
  formatErrorWithCause,
  IMCardActionEventSchema,
  type CredentialStore,
  type IMAdapter,
  type IMAUQRequest,
  type IMAUQSender,
  type IMPermissionRequest,
  type IMPermissionSender,
  type IMHandler,
  type IMReplyContext,
  type IMSendOptions,
  type IncomingMessage,
} from '@multi-cc-im/shared';
const CardActionEventSchema = IMCardActionEventSchema;
import type { LarkCredentials } from './credentials.js';
import {
  downloadAttachment as defaultDownloadAttachment,
  type DownloadAttachmentOpts,
  type DownloadedAttachment,
} from './inbound-image.js';
import { stripMarkdown } from './markdown.js';
import { parsePostContent } from './parse-post-content.js';
import type { TenantTokenStore } from './tenant-token.js';

/**
 * Minimal shape of the Feishu/Lark SDK `Client` we actually use for sending.
 * Tests inject a stub matching this; the real SDK satisfies it via duck
 * typing — we don't depend on the full `Client` type, only on the IM
 * messaging path we exercise.
 */
export interface LarkClientShape {
  im: {
    v1: {
      message: {
        create: (payload: {
          params: { receive_id_type: 'chat_id' | 'open_id' | 'union_id' | 'user_id' };
          data: {
            receive_id: string;
            /**
             * - `'text'` — plain text (`content: JSON.stringify({text})`);
             *   `send()`'s fallback path when cardkit is unavailable / fails.
             * - `'interactive'` — references a cardkit card entity
             *   (`content: {"type":"card","data":{"card_id"}}`); `send()`'s
             *   primary path. Per [DD 2026-05-30](../../../docs/superpowers/specs/2026-05-30-feishu-message-ordering-cardkit-dd.md).
             */
            msg_type: 'text' | 'interactive';
            content: string;
          };
        }) => Promise<{ code?: number; msg?: string; data?: unknown }>;
        /**
         * GET `/open-apis/im/v1/messages/:message_id`. Used by the inbound
         * reply pipeline to fetch the body of a quoted parent message
         * referenced by `parent_id` — Feishu does not embed parent content
         * in the `im.message.receive_v1` event, so on-demand fetch is the
         * only stateless path. Response shape per SDK
         * `types/index.d.ts` L252219-L252260: `data.items[]` with each item
         * carrying `body.content` (JSON-serialized; text → `{"text":"..."}`)
         * + `sender.{id,sender_type}` + `msg_type` + `deleted`.
         *
         * Required scope (any one): `im:message:readonly` / `im:message` /
         * `im:message.history:readonly`. Known per-call error codes:
         * `230110` (parent deleted), `230050` (invisible to bot),
         * `230002` (bot not in group).
         *
         * **Optional** so existing test stubs that only mock `create` still
         * satisfy the shape — adapter call sites null-check (`?.get?.(...)`)
         * and degrade to "no quoted context" when absent, which matches the
         * orchestrator's missing-`quotedMessage` IM-notify branch.
         */
        get?: (payload: {
          path: { message_id: string };
          /**
           * Query params for shape-modifiers. `card_msg_content_type` is
           * **critical** for `msg_type=interactive` (cardkit): default
           * response is a **condensed server-side card structure** that
           * does NOT include `body.elements[]` (per Feishu docs
           * 2026-05-22). Pass `'user_card_content'` to receive the
           * original schema-2.0 card JSON with full `body.elements[]`,
           * so cardkit parsers can extract markdown / plain_text /
           * button text. Has no effect on non-interactive types.
           * See [[reference_feishu_message_get_interactive_user_card_content]].
           */
          params?: { card_msg_content_type?: 'user_card_content' };
        }) => Promise<{
          code?: number;
          msg?: string;
          data?: {
            items?: Array<{
              message_id?: string;
              msg_type?: string;
              deleted?: boolean;
              body?: { content?: string };
              sender?: {
                id?: string;
                id_type?: string;
                sender_type?: string;
              };
            }>;
          };
        }>;
      };
    };
  };
  /**
   * CardKit v1 — create a card entity (returns `card_id`) so the whole cc
   * reply can be sent as ONE interactive message. Per
   * [DD 2026-05-30](../../../docs/superpowers/specs/2026-05-30-feishu-message-ordering-cardkit-dd.md):
   * one reply = one card = one message → eliminates the multi-message
   * ordering bug (Feishu doesn't guarantee order across separate messages;
   * in-card element order is fixed by structure). Requires
   * `cardkit:card:write` (**application identity** — daemon uses
   * tenant_access_token; the user-identity variant does NOT work).
   *
   * **Optional** so inbound-only test stubs (which mock just `im.message`)
   * still satisfy the shape; `send()` null-checks and degrades to a plain
   * text message when absent.
   */
  cardkit?: {
    v1: {
      card: {
        create: (payload: {
          data: { type: 'card_json'; data: string };
        }) => Promise<{
          code?: number;
          msg?: string;
          data?: { card_id?: string };
        }>;
      };
    };
  };
}

/**
 * Minimal shape of the Feishu SDK `WSClient` (long-connection event stream).
 * Tests stub this. We only call `start()` and `close()`; reconnection /
 * ping are owned entirely by the SDK.
 */
export interface LarkWSClientShape {
  start(params: { eventDispatcher: lark.EventDispatcher }): Promise<void>;
  close(params?: { force?: boolean }): void;
}

export interface CreateLarkAdapterOpts {
  credentialStore: CredentialStore<LarkCredentials>;
  /**
   * Override the SDK Client factory. Default constructs `new lark.Client(...)`.
   * Tests inject a stub satisfying `LarkClientShape`.
   */
  buildClient?: (creds: LarkCredentials) => LarkClientShape;
  /**
   * Override the WSClient factory. Default constructs
   * `new lark.WSClient(...)` with `autoReconnect:true` and pipes `onError`
   * into the adapter's error sink. Tests inject a stub.
   */
  buildWSClient?: (
    creds: LarkCredentials,
    callbacks: {
      onReady: () => void;
      onError: (err: Error) => void;
      onReconnecting: () => void;
      onReconnected: () => void;
    },
  ) => LarkWSClientShape;
  /**
   * Override the EventDispatcher factory. Tests stub the `register` /
   * `invoke` round-trip to fire fake events without a real WS.
   */
  buildDispatcher?: () => lark.EventDispatcher;
  /** INFO-level event sink (start / ready / reconnect lines). */
  log?: (line: string) => void;
  /**
   * Override the WS retry interval (ms) between two connection attempts.
   * Default 1000ms — see start() for the cool-down policy. Tests inject
   * a small value to exercise the cool-down branch within a test
   * timeout budget.
   */
  retryIntervalMs?: number;
  /**
   * Override the WS cool-down (ms) after N consecutive failures.
   * Default 5000ms.
   */
  cooldownMs?: number;
  /**
   * Override how many consecutive failures trigger a cool-down. Default
   * 10. Tests inject a smaller number to verify the cool-down log line
   * fires without waiting for 10 real retries.
   */
  cooldownAfter?: number;
  /**
   * Shared tenant-token cache. **Required** to enable inbound image
   * handling; when omitted, image events are dropped with a log line
   * (degraded mode for callers that don't wire image inbound). Same
   * instance the cardkit client uses — keeps both auth paths riding one
   * rotation window.
   */
  tenantTokenStore?: TenantTokenStore;
  /**
   * Absolute directory inbound images are saved to. **Required** alongside
   * `tenantTokenStore` to enable image handling. Daemon typically derives
   * this from `appPaths.inboundFor('lark')` + `/images`.
   */
  inboundImagesDir?: string;
  /**
   * Override the downloader. Default is the package-level
   * `downloadAttachment`. Tests inject a stub matching the same signature
   * so they exercise the inbound flow without real Feishu HTTP.
   */
  downloadAttachmentImpl?: (
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    name: string | undefined,
    opts: DownloadAttachmentOpts,
  ) => Promise<DownloadedAttachment>;
}

/**
 * Build a Lark/Feishu IM adapter satisfying `IMAdapter`. Per
 * [DD #86 §11.4 M3](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md):
 *
 * **Inbound** — `lark.WSClient` long-connection (no public IP needed) +
 * `lark.EventDispatcher` registered for `im.message.receive_v1`. Inbound
 * text and image events are normalized to `IncomingMessage` and pushed via
 * `handler.onMessage`; image events trigger a `downloadAttachment` call
 * first so `attachments[].localPath` is populated before the bridge sees
 * the message (per [DD: IM image to cc §2.B](../../../docs/superpowers/specs/2026-05-19-im-image-to-cc-dd.md)).
 * Audio events get a "use the mic-to-text keyboard" echo
 * (DD 2026-05-12). All other types (file / sticker / etc.) still drop
 * silently in v1.
 *
 * **Outbound** — `client.im.v1.message.create` with
 * `receive_id_type='chat_id'` + `msg_type='text'`. The chat_id is sourced
 * from `replyCtx.chatId` which the bridge persisted at inbound time.
 *
 * **Lifecycle** — `start()` loads credentials, builds Client + WSClient,
 * registers event handler, awaits WSClient.start(). `stop()` calls
 * WSClient.close(). Reconnection / pinging are owned by the SDK; we
 * only surface state changes via `log`.
 */
/**
 * Maximum number of recently-seen `message_id`s to keep in the inbound
 * dedup set. Feishu's WebSocket event delivery is at-least-once
 * (SDK / server may redeliver on reconnect, ping-loss, etc.) per the
 * official docs, so the adapter has to dedup by `message.message_id`
 * (server-unique `om_xxx`) or the bridge dispatches the same IM message
 * to the same cc tab multiple times. Per user smoke 2026-05-11.
 *
 * Sized at 200 because: avg IM message at most a few per second; 200 ~=
 * one to several minutes of history. Well above the typical Feishu
 * redelivery window after a reconnect (a handful of buffered events,
 * not hundreds). Tighter caps risk evicting a still-pending dup before
 * it arrives; larger caps cost memory without benefit.
 */
const SEEN_MSGID_MAX = 200;

/**
 * Recursively traverse a Lark Card Kit schema-2.0 element tree and
 * extract human-readable text from `markdown` / `plain_text` content
 * fields and `button.text.content` labels. Containers
 * (`interactive_container.elements[]`, `column_set.columns[].elements[]`,
 * `column.elements[]`) are walked depth-first. Unknown tags are silently
 * skipped — the walker only surfaces text that exists; it does not
 * invent fallbacks or include structural noise (button `value` payloads,
 * `behaviors` callbacks, etc.).
 *
 * Returns a flat list of strings, ready to be joined by the caller.
 * Order is the DOM-traversal order of the input tree, preserving the
 * card's visual reading order.
 */
function extractCardText(elements: unknown): string[] {
  if (!Array.isArray(elements)) return [];
  const out: string[] = [];
  for (const el of elements) {
    if (el === null || typeof el !== 'object') continue;
    const node = el as Record<string, unknown>;
    const tag = typeof node.tag === 'string' ? node.tag : '';

    if (tag === 'markdown' || tag === 'plain_text') {
      if (typeof node.content === 'string' && node.content.length > 0) {
        out.push(node.content);
      }
    }
    if (tag === 'button') {
      const textNode = node.text;
      if (
        textNode !== null &&
        typeof textNode === 'object' &&
        typeof (textNode as Record<string, unknown>).content === 'string'
      ) {
        const buttonText = (textNode as { content: string }).content;
        if (buttonText.length > 0) out.push(`[Button] ${buttonText}`);
      }
    }
    if (Array.isArray(node.elements)) {
      out.push(...extractCardText(node.elements));
    }
    if (Array.isArray(node.columns)) {
      out.push(...extractCardText(node.columns));
    }
  }
  return out;
}

/**
 * Parse a Lark Card Kit schema-2.0 card content JSON (as embedded in
 * `body.content` of an `msg_type=interactive` message) and return its
 * human-readable rendering. Used for quoted-reply context when the user
 * replies to a bot card (AskUserQuestion / PermissionRequest / Stop
 * forward with markdown table → cardkit).
 *
 * Returns the joined text on success; `null` when the content is not a
 * valid card JSON, lacks a `body.elements[]`, or yields zero extracted
 * strings. Caller (renderQuotedItem) falls back to `[interactive]`
 * placeholder on null.
 */
function renderInteractiveCardContent(rawContent: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const body = (parsed as { body?: unknown }).body;
  if (body === null || typeof body !== 'object') return null;
  const elements = (body as { elements?: unknown }).elements;
  const texts = extractCardText(elements);
  if (texts.length === 0) return null;
  return texts.join('\n');
}

/**
 * Render a Feishu message item — fetched via `im.v1.message.get` — into the
 * shared `IncomingMessage.quotedMessage` shape. Returns `null` when the
 * item itself signals "no useful body": deleted, missing body, or empty
 * content. Caller (adapter) maps `null` to "leave `quotedMessage`
 * undefined", which orchestrator then surfaces as an IM notice + degrade
 * per [DD: text reply quoted context §5].
 *
 * Content rendering rules (consumer is cc tab, not AI router — quoted
 * is programmatically appended to cc dispatch.content per PR #222):
 *
 * | msg_type | Rendering |
 * |---|---|
 * | `text` | JSON-decoded `.text` (verbatim user message body) |
 * | `interactive` (cardkit) | Recursive parse of `body.elements[]` — extract markdown / plain_text / button text per `renderInteractiveCardContent`; falls back to `[interactive]` if parse yields no text |
 * | `image` / `file` / `sticker` / others | `[<msg_type>]` placeholder — cc has no local resource for these, surfacing raw `image_key` / `file_key` JSON would be noise |
 *
 * Sender role classification: `sender_type` values per Feishu docs are
 * `user` (real person) or `app` (bot/integration); we map `app` → `'bot'`,
 * `user` → `'user'`, anything else (incl. missing) → `'unknown'`. The
 * orchestrator does NOT branch on this — it's a hint passed verbatim
 * to cc so the prompt stays accurate when the quoted parent is the
 * user's own prior message (vs cc's Stop reply).
 */
function renderQuotedItem(item: {
  msg_type?: string;
  deleted?: boolean;
  body?: { content?: string };
  sender?: { id?: string; sender_type?: string };
}): { content: string; sender: { id: string; role: 'user' | 'bot' | 'unknown' } } | null {
  if (item.deleted) return null;
  const rawContent = item.body?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return null;
  const senderId = item.sender?.id;
  if (typeof senderId !== 'string' || senderId.length === 0) return null;
  let content: string;
  if (item.msg_type === 'text') {
    try {
      const parsed = JSON.parse(rawContent) as { text?: unknown };
      if (typeof parsed.text !== 'string' || parsed.text.length === 0) {
        return null;
      }
      content = parsed.text;
    } catch {
      return null;
    }
  } else if (item.msg_type === 'interactive') {
    const cardText = renderInteractiveCardContent(rawContent);
    content = cardText ?? '[interactive]';
  } else {
    content = `[${item.msg_type ?? 'unknown'}]`;
  }
  const senderType = item.sender?.sender_type;
  const role: 'user' | 'bot' | 'unknown' =
    senderType === 'user' ? 'user' : senderType === 'app' ? 'bot' : 'unknown';
  return {
    content,
    sender: { id: senderId, role },
  };
}

/**
 * On-demand fetch of a quoted parent message via SDK
 * `client.im.v1.message.get`. Returns the rendered quotedMessage on
 * success; `undefined` on any failure path (network error, SDK throw,
 * Feishu error code, parent deleted, empty body). Failures are logged
 * via `log` but never raised — orchestrator handles the undefined case
 * by sending a user-facing IM notice and degrading to reply-text-only
 * routing per [DD: text reply quoted context §5].
 *
 * Known Feishu error codes the caller may see in `code`:
 * - `230110`: message deleted
 * - `230050`: invisible to operator (bot can't see it)
 * - `230002`: bot not in the group containing the message
 * Treated uniformly as "no quoted context" — orchestrator's IM notice is
 * the same regardless of which sub-cause, since the user-actionable
 * answer is the same ("daemon couldn't read the message you quoted").
 */
async function fetchQuotedMessage(
  client: LarkClientShape,
  parentMessageId: string,
  log: (line: string) => void,
): Promise<IncomingMessage['quotedMessage']> {
  const getFn = client.im.v1.message.get;
  if (typeof getFn !== 'function') {
    log(
      `[lark] quoted parent fetch skipped — client lacks im.v1.message.get (test stub or pre-1.63 SDK?)`,
    );
    return undefined;
  }
  type GetResp = Awaited<
    ReturnType<NonNullable<LarkClientShape['im']['v1']['message']['get']>>
  >;
  let resp: GetResp;
  try {
    // Pass `card_msg_content_type=user_card_content` so msg_type=interactive
    // parents return their original schema-2.0 card JSON (with
    // `body.elements[]`) rather than Feishu's default condensed shape.
    // Without this, renderInteractiveCardContent / extractCardText would
    // find no elements and fall back to `[interactive]` placeholder even
    // for our own cards. Has no effect on text/image/file etc. Per
    // [[reference_feishu_message_get_interactive_user_card_content]].
    resp = await getFn({
      path: { message_id: parentMessageId },
      params: { card_msg_content_type: 'user_card_content' },
    });
  } catch (err) {
    log(
      `[lark] quoted parent fetch threw for ${parentMessageId}: ${formatErrorWithCause(err)}`,
    );
    return undefined;
  }
  if (typeof resp.code === 'number' && resp.code !== 0) {
    log(
      `[lark] quoted parent fetch returned non-zero code=${resp.code} msg=${resp.msg ?? ''} for ${parentMessageId}`,
    );
    return undefined;
  }
  const item = resp.data?.items?.[0];
  if (!item) {
    log(
      `[lark] quoted parent fetch returned empty items for ${parentMessageId}`,
    );
    return undefined;
  }
  const rendered = renderQuotedItem(item);
  if (rendered === null) {
    log(
      `[lark] quoted parent ${parentMessageId} renders to null (deleted / empty / un-parseable)`,
    );
    return undefined;
  }
  return rendered;
}

/**
 * Build a Lark Card Kit schema-2.0 card from an `AUQRequest`. Each
 * option becomes an `interactive_container` (the whole row is
 * clickable, mirrors lodestar `cards/turn.ts:386-402` pattern) carrying
 * a `card.action.trigger` callback with `value.kind = 'auq'`. Free-text
 * fallback is intentionally NOT rendered as a button — users can simply
 * reply in IM (v1.9 D5/D6 natural-language path handles the routing).
 *
 * Per [DD γ P5 (2026-05-19)](../../../docs/superpowers/specs/2026-05-19-auq-pretooluse-card-buttons-dd.md).
 */
function buildAUQCard(req: IMAUQRequest): Record<string, unknown> {
  const q = req.questions[0];
  if (!q) {
    throw new Error('buildAUQCard: empty questions array');
  }
  const elements: Record<string, unknown>[] = [];
  // Question header
  const heading = q.header ? `**[${q.header}]** ${q.text}` : q.text;
  elements.push({ tag: 'markdown', content: heading });
  // Options — one interactive_container per option, click → callback.
  q.options.forEach((opt, optionIdx) => {
    const desc = opt.description ? `\n${opt.description}` : '';
    elements.push({
      tag: 'interactive_container',
      background_style: 'default',
      has_border: true,
      corner_radius: '6px',
      padding: '8px 12px',
      margin: '4px 0px 4px 0px',
      behaviors: [
        {
          type: 'callback',
          value: {
            kind: 'auq',
            toolUseId: req.toolUseId,
            questionIdx: q.questionIdx,
            optionIdx,
          },
        },
      ],
      elements: [
        { tag: 'markdown', content: `**${opt.label}**${desc}` },
      ],
    });
  });
  // Free-text reminder — no button, just a hint that natural reply
  // also works (v1.9 D5/D6 natural-language path).
  elements.push({
    tag: 'markdown',
    content: '_或直接回复消息作自由文本回答_',
  });
  // Multi-question disclaimer (P5: render only Q[0]).
  if (req.questions.length > 1) {
    elements.push({
      tag: 'markdown',
      content: `_（cc 共问 ${req.questions.length} 题，IM 只显示第 1 题；其余请在 cc TUI 操作）_`,
    });
  }
  return { schema: '2.0', body: { elements } };
}

/**
 * Build a Lark Card Kit schema-2.0 card for a PreToolUse permission
 * ask. Renders the tool name + a 1-line input preview, followed by
 * a 2-button row (✅ allow / ❌ deny). Buttons use both top-level
 * `value` AND `behaviors:[{callback}]` per
 * [[reference_feishu_cardkit_limits]]: 200340 prevention — missing
 * top-level `value` on a button fails Feishu client-side validation.
 *
 * Per [DD γ P4 A 2026-05-19] — "allow_always" intentionally NOT
 * rendered (v1.12 D6-A lock: only cc-given suggestions can be
 * `updatedPermissions` material; PreToolUse普通流没 cc-suggestion → no
 * button for it).
 */
function buildPermissionCard(req: IMPermissionRequest): Record<string, unknown> {
  function permissionButton(
    label: string,
    type: 'primary' | 'danger',
    decision: 'allow' | 'deny',
  ): Record<string, unknown> {
    const payload = {
      kind: 'permission' as const,
      requestId: req.requestId,
      decision,
    };
    return {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: label },
          type,
          // Both `value` (top-level, Feishu client validation gate
          // per openclaw-lark ask-user-question.ts) and
          // `behaviors:[{callback}]` (event payload route).
          value: payload,
          behaviors: [{ type: 'callback', value: payload }],
        },
      ],
    };
  }

  return {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `**🔐 ${req.toolName}**\n\n\`${req.toolInputSummary}\``,
        },
        {
          tag: 'column_set',
          columns: [
            permissionButton('✅ 允许', 'primary', 'allow'),
            permissionButton('❌ 拒绝', 'danger', 'deny'),
          ],
        },
        {
          tag: 'markdown',
          content: '_10 秒内回复，否则默认放行_',
        },
      ],
    },
  };
}

export function createLarkAdapter(
  opts: CreateLarkAdapterOpts,
): IMAdapter & IMAUQSender & IMPermissionSender {
  const log = opts.log ?? (() => {});

  let wsClient: LarkWSClientShape | undefined;
  let client: LarkClientShape | undefined;
  let started = false;
  // Shared state for the WS retry loop in start() — `stop()` flips
  // `stopRequested` so any in-flight retry timer self-cancels instead of
  // racing the closed wsClient.
  let stopRequested = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * LRU of recently-seen inbound `message_id`s. JS `Set` preserves
   * insertion order, so the oldest entry is `seenMsgIds.values().next()`.
   * Lookup + insert + eviction are all O(1).
   */
  const seenMsgIds = new Set<string>();

  /**
   * Returns `true` if `messageId` was new (caller should process this
   * inbound event) or `false` if it's a duplicate (caller should drop).
   * On `true`, the id is recorded; if the set exceeds `SEEN_MSGID_MAX`
   * the oldest id is evicted.
   */
  function rememberOrDropMsgId(messageId: string): boolean {
    if (seenMsgIds.has(messageId)) return false;
    seenMsgIds.add(messageId);
    if (seenMsgIds.size > SEEN_MSGID_MAX) {
      const oldest = seenMsgIds.values().next().value;
      if (oldest !== undefined) seenMsgIds.delete(oldest);
    }
    return true;
  }

  function buildDefaultClient(creds: LarkCredentials): LarkClientShape {
    return new lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: lark.Domain.Feishu,
      disableTokenCache: false,
      // Suppress SDK's `[info]: [ 'client ready' ]` / similar boilerplate;
      // our own `[lark]`-prefixed callback logs cover the lifecycle states
      // a user cares about. Errors and warnings still surface.
      loggerLevel: lark.LoggerLevel.warn,
    }) as unknown as LarkClientShape;
  }

  function buildDefaultWSClient(
    creds: LarkCredentials,
    callbacks: {
      onReady: () => void;
      onError: (err: Error) => void;
      onReconnecting: () => void;
      onReconnected: () => void;
    },
  ): LarkWSClientShape {
    return new lark.WSClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: lark.Domain.Feishu,
      // We own the reconnect loop (1s/10-then-5s cool, see `runConnectLoop`
      // in start()) — SDK's exponential backoff was too slow to recover
      // from China-Feishu network flakes (4+ minutes observed). Turning
      // SDK's autoReconnect off makes its `connect failed` errors land on
      // our `onError`, which kicks the loop.
      autoReconnect: false,
      // Drops the multi-line `[info]: [ '[ws]', 'receive events or callbacks
      // through persistent connection only available in self-build &
      // Feishu app, Configured in: Developer Console(开发者后台) -> ...' ]`
      // hint plus other `reconnect` / `ws client ready` info-level chatter.
      // The corresponding lifecycle states are covered by our typed
      // `callbacks` (onReady / onError / onReconnecting / onReconnected).
      loggerLevel: lark.LoggerLevel.warn,
      ...callbacks,
    });
  }

  function buildDefaultDispatcher(): lark.EventDispatcher {
    // verificationToken / encryptKey not required for WSClient long-connection
    // events (those are webhook-mode concerns). Empty config is correct here.
    return new lark.EventDispatcher({});
  }

  return {
    name: 'lark',

    async start(handler: IMHandler): Promise<void> {
      if (started) {
        throw new Error('createLarkAdapter: already started');
      }
      started = true;

      const creds = await opts.credentialStore.load();
      if (creds === null) {
        throw new Error(
          'createLarkAdapter: no credentials at credentialStore — run `multi-cc-im login lark` first',
        );
      }

      client = (opts.buildClient ?? buildDefaultClient)(creds);

      const dispatcher = (opts.buildDispatcher ?? buildDefaultDispatcher)().register({
        'im.message.receive_v1': async (data) => {
          // Dedup by Feishu's server-unique message_id (`om_xxx`). Feishu's
          // WebSocket event subscription is **at-least-once** delivery —
          // the SDK / server may redeliver the same event on reconnect,
          // ping loss, ack timeout, etc. Without this gate, the bridge
          // dispatches the same IM message to the same cc tab multiple
          // times. Per user smoke 2026-05-11.
          //
          // Silent drop: SDK redelivery is normal protocol behavior, not
          // an event the user needs to see. Logging every redelivery
          // floods stderr without actionable signal. The dedup contract
          // is asserted by unit tests (`adapter.test.ts` dedup describe
          // block).
          if (!rememberOrDropMsgId(data.message.message_id)) {
            return;
          }

          // Audio messages get a friendly echo pointing users to the mobile
          // keyboard's mic-to-text feature (system-level STT, runs on the
          // user's device before sending — produces msg_type='text' which
          // the daemon handles normally). Per [DD: lark audio msg handling](../../../docs/superpowers/specs/2026-05-12-lark-audio-msg-handling-dd.md)
          // §5 — daemon stays text-only; this echo replaces silent drop so
          // a user who hits the audio-msg button by mistake sees what to do
          // instead of "did my message disappear?".
          if (data.message.message_type === 'audio') {
            log(
              `[lark] received audio message from ${data.sender.sender_id?.open_id ?? '<unknown>'}, replying with keyboard-mic hint (per DD 2026-05-12 D1-1: not handling audio msgs)`,
            );
            try {
              await client!.im.v1.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                  receive_id: data.message.chat_id,
                  msg_type: 'text',
                  content: JSON.stringify({
                    text: '❌ 暂不支持音频消息，请用键盘 🎤 麦克风转文字后发送',
                  }),
                },
              });
            } catch (err) {
              log(
                `[lark] failed to echo audio-unsupported hint: ${formatErrorWithCause(err)}`,
              );
            }
            return;
          }

          // Image messages: download via Feishu resource API, surface to the
          // bridge as an `IncomingMessage` whose `attachments[].kind='image'`
          // carries the on-disk path. The orchestrator either stashes the
          // image (image-only msg) or joint-routes with a follow-up reply per
          // [DD: IM image to cc §6 C.1](../../../docs/superpowers/specs/2026-05-19-im-image-to-cc-dd.md).
          //
          // Degraded mode: if `tenantTokenStore` / `inboundImagesDir` are not
          // wired (legacy callers, smaller tests), drop with a log line so
          // we don't crash the WS loop trying to download with no Bearer.
          if (data.message.message_type === 'image') {
            if (!opts.tenantTokenStore || !opts.inboundImagesDir) {
              log(
                `[lark] dropping image message_id=${data.message.message_id} (image inbound not wired — opts.tenantTokenStore/inboundImagesDir missing)`,
              );
              return;
            }
            let imageKey: string;
            try {
              const parsed = JSON.parse(data.message.content) as {
                image_key?: unknown;
              };
              if (typeof parsed.image_key !== 'string' || parsed.image_key.length === 0) {
                log(
                  `[lark] dropping image event with malformed content (no .image_key string)`,
                );
                return;
              }
              imageKey = parsed.image_key;
            } catch (err) {
              log(
                `[lark] dropping image event with un-parseable content: ${formatErrorWithCause(err)}`,
              );
              return;
            }
            const openId = data.sender.sender_id?.open_id;
            if (!openId) {
              log(`[lark] dropping image event missing sender.sender_id.open_id`);
              return;
            }
            const downloadImpl = opts.downloadAttachmentImpl ?? defaultDownloadAttachment;
            let downloaded: DownloadedAttachment;
            try {
              downloaded = await downloadImpl(
                data.message.message_id,
                imageKey,
                'image',
                undefined,
                {
                  appId: creds.appId,
                  appSecret: creds.appSecret,
                  tenantTokenStore: opts.tenantTokenStore,
                  outDir: opts.inboundImagesDir,
                },
              );
            } catch (err) {
              log(
                `[lark] image download failed for ${data.message.message_id}: ${formatErrorWithCause(err)}`,
              );
              return;
            }
            const replyCtx: IMReplyContext = {
              imType: 'lark',
              openId,
              chatId: data.message.chat_id,
              messageId: data.message.message_id,
            };
            const parentRaw = (data.message as { parent_id?: unknown }).parent_id;
            const replyToMessageId =
              typeof parentRaw === 'string' && parentRaw.length > 0 ? parentRaw : undefined;
            const quotedMessage =
              replyToMessageId && client
                ? await fetchQuotedMessage(client, replyToMessageId, log)
                : undefined;
            const msg: IncomingMessage = {
              msgId: data.message.message_id,
              from: openId,
              text: null,
              attachments: [
                {
                  kind: 'image',
                  localPath: downloaded.localPath,
                  mimetype: downloaded.mimetype,
                },
              ],
              timestamp: Number(data.message.create_time),
              replyToMessageId,
              quotedMessage,
              replyCtx,
            };
            try {
              await handler.onMessage(msg);
            } catch (err) {
              if (handler.onError) {
                await handler.onError(
                  err instanceof Error ? err : new Error(String(err)),
                );
              }
            }
            return;
          }

          // post: Feishu's native rich-text (mixed text + image + links +
          // mentions in one message). Parse into normalized
          // `{text, imageKeys[]}`, download all image_keys via the same
          // `downloadImpl` cli-cc image path uses, then dispatch as ONE
          // `IncomingMessage` with `text` set AND `attachments` populated.
          // Orchestrator joint-dispatch path picks this up and prepends
          // `请看 @<path> ...` to each dispatch.content (same convention
          // image-reply-join uses) so cc tab reads images + text in one
          // turn. Per [decisions 1A + 2A, 2026-05-26].
          if (data.message.message_type === 'post') {
            if (!opts.tenantTokenStore || !opts.inboundImagesDir) {
              log(
                `[lark] dropping post message_id=${data.message.message_id} (image inbound not wired — opts.tenantTokenStore/inboundImagesDir missing)`,
              );
              return;
            }
            const parsed = parsePostContent(data.message.content);
            if (parsed === null) {
              log(
                `[lark] dropping post message_id=${data.message.message_id} with malformed content (parsePostContent returned null)`,
              );
              return;
            }
            const openIdPost = data.sender.sender_id?.open_id;
            if (!openIdPost) {
              log(`[lark] dropping post event missing sender.sender_id.open_id`);
              return;
            }
            // Download all image_keys in parallel. Partial failure is
            // tolerated — a failed image is logged and its path omitted
            // from attachments; the post still routes with the text and
            // any successfully-downloaded images. Total failure (zero
            // images down where some were promised) still routes the
            // text-only — better than silent drop.
            const downloadImplPost = opts.downloadAttachmentImpl ?? defaultDownloadAttachment;
            const downloadResults = await Promise.allSettled(
              parsed.imageKeys.map((imageKey) =>
                downloadImplPost(
                  data.message.message_id,
                  imageKey,
                  'image',
                  undefined,
                  {
                    appId: creds.appId,
                    appSecret: creds.appSecret,
                    tenantTokenStore: opts.tenantTokenStore!,
                    outDir: opts.inboundImagesDir!,
                  },
                ),
              ),
            );
            const downloadedAttachments: IncomingMessage['attachments'] = [];
            for (let i = 0; i < downloadResults.length; i++) {
              const r = downloadResults[i]!;
              if (r.status === 'fulfilled') {
                downloadedAttachments.push({
                  kind: 'image',
                  localPath: r.value.localPath,
                  mimetype: r.value.mimetype,
                });
              } else {
                log(
                  `[lark] post image download failed (key=${parsed.imageKeys[i]}): ${formatErrorWithCause(r.reason)}`,
                );
              }
            }
            const replyCtxPost: IMReplyContext = {
              imType: 'lark',
              openId: openIdPost,
              chatId: data.message.chat_id,
              messageId: data.message.message_id,
            };
            const parentRawPost = (data.message as { parent_id?: unknown }).parent_id;
            const replyToMessageIdPost =
              typeof parentRawPost === 'string' && parentRawPost.length > 0
                ? parentRawPost
                : undefined;
            const quotedMessagePost =
              replyToMessageIdPost && client
                ? await fetchQuotedMessage(client, replyToMessageIdPost, log)
                : undefined;
            const postMsg: IncomingMessage = {
              msgId: data.message.message_id,
              from: openIdPost,
              text: parsed.text.length > 0 ? parsed.text : null,
              attachments: downloadedAttachments,
              timestamp: Number(data.message.create_time),
              replyToMessageId: replyToMessageIdPost,
              quotedMessage: quotedMessagePost,
              replyCtx: replyCtxPost,
            };
            try {
              await handler.onMessage(postMsg);
            } catch (err) {
              if (handler.onError) {
                await handler.onError(
                  err instanceof Error ? err : new Error(String(err)),
                );
              }
            }
            return;
          }

          // Other non-text types (file / sticker / etc.) still drop silently
          // — out of scope for the audio + image + post DDs. Re-evaluate
          // per type if user reports the "did my message disappear?"
          // symptom for those too.
          if (data.message.message_type !== 'text') {
            log(
              `[lark] dropping non-text message_type=${data.message.message_type} (v1 MVP text + image + post only)`,
            );
            return;
          }

          const openId = data.sender.sender_id?.open_id;
          if (!openId) {
            log(
              `[lark] dropping event missing sender.sender_id.open_id`,
            );
            return;
          }

          let textContent: string;
          try {
            const parsed = JSON.parse(data.message.content) as { text?: unknown };
            if (typeof parsed.text !== 'string') {
              log(
                `[lark] dropping text event with malformed content (no .text string)`,
              );
              return;
            }
            textContent = parsed.text;
          } catch (err) {
            log(
              `[lark] dropping text event with un-parseable content: ${formatErrorWithCause(err)}`,
            );
            return;
          }

          const replyCtx: IMReplyContext = {
            imType: 'lark',
            openId,
            chatId: data.message.chat_id,
            messageId: data.message.message_id,
          };
          const parentRaw = (data.message as { parent_id?: unknown }).parent_id;
          const replyToMessageId =
            typeof parentRaw === 'string' && parentRaw.length > 0 ? parentRaw : undefined;
          const quotedMessage =
            replyToMessageId && client
              ? await fetchQuotedMessage(client, replyToMessageId, log)
              : undefined;
          const msg: IncomingMessage = {
            msgId: data.message.message_id,
            from: openId,
            text: textContent,
            attachments: [],
            timestamp: Number(data.message.create_time),
            replyToMessageId,
            quotedMessage,
            replyCtx,
          };

          try {
            await handler.onMessage(msg);
          } catch (err) {
            // Don't let one handler exception take down the WS event loop;
            // surface via onError + keep accepting events.
            if (handler.onError) {
              await handler.onError(
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          }
        },
        // β.MVP P1 (2026-05-18): `card.action.trigger` subscribe over the
        // same WSClient as `im.message.receive_v1` — see DD #86 §11.6 for
        // the cancel reasoning that this overturns.
        //
        // P5 (2026-05-19): payload zod-parsed against `CardActionEventSchema`
        // (`{action:{value:{kind, ...}}}` per lodestar daemon.ts:206 handleCardAction)
        // and forwarded to `handler.onCardAction`. Adapter returns the
        // handler's `{toast}` so Feishu renders the bubble; parse failure
        // / no-handler / handler-throw all log + return empty (never crash
        // the WS event loop).
        'card.action.trigger': async (data: unknown) => {
          if (!handler.onCardAction) {
            log(
              `[lark] card.action.trigger received (no handler wired) data=${JSON.stringify(
                data,
              ).slice(0, 2000)}`,
            );
            return {};
          }
          const parsed = CardActionEventSchema.safeParse(data);
          if (!parsed.success) {
            log(
              `[lark] card.action.trigger payload failed zod parse: ${parsed.error.message.slice(0, 200)}; raw=${JSON.stringify(
                data,
              ).slice(0, 2000)}`,
            );
            return {};
          }
          try {
            const response = await handler.onCardAction(parsed.data);
            return response ?? {};
          } catch (err) {
            log(
              `[lark] card.action.trigger handler threw: ${formatErrorWithCause(err)}`,
            );
            return {
              toast: {
                type: 'error' as const,
                content: '处理失败，请到 cc TUI 操作',
              },
            };
          }
        },
      });

      // Connection loop with fixed-1s retry + cool-down every 10 failures.
      // Per user feedback 2026-05-14: SDK's exponential backoff (1→2→4→8s)
      // took 4+ minutes to recover from a transient Feishu connect-fail
      // and the daemon's stderr went silent during that wait — looked
      // hung. The new loop logs every attempt, retries fast, and only
      // pauses 5s after a streak of 10 failures (then resets and loops
      // forever — never gives up).
      const RETRY_MS = opts.retryIntervalMs ?? 1000;
      const COOLDOWN_AFTER = opts.cooldownAfter ?? 10;
      const COOLDOWN_MS = opts.cooldownMs ?? 5000;
      let attempt = 0;
      let connected = false;
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });

      // Each `wsClient.start()` invocation either ends in onReady (success)
      // or onError (failure). On failure we re-build a fresh WSClient and
      // call start() again — same pattern WSClient internally uses for its
      // own autoReconnect, just driven by us so we control the timing.
      const callbacks = {
        onReady: () => {
          if (!connected) {
            connected = true;
            log(`[lark] WS connected (after ${attempt + 1} attempt(s))`);
            resolveReady();
          } else {
            log('[lark] WS reconnected — bridge ready');
          }
          attempt = 0;
          // After every successful (re)connect, attach our OWN close
          // listener on the underlying ws so we detect zombie disconnects
          // (TCP half-open, laptop sleep/wake, transient network loss).
          // SDK's internal `wsInstance.on('close') → this.reConnect()` is
          // a no-op because `autoReconnect:false` + `hasEverConnected=true`
          // makes `reConnect()` silent-return (SDK lib/index.js L85525-
          // 85533). Per [DD 2026-05-21 ws-zombie-detection](../../../docs/superpowers/specs/2026-05-21-ws-zombie-detection-dd.md).
          attachCloseDetector();
        },
        onError: (err: Error) => {
          // Surface to handler before we decide to retry — orchestrator
          // log goes to daemon.log either way.
          log(
            `[lark] WS error (attempt ${attempt + 1}): ${formatErrorWithCause(err)}`,
          );
          if (handler.onError) void handler.onError(err);
          scheduleRetry();
        },
        // SDK's autoReconnect is off, so these never fire — kept as no-ops
        // for interface compatibility with the WSClient ctor.
        onReconnecting: () => {},
        onReconnected: () => {},
      };

      /**
       * Attach a close listener on the SDK's underlying ws so any TCP
       * disconnect (clean close or zombie half-open detected by OS) kicks
       * our retry loop. SDK exposes `wsConfig.getWSInstance()` as a public
       * runtime method, but `.d.ts` marks `wsConfig` as `private` —
       * cast through `unknown` to bypass the type-only restriction.
       *
       * Defensive: if SDK shape changes in a future release and we can't
       * reach `wsInstance.on`, log + skip (don't crash). Without this
       * detector the daemon still works during normal operation; it just
       * goes back to needing a manual restart after laptop sleep/wake.
       */
      const attachCloseDetector = (): void => {
        if (stopRequested) return;
        const internal = (
          wsClient as unknown as {
            wsConfig?: {
              getWSInstance?: () =>
                | { on?: (ev: string, cb: () => void) => void }
                | null;
            };
          }
        )?.wsConfig?.getWSInstance?.();
        if (!internal || typeof internal.on !== 'function') {
          log(
            '[lark] WS close-detector NOT attached (SDK shape changed?) — daemon will need manual restart on socket zombie',
          );
          return;
        }
        internal.on('close', () => {
          if (stopRequested) return;
          log(
            '[lark] WS close detected on underlying socket — triggering retry loop',
          );
          scheduleRetry();
        });
      };

      const scheduleRetry = (): void => {
        if (stopRequested) return;
        attempt += 1;
        const inCooldown = attempt % COOLDOWN_AFTER === 0;
        if (inCooldown) {
          log(
            `[lark] 连接失败 ${attempt} 次，冷却 ${
              COOLDOWN_MS >= 1000 ? `${COOLDOWN_MS / 1000}s` : `${COOLDOWN_MS}ms`
            } 后继续重试`,
          );
          retryTimer = setTimeout(tryConnect, COOLDOWN_MS);
        } else {
          retryTimer = setTimeout(tryConnect, RETRY_MS);
        }
      };

      const tryConnect = (): void => {
        if (stopRequested) return;
        retryTimer = null;
        log(`[lark] 连接中... (尝试 ${attempt + 1})`);
        try {
          // Each retry needs a fresh WSClient — re-using a closed one
          // produces "WebSocket already closed" errors on the SDK side.
          wsClient = (opts.buildWSClient ?? buildDefaultWSClient)(
            creds,
            callbacks,
          );
          // start() is async but we don't await it — onReady / onError
          // drive the loop. Awaiting would block the daemon forever on
          // the first failure (start() doesn't return until handshake
          // succeeds OR the SDK gives up — and with autoReconnect:false
          // it gives up after the first failure).
          void wsClient.start({ eventDispatcher: dispatcher }).catch((err) => {
            // start() can also throw synchronously-async (e.g. bad creds)
            // before any callback fires. Treat as an error attempt and
            // continue the loop.
            log(
              `[lark] WS start threw (attempt ${attempt + 1}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            scheduleRetry();
          });
        } catch (err) {
          log(
            `[lark] WS start sync error (attempt ${attempt + 1}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          scheduleRetry();
        }
      };

      log('[lark] connecting to Feishu WS...');
      tryConnect();
      // Block start() until the first onReady fires. After that the loop
      // keeps running in the background for any subsequent disconnects.
      await ready;
    },

    async send(
      content: string,
      replyCtx: IMReplyContext,
      opts: IMSendOptions = {},
    ): Promise<void> {
      if (!started || !client) {
        throw new Error('createLarkAdapter: send() called before start()');
      }
      if (replyCtx.imType !== 'lark') {
        throw new Error(
          `createLarkAdapter: send() got non-lark replyCtx (imType=${replyCtx.imType})`,
        );
      }

      // CardKit single-card path (DD 2026-05-30): the whole cc reply goes
      // into ONE card entity (one markdown element) sent as ONE interactive
      // message. Feishu renders the card's markdown natively (tables, lists,
      // headings, code) and the in-card element order is fixed by structure,
      // so there is NO cross-message reordering — the multi-message split this
      // replaced (splitMarkdownByTableCapacity + mdToCard column_set) was the
      // ordering bug's root cause (Feishu doesn't guarantee order across
      // separate text/interactive messages). `sourceTag` (cc tab / system
      // role) is prefixed once at the top.
      const sourceTag = opts.sourceTag ?? null;
      const bodyMd =
        sourceTag !== null ? `**[${sourceTag}]**\n\n${content}` : content;

      try {
        if (!client.cardkit) {
          throw new Error('cardkit client unavailable — falling back to text');
        }
        const cardJson = {
          schema: '2.0',
          body: { elements: [{ tag: 'markdown', content: bodyMd }] },
        };
        const created = await client.cardkit.v1.card.create({
          data: { type: 'card_json', data: JSON.stringify(cardJson) },
        });
        if (created.code !== 0 || !created.data?.card_id) {
          throw new Error(
            `cardkit card.create failed (code=${created.code}, msg=${created.msg ?? '<empty>'})`,
          );
        }
        const sent = await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: replyCtx.chatId,
            msg_type: 'interactive',
            content: JSON.stringify({
              type: 'card',
              data: { card_id: created.data.card_id },
            }),
          },
        });
        if (sent.code !== 0) {
          throw new Error(
            `lark send card failed (code=${sent.code}, msg=${sent.msg ?? '<empty>'})`,
          );
        }
      } catch (err) {
        // Fallback: cardkit is a 2-call flow (create + send) — a higher
        // failure surface than a single text send. On ANY cardkit failure,
        // degrade to plain text so the reply is never lost. `stripMarkdown`
        // simplifies syntax because Feishu `msg_type:'text'` doesn't render
        // markdown. Classified-log per CLAUDE.md (no silent swallow).
        log(
          `[lark send] cardkit path failed, falling back to text: ${err instanceof Error ? err.message : String(err)}`,
        );
        const stripped = stripMarkdown(bodyMd);
        const response = await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: replyCtx.chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: stripped }),
          },
        });
        if (response.code !== 0) {
          throw new Error(
            `lark send failed (text fallback, code=${response.code}, msg=${response.msg ?? '<empty>'})`,
          );
        }
      }
    },

    async sendAUQ(
      req: IMAUQRequest,
      replyCtx: IMReplyContext,
      sendOpts: IMSendOptions = {},
    ): Promise<void> {
      if (!started || !client) {
        throw new Error('createLarkAdapter: sendAUQ() called before start()');
      }
      if (replyCtx.imType !== 'lark') {
        throw new Error(
          `createLarkAdapter: sendAUQ() got non-lark replyCtx (imType=${replyCtx.imType})`,
        );
      }
      const card = buildAUQCard(req);
      // sourceTag prefixed inside the first element so it shows above
      // the question (consistent with text-path `sendMessage` prefix
      // placement). When tag missing, body stays as buildAUQCard wrote.
      if (sendOpts.sourceTag) {
        const body = card.body as { elements: Record<string, unknown>[] };
        body.elements.unshift({
          tag: 'markdown',
          content: `**[${sendOpts.sourceTag}]**`,
        });
      }
      const response = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: replyCtx.chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      if (response.code !== 0) {
        throw new Error(
          `lark sendAUQ failed (code=${response.code}, msg=${response.msg ?? '<empty>'})`,
        );
      }
    },

    async sendPermission(
      req: IMPermissionRequest,
      replyCtx: IMReplyContext,
      sendOpts: IMSendOptions = {},
    ): Promise<void> {
      if (!started || !client) {
        throw new Error('createLarkAdapter: sendPermission() called before start()');
      }
      if (replyCtx.imType !== 'lark') {
        throw new Error(
          `createLarkAdapter: sendPermission() got non-lark replyCtx (imType=${replyCtx.imType})`,
        );
      }
      const card = buildPermissionCard(req);
      if (sendOpts.sourceTag) {
        const body = card.body as { elements: Record<string, unknown>[] };
        body.elements.unshift({
          tag: 'markdown',
          content: `**[${sendOpts.sourceTag}]**`,
        });
      }
      const response = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: replyCtx.chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      if (response.code !== 0) {
        throw new Error(
          `lark sendPermission failed (code=${response.code}, msg=${response.msg ?? '<empty>'})`,
        );
      }
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      // Signal the retry loop to stop scheduling new attempts before
      // closing the current client — without this a pending retryTimer
      // can fire after wsClient.close() and reconnect a "stopped" daemon.
      stopRequested = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (wsClient) {
        try {
          wsClient.close();
        } catch (err) {
          log(`[lark] stop: WSClient.close threw: ${formatErrorWithCause(err)}`);
        }
        wsClient = undefined;
      }
      client = undefined;
    },
  };
}
