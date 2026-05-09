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
export function createLarkAdapter(opts: CreateLarkAdapterOpts): IMAdapter {
  const log = opts.log ?? (() => {});

  let wsClient: LarkWSClientShape | undefined;
  let client: LarkClientShape | undefined;
  let started = false;

  function buildDefaultClient(creds: LarkCredentials): LarkClientShape {
    return new lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: lark.Domain.Feishu,
      disableTokenCache: false,
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
          // Filter to text only in v1 MVP (DD §8.4). Other message_type
          // values drop silently — bridge router already logs visible echo
          // for "no addressable cc" / "not found" so users won't be left
          // confused; non-text input simply isn't routed.
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

      const callbacks = {
        onReady: () => log('[lark] WS connected'),
        onError: (err: Error) => {
          log(`[lark] WS error: ${formatErrorWithCause(err)}`);
          if (handler.onError) void handler.onError(err);
        },
        onReconnecting: () => log('[lark] WS reconnecting...'),
        onReconnected: () => log('[lark] WS reconnected'),
      };

      wsClient = (opts.buildWSClient ?? buildDefaultWSClient)(creds, callbacks);
      await wsClient.start({ eventDispatcher: dispatcher });
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

      const response = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: replyCtx.chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: content }),
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
