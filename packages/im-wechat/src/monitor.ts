import type { CursorStore } from '@multi-cc-im/shared';
import { setTimeout as sleep } from 'node:timers/promises';
import { getUpdates } from '../lib/ilink/api/api.js';
import type { WeixinMessage } from '../lib/ilink/api/types.js';

/**
 * Multi-cc-im 替代 upstream `monitor/monitor.ts`（不 vendor，因深度耦合
 * OpenClaw PluginRuntime + processOneMessage）。
 *
 * 长轮询 iLink getUpdates → 每条消息回调到 onMessage handler → cursor 落到
 * CursorStore。设计上跟 IMAdapter.start(handler) 解耦：monitor 是底层泵，
 * adapter 在外层把 raw WeixinMessage 转为 shared 的 IncomingMessage。
 *
 * CLAUDE.md「关键规范」「iLink 长轮询必须有 timeout（35s+）+ 退避重试 +
 * cursor 持久化」均落实在此函数。
 */

export interface MonitorOpts {
  /** iLink endpoint，由 resolveAccount 给出 */
  baseUrl: string;
  /** iLink bot_token，由 keychain 取出后传入 */
  token: string;
  /** Cursor 持久化（重启续接，不掉消息）— 来自 storage-files */
  cursorStore: CursorStore;
  /** 每条收到的原始 WeixinMessage 回调；adapter 层做后续转换 */
  onMessage: (msg: WeixinMessage) => Promise<void>;
  /** 非致命错误（网络抖动等）通知；致命错误 throw */
  onError?: (err: Error) => void;
  /** 给 caller 用来 stop 的 abort signal */
  abortSignal?: AbortSignal;
}

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * 主泵循环。`abortSignal` aborted 时优雅退出。错误退避指数到 30s 上限。
 */
export async function runMonitor(opts: MonitorOpts): Promise<void> {
  let backoffMs = BACKOFF_INITIAL_MS;

  while (!opts.abortSignal?.aborted) {
    let cursor = (await opts.cursorStore.get()) ?? '';

    try {
      const resp = await getUpdates({
        baseUrl: opts.baseUrl,
        token: opts.token,
        get_updates_buf: cursor,
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
      });

      // 业务错误（session expired 等）走 onError，不退出循环
      if (resp.errcode && resp.errcode !== 0) {
        opts.onError?.(
          new Error(
            `getUpdates errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`,
          ),
        );
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        continue;
      }

      // 成功 → 重置 backoff
      backoffMs = BACKOFF_INITIAL_MS;

      // 推 messages
      for (const msg of resp.msgs ?? []) {
        if (opts.abortSignal?.aborted) return;
        await opts.onMessage(msg);
      }

      // 持久化新 cursor（重启续接）
      if (resp.get_updates_buf !== undefined) {
        await opts.cursorStore.set(resp.get_updates_buf);
      }
    } catch (err) {
      if (opts.abortSignal?.aborted) return;
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }
  }
}
