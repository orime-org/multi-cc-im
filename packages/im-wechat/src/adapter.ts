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
 * Reply context 形态（IM-specific）。Bridge core 把 IMAdapter.send 收到的
 * `replyCtx` 原样传回；adapter 内部 cast 到此 shape 取 `to` + `contextToken`
 * 调用 vendored 协议层 sendXxxWeixin。
 *
 * `to` = WeixinMessage.from_user_id（消息发起人 = 我们要回复的目标）
 * `contextToken` = WeixinMessage.context_token（cc-bot reply 必带，否则
 * iLink server 拒收）
 */
export interface WeixinReplyContext {
  to: string;
  contextToken: string | undefined;
}

export interface WeixinAdapterOpts {
  /** ConfigStore 用于将来 [wechat] override 配置（当前未读）*/
  configStore: ConfigStore;
  /** iLink long-poll cursor 持久化（重启续接） */
  cursorStore: CursorStore;
  /**
   * Wechat 凭据存储 —— 跟 Tencent OpenClaw vendor 上游一致的 0600 JSON 文件
   * （见 [DD: credentials 持久化策略](../../docs/superpowers/specs/2026-05-03-keychain-library-dd.md)
   * 与 CLAUDE.md「凭据 0600 落盘」）。`start()` 时 `load()` 取 `bot_token`，
   * 未登录抛错引导用户跑 QR login。
   */
  credentialStore: CredentialStore<WeixinCredentials>;
  /**
   * 入站媒体（image / voice / file / video）解密落盘的根目录。Bridge 决定
   * 策略（通常 `~/.multi-cc-im/inbound/wechat/`）；adapter 在此目录下按 msgId
   * 创建子目录写入解密后的字节。
   */
  inboundMediaDir: string;
}

/**
 * Wechat adapter 满足核心 IMAdapter + 3 项 capability：image / file / typing。
 * VoiceSender 不实现 —— iLink Bot API 没有外发语音端点（仅入站 voice + STT
 * 通过 voice_item.text 字段），bridge 用 `isVoiceSender` 守卫即可识别。
 */
export type WeixinAdapter = IMAdapter & IMImageSender & IMFileSender & IMTypingIndicator;

/**
 * 创建 wechat IMAdapter 实例。
 *
 * 实施按 [adapter 接口设计 DD](../../docs/superpowers/specs/2026-04-29-adapter-interface-dd.md)
 * 锁定的 TS-first hybrid 风格 D：核心 4 method（name/start/send/stop）+
 * capability via extends（image/file/typing）。
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
            /* fire-and-forget; bridge 自己 log */
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
        // bot account 不支持 typing（getConfig 没返 ticket / 失败）→ no-op cancel.
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
        // Fire-and-forget cancel; bridge 通过 handler.onError 接管失败。
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
          /* swallow — abort 时 monitor 抛出是预期 */
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
 * 入站 WeixinMessage → shared/IncomingMessage。
 * - TEXT items：append into `text`
 * - VOICE items with `voice_item.text`（iLink 自带 STT 结果）：append into `text`
 * - VOICE items 无文字：走 downloadMediaFromItem 解密 + silk transcode → `attachments`
 * - IMAGE / FILE：走 downloadMediaFromItem 解密 → `attachments`
 * - VIDEO：shared 没有 `video` kind，下载后映射为 `kind: 'file'` + `mimetype: 'video/mp4'`
 *
 * 返回 null 表示该消息不路由（系统消息 / 无 from_user_id 等）。
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
      // iLink 协议层 STT 结果：直接当文本走，不下载语音原文件。
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
  return {
    msgId,
    from: fromUserId,
    text,
    attachments,
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
    // shared 没有 'video' kind；映射为 file + video/mp4。
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
 * 制造 SaveMediaFn —— 把 buffer 落到 `inboundMediaDir/<msgId>/<random>.<ext>`。
 * 上游 SaveMediaFn 第二参（contentType）我们当前不用来推 ext（vendored
 * downloadMediaFromItem 内部已 mime→ext 决策），把内容写入随机文件名 + 由
 * caller 提供的 originalFilename 来决定后缀（若提供）。
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
