import type {
  ConfigStore,
  CursorStore,
  IMAdapter,
  IMHandler,
  IMReplyContext,
  IncomingMessage,
} from '@multi-cc-im/shared';
import type { WeixinMessage } from '../lib/ilink/api/types.js';
import { MessageItemType } from '../lib/ilink/api/types.js';
import { sendMessageWeixin } from '../lib/ilink/messaging/send.js';
import { resolveAccount, type ResolvedAccount } from './accounts.js';
import { runMonitor } from './monitor.js';

/**
 * Reply context 形态（IM-specific）。Bridge core 把 IMAdapter.send 收到的
 * `replyCtx` 原样传回；adapter 内部 cast 到此 shape 取 `to` + `contextToken`
 * 调用 vendored sendMessageWeixin。
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
  /** iLink bot_token；caller 从 keychain 取后传入（CLAUDE.md 规范） */
  token: string;
}

/**
 * 创建 wechat IMAdapter 实例。
 *
 * 实施按 [adapter 接口设计 DD](../../docs/superpowers/specs/2026-04-29-adapter-interface-dd.md)
 * 锁定的 TS-first hybrid 风格 D：核心 4 method（name/start/send/stop）
 * + capability via extends（image/file/voice/typing 暂未实现 —— v2 加入）。
 *
 * v1 实现 IMAdapter 核心 4 method，capability interfaces (ImageSender 等)
 * 后续按需 extend。当前仅支持 text reply（multi-cc-im wechat 主流程的最小集）。
 */
export function createWeixinAdapter(opts: WeixinAdapterOpts): IMAdapter {
  let abortController: AbortController | undefined;
  let runningTask: Promise<void> | undefined;
  let resolvedAccount: ResolvedAccount | undefined;

  return {
    name: 'wechat',

    async start(handler: IMHandler): Promise<void> {
      if (abortController) {
        throw new Error('createWeixinAdapter: start() called twice');
      }
      resolvedAccount = await resolveAccount({
        configStore: opts.configStore,
        token: opts.token,
      });
      abortController = new AbortController();

      runningTask = runMonitor({
        baseUrl: resolvedAccount.baseUrl,
        token: resolvedAccount.token,
        cursorStore: opts.cursorStore,
        abortSignal: abortController.signal,
        onMessage: async (raw) => {
          const incoming = weixinMessageToIncoming(raw);
          if (!incoming) return; // 非业务消息（系统类等），跳过
          await handler.onMessage(incoming);
        },
        onError: (err) => {
          handler.onError?.(err).catch(() => {
            /* fire-and-forget; bridge 自己 log */
          });
        },
      })
        .catch(async (err) => {
          await handler.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        });
    },

    async send(content: string, replyCtx: IMReplyContext): Promise<void> {
      if (!resolvedAccount) {
        throw new Error('createWeixinAdapter: send() called before start()');
      }
      const ctx = assertReplyContext(replyCtx);
      await sendMessageWeixin({
        to: ctx.to,
        text: content,
        opts: {
          baseUrl: resolvedAccount.baseUrl,
          token: resolvedAccount.token,
          contextToken: ctx.contextToken,
        },
      });
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
    },
  };
}

/**
 * 把 raw WeixinMessage 转换成 shared/IncomingMessage。
 * 返回 null 时表示该消息不路由（系统消息 / 空 item_list 等）。
 *
 * Reply context 留给 caller（bridge core）从 IncomingMessage.from + 原始
 * WeixinMessage.context_token 自行构造（attachements 在 v2 加 IMImageSender
 * capability 时延伸）。
 */
function weixinMessageToIncoming(msg: WeixinMessage): IncomingMessage | null {
  const fromUserId = msg.from_user_id;
  if (!fromUserId) return null;

  // 拼 text item 的内容（多 text item 罕见但 join 处理）
  const textParts: string[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      textParts.push(item.text_item.text);
    }
  }
  const text = textParts.length > 0 ? textParts.join('') : null;

  // v1 暂不解析 attachment 走 IMAdapter 接口的 attachments 字段；image/voice/file
  // 走 IMImageSender / IMVoiceSender / IMFileSender capability（v2）
  return {
    msgId: String(msg.message_id ?? msg.client_id ?? ''),
    from: fromUserId,
    text,
    attachments: [],
    timestamp: msg.create_time_ms ?? Date.now(),
  };
}

function assertReplyContext(replyCtx: IMReplyContext): WeixinReplyContext {
  if (
    typeof replyCtx === 'object' &&
    replyCtx !== null &&
    'to' in replyCtx &&
    typeof (replyCtx as { to: unknown }).to === 'string'
  ) {
    return replyCtx as WeixinReplyContext;
  }
  throw new Error(
    'WeixinAdapter.send: replyCtx must be { to: string, contextToken?: string }',
  );
}
