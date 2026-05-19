import * as lark from '@larksuiteoapi/node-sdk';
import {
  formatErrorWithCause,
  type CredentialStore,
  type IMAdapter,
  type IMHandler,
  type IMReplyContext,
  type IMSendOptions,
  type IncomingMessage,
} from '@multi-cc-im/shared';
import type { LarkCredentials } from './credentials.js';
import { stripMarkdown } from './markdown.js';
import { mdToCard, splitMarkdownByTableCapacity } from './md-to-card.js';

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
             * - `'text'` — plain text (`content: JSON.stringify({text})`); used
             *   when `mdToCard` returns null (no table) per β.MVP P3.
             * - `'interactive'` — schema-2.0 card JSON stringified into
             *   `content`; used when `mdToCard` returns a card (md table
             *   detected). Per [P3 strategic DD](../../../docs/superpowers/specs/2026-05-18-multi-cc-im-vs-lodestar-strategic-dd.md).
             */
            msg_type: 'text' | 'interactive';
            content: string;
          };
        }) => Promise<{ code?: number; msg?: string; data?: unknown }>;
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
   * Optional `card.action.trigger` handler — fires when a user clicks
   * a button on an interactive card sent to a chat the bot is in. The
   * event is delivered over the same WebSocket as `im.message.receive_v1`
   * (verified via lodestar source 2026-05-18, formerly assumed
   * webhook-only — see [DD #86 §11.6](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md#116-115-cancel-reasoning-撤销2026-05-18β-mvp-p1)).
   *
   * P1 (this PR) registers the event so callbacks are reachable; the
   * actual UX (PreToolUse three-button approval cards / AUQ option
   * rows) lands in P4 / P5. Default is a log-only stub.
   */
  onCardAction?: (data: unknown) => Promise<void>;
}

/**
 * Build a Lark/Feishu IM adapter satisfying `IMAdapter`. Per
 * [DD #86 §11.4 M3](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md):
 *
 * **Inbound** — `lark.WSClient` long-connection (no public IP needed) +
 * `lark.EventDispatcher` registered for `im.message.receive_v1`. Each
 * inbound text event is normalized to `IncomingMessage` and pushed via
 * `handler.onMessage`. Non-text message types (image / file / audio) are
 * ignored in v1 (DD §8.4 — MVP scope text + interactive cards only).
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

export function createLarkAdapter(opts: CreateLarkAdapterOpts): IMAdapter {
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

          // Other non-text types (image / file / sticker / etc.) still drop
          // silently — out of scope for the audio DD. Re-evaluate per type
          // if user reports the "did my message disappear?" symptom for
          // those too.
          if (data.message.message_type !== 'text') {
            log(
              `[lark] dropping non-text message_type=${data.message.message_type} (v1 MVP text only)`,
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
          const msg: IncomingMessage = {
            msgId: data.message.message_id,
            from: openId,
            text: textContent,
            attachments: [],
            timestamp: Number(data.message.create_time),
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
        // the cancel reasoning that this overturns. P1 registers a
        // log-only stub; P4 wires the real PreToolUse three-button →
        // PermissionResponse handler via `opts.onCardAction`.
        'card.action.trigger': async (data: unknown) => {
          if (opts.onCardAction) {
            try {
              await opts.onCardAction(data);
            } catch (err) {
              log(
                `[lark] card.action.trigger handler threw: ${formatErrorWithCause(err)}`,
              );
            }
          } else {
            log(
              `[lark] card.action.trigger received (no handler wired; P1 stub) data=${JSON.stringify(data).slice(0, 200)}`,
            );
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

      // `sourceTag` is the producer identity (cc tab title, system role)
      // surfaced as a prefix on every chunk. Per
      // [project_future_im_adapters] this is a base-interface concept;
      // bridge passes it as metadata so the adapter can repeat / format
      // it on every chunk (the previous baked-in `[tab]\n` approach only
      // survived chunk[0]).
      const sourceTag = opts.sourceTag ?? null;

      // Try the card path first: if cc's reply contains a GFM table,
      // `mdToCard` emits a Lark Card Kit schema-2.0 card whose tables
      // render as `column_set` rows on mobile. Lark `msg_type: 'text'`
      // doesn't parse md, so a verbatim table would look like garbage
      // (`|...|---|`). Per [β.MVP P3](../../../docs/superpowers/specs/2026-05-18-multi-cc-im-vs-lodestar-strategic-dd.md)
      // (2026-05-18).
      //
      // **Table-limit split (2026-05-19, post-PR-#197 fix)**: Feishu
      // rejects cards containing more than 3 md tables with
      // `code:230099 ErrCode:11310 card table number over limit` (see
      // [[reference_feishu_cardkit_limits]]). We `splitMarkdownByTableCapacity`
      // first; if the reply contains > 3 tables it gets sent as N
      // consecutive IM messages, each ≤ 3 tables and each prefixed
      // with a `**[<sourceTag>] [X/Y]**` section marker so the user
      // knows the reply continues + which cc produced it. Single-chunk
      // replies (≤ 3 tables) prepend just `**[<sourceTag>]**` when a
      // tag was passed; with no tag they stay marker-free to preserve
      // PR #197 surface form.
      const chunks = splitMarkdownByTableCapacity(content);
      const totalChunks = chunks.length;

      if (totalChunks === 0) {
        // splitMarkdownByTableCapacity returns [] only for whitespace /
        // empty input. Defer to the legacy single-shot path so existing
        // behavior (text msg with empty body) doesn't change.
        const stripped = stripMarkdown(content);
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
            `lark send failed (code=${response.code}, msg=${response.msg ?? '<empty>'})`,
          );
        }
        return;
      }

      // Serial send: chunks must arrive in order on the recipient's
      // screen. Parallel sends would let the Feishu frontend reorder
      // them (no msg.sequence guarantee on text/interactive msg_type).
      for (let i = 0; i < totalChunks; i++) {
        const chunk = chunks[i]!;
        // Prefix policy:
        //   - sourceTag + multi-chunk: `**[<tag>] [i+1/N]**\n\n<chunk>`
        //   - sourceTag + single chunk: `**[<tag>]**\n\n<chunk>`
        //   - no sourceTag + multi-chunk: `**[i+1/N]**\n\n<chunk>`
        //   - no sourceTag + single chunk: `<chunk>` (PR #197 surface)
        let prefix = '';
        if (sourceTag !== null && totalChunks > 1) {
          prefix = `**[${sourceTag}] [${i + 1}/${totalChunks}]**\n\n`;
        } else if (sourceTag !== null) {
          prefix = `**[${sourceTag}]**\n\n`;
        } else if (totalChunks > 1) {
          prefix = `**[${i + 1}/${totalChunks}]**\n\n`;
        }
        const bodyMd = `${prefix}${chunk}`;

        const card = mdToCard(bodyMd);
        let response: Awaited<ReturnType<LarkClientShape['im']['v1']['message']['create']>>;
        if (card !== null) {
          response = await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: replyCtx.chatId,
              msg_type: 'interactive',
              content: JSON.stringify(card),
            },
          });
        } else {
          // Strip markdown markers — Feishu `msg_type: 'text'` does NOT
          // parse markdown, so cc's `**bold**` / `# heading` / fenced code
          // would render literally. `stripMarkdown` simplifies the syntax
          // to plain text + Unicode framing (▌ / 「」 / •). Per user smoke
          // 2026-05-11.
          const stripped = stripMarkdown(bodyMd);
          response = await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: replyCtx.chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: stripped }),
            },
          });
        }

        if (response.code !== 0) {
          throw new Error(
            `lark send failed chunk ${i + 1}/${totalChunks} ` +
              `(code=${response.code}, msg=${response.msg ?? '<empty>'})`,
          );
        }
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
