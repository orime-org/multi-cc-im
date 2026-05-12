import * as lark from '@larksuiteoapi/node-sdk';
import {
  formatErrorWithCause,
  type CredentialStore,
  type IMAdapter,
  type IMHandler,
  type IMReplyContext,
  type IncomingMessage,
} from '@multi-cc-im/shared';
import type { LarkCredentials } from './credentials.js';
import { stripMarkdown } from './markdown.js';

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
            msg_type: 'text';
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
      autoReconnect: true,
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
      });

      // Wrap onReady in a promise so `start()` doesn't resolve until the
      // WebSocket handshake actually succeeds. The SDK's `WSClient.start()`
      // returns after kicking off the connect, NOT after the handshake —
      // confirmed via live log timing (orchestrator's "ready" line fired
      // ~1 s before `[lark] WS connected`). Without this gate, the daemon
      // logs "orchestrator started" while it still can't receive inbound
      // messages; users see their first IM message disappear and have to
      // retry. Per user smoke 2026-05-11.
      //
      // No timeout: SDK auto-reconnects indefinitely on transient network
      // failures. If the network is truly down, the `[lark] WS
      // reconnecting...` log keeps the user informed; they can Ctrl+C to
      // back out. Failing fast with a timeout was rejected in favor of
      // honest status reporting.
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });

      const callbacks = {
        onReady: () => {
          log('[lark] WS connected');
          resolveReady();
        },
        onError: (err: Error) => {
          log(`[lark] WS error: ${formatErrorWithCause(err)}`);
          if (handler.onError) void handler.onError(err);
        },
        onReconnecting: () =>
          log(
            '[lark] WS reconnecting (Feishu network glitch, SDK retrying)...',
          ),
        onReconnected: () => log('[lark] WS reconnected — bridge ready'),
      };

      log('[lark] connecting to Feishu WS...');
      wsClient = (opts.buildWSClient ?? buildDefaultWSClient)(creds, callbacks);
      await wsClient.start({ eventDispatcher: dispatcher });
      // SDK's start() may have returned before the actual handshake. Block
      // until onReady fires so callers can trust "started = bridge ready".
      await ready;
    },

    async send(content: string, replyCtx: IMReplyContext): Promise<void> {
      if (!started || !client) {
        throw new Error('createLarkAdapter: send() called before start()');
      }
      if (replyCtx.imType !== 'lark') {
        throw new Error(
          `createLarkAdapter: send() got non-lark replyCtx (imType=${replyCtx.imType})`,
        );
      }

      // Strip markdown markers — Feishu `msg_type: 'text'` does NOT
      // parse markdown, so cc's `**bold**` / `# heading` / fenced code
      // would render literally. `stripMarkdown` simplifies the syntax
      // to plain text + Unicode framing (▌ / 「」 / •). Per user smoke
      // 2026-05-11.
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
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
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
