import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  Attachment,
  AttachmentKind,
  ConfigStore,
  CredentialStore,
  CursorStore,
  IMAdapter,
  IMFileSender,
  IMHandler,
  IMImageSender,
  IMReplyContext,
  IMTypingIndicator,
  IncomingMessage,
} from '@multi-cc-im/shared';
import type { WeixinCredentials } from './credentials.js';
import { WeixinConfigManager } from '../lib/ilink/api/config-cache.js';
import { sendTyping } from '../lib/ilink/api/api.js';
import {
  MessageItemType,
  TypingStatus,
  type MessageItem,
  type WeixinMessage,
} from '../lib/ilink/api/types.js';
import {
  uploadFileAttachmentToWeixin,
  uploadFileToWeixin,
} from '../lib/ilink/cdn/upload.js';
import { downloadMediaFromItem } from '../lib/ilink/media/media-download.js';
import {
  sendFileMessageWeixin,
  sendImageMessageWeixin,
  sendMessageWeixin,
} from '../lib/ilink/messaging/send.js';
import { resolveAccount, type ResolvedAccount } from './accounts.js';
import { runMonitor } from './monitor.js';

/**
 * Reply context shape (IM-specific). Bridge core passes `replyCtx` received from
 * IMAdapter.send back through verbatim; the adapter casts it internally to this
 * shape to extract `to` + `contextToken` and call the vendored protocol layer's
 * sendXxxWeixin functions.
 *
 * `to` = WeixinMessage.from_user_id (the message originator = the target we're
 * replying to).
 * `contextToken` = WeixinMessage.context_token (required for cc-bot replies;
 * iLink server rejects requests without it).
 */
export interface WeixinReplyContext {
  to: string;
  contextToken: string | undefined;
}

export interface WeixinAdapterOpts {
  /** ConfigStore reserved for future [wechat] override config (currently unread). */
  configStore: ConfigStore;
  /** iLink long-poll cursor persistence (resumes after restart). */
  cursorStore: CursorStore;
  /**
   * Wechat credential store — a 0600-mode JSON file matching the Tencent
   * OpenClaw vendor upstream (see [DD: credentials persistence strategy](../../docs/superpowers/specs/2026-05-03-keychain-library-dd.md)
   * and CLAUDE.md "credentials persisted with 0600 permissions"). `start()`
   * calls `load()` to fetch the `bot_token` and throws to guide the user to
   * run QR login if not logged in.
   */
  credentialStore: CredentialStore<WeixinCredentials>;
  /**
   * Root directory for inbound media (image / voice / file / video) decrypted
   * to disk. The bridge picks the policy (typically
   * `~/.multi-cc-im/inbound/wechat/`); the adapter creates a per-msgId
   * subdirectory under this root and writes the decrypted bytes there.
   */
  inboundMediaDir: string;
}

/**
 * The wechat adapter implements the core IMAdapter plus 3 capabilities:
 * image / file / typing. VoiceSender is intentionally not implemented — the
 * iLink Bot API has no outbound voice endpoint (only inbound voice with STT
 * via `voice_item.text`); the bridge can detect this with the `isVoiceSender`
 * type guard.
 */
export type WeixinAdapter = IMAdapter & IMImageSender & IMFileSender & IMTypingIndicator;

/**
 * Create a wechat IMAdapter instance.
 *
 * The implementation follows the TS-first hybrid style D locked in by the
 * [adapter interface design DD](../../docs/superpowers/specs/2026-04-29-adapter-interface-dd.md):
 * 4 core methods (name/start/send/stop) plus capabilities via `extends`
 * (image/file/typing).
 */
export function createWeixinAdapter(opts: WeixinAdapterOpts): WeixinAdapter {
  let abortController: AbortController | undefined;
  let runningTask: Promise<void> | undefined;
  let resolvedAccount: ResolvedAccount | undefined;
  let configMgr: WeixinConfigManager | undefined;

  function ensureStarted(label: string): ResolvedAccount {
    if (!resolvedAccount) {
      throw new Error(`createWeixinAdapter: ${label} called before start()`);
    }
    return resolvedAccount;
  }

  return {
    name: 'wechat',

    async start(handler: IMHandler): Promise<void> {
      if (abortController) {
        throw new Error('createWeixinAdapter: start() called twice');
      }
      const account = await resolveAccount({
        configStore: opts.configStore,
        credentialStore: opts.credentialStore,
      });
      resolvedAccount = account;
      configMgr = new WeixinConfigManager(
        { baseUrl: account.baseUrl, token: account.token },
        () => {
          /* WeixinConfigManager only logs benign cache events; bridge has its own log. */
        },
      );
      abortController = new AbortController();

      runningTask = runMonitor({
        baseUrl: account.baseUrl,
        token: account.token,
        cursorStore: opts.cursorStore,
        abortSignal: abortController.signal,
        onMessage: async (raw) => {
          const incoming = await weixinMessageToIncoming(
            raw,
            account.cdnBaseUrl,
            opts.inboundMediaDir,
            handler,
          );
          if (!incoming) return;
          await handler.onMessage(incoming);
        },
        onError: (err) => {
          handler.onError?.(err).catch(() => {
            /* fire-and-forget; bridge handles its own logging */
          });
        },
      }).catch(async (err) => {
        await handler.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    },

    async send(content: string, replyCtx: IMReplyContext): Promise<void> {
      const account = ensureStarted('send()');
      const ctx = assertReplyContext(replyCtx, 'send');
      await sendMessageWeixin({
        to: ctx.to,
        text: content,
        opts: {
          baseUrl: account.baseUrl,
          token: account.token,
          contextToken: ctx.contextToken,
        },
      });
    },

    async sendImage(localPath: string, replyCtx: IMReplyContext): Promise<void> {
      const account = ensureStarted('sendImage()');
      const ctx = assertReplyContext(replyCtx, 'sendImage');
      const uploaded = await uploadFileToWeixin({
        filePath: localPath,
        toUserId: ctx.to,
        opts: { baseUrl: account.baseUrl, token: account.token },
        cdnBaseUrl: account.cdnBaseUrl,
      });
      await sendImageMessageWeixin({
        to: ctx.to,
        text: '',
        uploaded,
        opts: {
          baseUrl: account.baseUrl,
          token: account.token,
          contextToken: ctx.contextToken,
        },
      });
    },

    async sendFile(localPath: string, replyCtx: IMReplyContext): Promise<void> {
      const account = ensureStarted('sendFile()');
      const ctx = assertReplyContext(replyCtx, 'sendFile');
      const fileName = path.basename(localPath);
      const uploaded = await uploadFileAttachmentToWeixin({
        filePath: localPath,
        fileName,
        toUserId: ctx.to,
        opts: { baseUrl: account.baseUrl, token: account.token },
        cdnBaseUrl: account.cdnBaseUrl,
      });
      await sendFileMessageWeixin({
        to: ctx.to,
        text: '',
        fileName,
        uploaded,
        opts: {
          baseUrl: account.baseUrl,
          token: account.token,
          contextToken: ctx.contextToken,
        },
      });
    },

    async startTyping(replyCtx: IMReplyContext): Promise<() => void> {
      const account = ensureStarted('startTyping()');
      if (!configMgr) throw new Error('createWeixinAdapter: configMgr missing');
      const ctx = assertReplyContext(replyCtx, 'startTyping');

      const cached = await configMgr.getForUser(ctx.to, ctx.contextToken);
      if (!cached.typingTicket) {
        // The bot account doesn't support typing (getConfig returned no ticket / failed) → no-op cancel.
        return () => {};
      }

      await sendTyping({
        baseUrl: account.baseUrl,
        token: account.token,
        body: {
          ilink_user_id: ctx.to,
          typing_ticket: cached.typingTicket,
          status: TypingStatus.TYPING,
        },
      });

      return () => {
        // Fire-and-forget cancel; the bridge takes over failures via handler.onError.
        sendTyping({
          baseUrl: account.baseUrl,
          token: account.token,
          body: {
            ilink_user_id: ctx.to,
            typing_ticket: cached.typingTicket,
            status: TypingStatus.CANCEL,
          },
        }).catch(() => {});
      };
    },

    async stop(): Promise<void> {
      abortController?.abort();
      if (runningTask) {
        await runningTask.catch(() => {
          /* swallow — monitor throwing on abort is expected */
        });
      }
      abortController = undefined;
      runningTask = undefined;
      resolvedAccount = undefined;
      configMgr = undefined;
    },
  };
}

/**
 * Inbound WeixinMessage → shared/IncomingMessage.
 * - TEXT items: appended into `text`
 * - VOICE items with `voice_item.text` (iLink's built-in STT result):
 *   appended into `text`
 * - VOICE items without text: routed through downloadMediaFromItem for
 *   decryption + silk transcoding → `attachments`
 * - IMAGE / FILE: routed through downloadMediaFromItem for decryption →
 *   `attachments`
 * - VIDEO: shared has no `video` kind, so after download we map it to
 *   `kind: 'file'` + `mimetype: 'video/mp4'`
 *
 * Returns null when the message should not be routed (system messages, no
 * from_user_id, etc.).
 */
async function weixinMessageToIncoming(
  msg: WeixinMessage,
  cdnBaseUrl: string,
  inboundMediaDir: string,
  handler: IMHandler,
): Promise<IncomingMessage | null> {
  const fromUserId = msg.from_user_id;
  if (!fromUserId) return null;

  const msgId = String(msg.message_id ?? msg.client_id ?? '');

  const textParts: string[] = [];
  const attachments: Attachment[] = [];
  const saveMedia = makeSaveMedia(inboundMediaDir, msgId);

  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      textParts.push(item.text_item.text);
      continue;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      // iLink protocol-layer STT result: treat as plain text, don't download the original voice file.
      textParts.push(item.voice_item.text);
      continue;
    }
    if (isInboundMediaItem(item)) {
      const att = await downloadAttachment(
        item,
        cdnBaseUrl,
        saveMedia,
        msgId,
        handler,
      );
      if (att) attachments.push(att);
    }
  }

  const text = textParts.length > 0 ? textParts.join('') : null;
  const replyCtx: WeixinReplyContext = {
    to: fromUserId,
    contextToken: msg.context_token,
  };
  return {
    msgId,
    from: fromUserId,
    text,
    attachments,
    replyCtx,
    timestamp: msg.create_time_ms ?? Date.now(),
  };
}

function isInboundMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VOICE ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VIDEO
  );
}

async function downloadAttachment(
  item: MessageItem,
  cdnBaseUrl: string,
  saveMedia: (
    buf: Buffer,
    contentType?: string,
    subdir?: string,
    maxBytes?: number,
    originalFilename?: string,
  ) => Promise<{ path: string }>,
  label: string,
  handler: IMHandler,
): Promise<Attachment | null> {
  const result = await downloadMediaFromItem(item, {
    cdnBaseUrl,
    saveMedia,
    log: () => {},
    errLog: (m) => {
      handler.onError?.(new Error(m)).catch(() => {});
    },
    label: `inbound msg=${label}`,
  });

  if (result.decryptedPicPath) {
    return makeAttachment('image', result.decryptedPicPath, undefined);
  }
  if (result.decryptedVoicePath) {
    return makeAttachment(
      'voice',
      result.decryptedVoicePath,
      result.voiceMediaType,
    );
  }
  if (result.decryptedFilePath) {
    return makeAttachment('file', result.decryptedFilePath, result.fileMediaType);
  }
  if (result.decryptedVideoPath) {
    // shared has no 'video' kind; map to file + video/mp4.
    return makeAttachment('file', result.decryptedVideoPath, 'video/mp4');
  }
  return null;
}

function makeAttachment(
  kind: AttachmentKind,
  localPath: string,
  mimetype: string | undefined,
): Attachment {
  return mimetype === undefined
    ? { kind, localPath }
    : { kind, localPath, mimetype };
}

/**
 * Build a SaveMediaFn — writes the buffer to
 * `inboundMediaDir/<msgId>/<random>.<ext>`. The upstream SaveMediaFn's second
 * argument (contentType) is currently unused for extension inference (the
 * vendored downloadMediaFromItem already handles mime→ext internally); we
 * write the content under a random filename, with the suffix coming from the
 * caller-supplied originalFilename when provided.
 */
function makeSaveMedia(
  rootDir: string,
  msgId: string,
): (
  buf: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }> {
  return async (buf, _contentType, _subdir, _maxBytes, originalFilename) => {
    const dir = path.join(rootDir, msgId || randomBytes(4).toString('hex'));
    await fs.mkdir(dir, { recursive: true });
    const filename = originalFilename
      ? `${randomBytes(4).toString('hex')}-${path.basename(originalFilename)}`
      : `${randomBytes(8).toString('hex')}`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buf);
    return { path: filePath };
  };
}

function assertReplyContext(
  replyCtx: IMReplyContext,
  caller: string,
): WeixinReplyContext {
  if (
    typeof replyCtx === 'object' &&
    replyCtx !== null &&
    'to' in replyCtx &&
    typeof (replyCtx as { to: unknown }).to === 'string'
  ) {
    return replyCtx as WeixinReplyContext;
  }
  throw new Error(
    `WeixinAdapter.${caller}: replyCtx must be { to: string, contextToken?: string }`,
  );
}
