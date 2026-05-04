import type { ConfigStore, CredentialStore } from '@multi-cc-im/shared';
import {
  CDN_BASE_URL,
  DEFAULT_BASE_URL,
} from '../lib/ilink/auth/accounts.js';
import type { WeixinCredentials } from './credentials.js';

/**
 * Multi-cc-im 单 account 解析。
 *
 * Multi-cc-im 是 owner-only 单租户（CLAUDE.md「关键设计假设」表 ACL + 多机
 * 行硬约束 ✓），不需要 OpenClaw plugin framework 的多 account 索引/存储。
 * 每次调用返回 same `{accountId, baseUrl, cdnBaseUrl, token}` 4 元组。
 *
 * - `token`: 从 `CredentialStore<WeixinCredentials>` 加载（0600 JSON 文件，
 *   见 [DD: credentials 持久化策略](../../docs/superpowers/specs/2026-05-03-keychain-library-dd.md)）；
 *   未登录时 `load()` 返回 `null` → 抛错引导用户跑 QR login
 * - `baseUrl` / `cdnBaseUrl`: 默认 iLink 官方 endpoint；未来想 override 走 ConfigStore
 *   的 `[wechat]` section 扩展（暂不实施）
 */
export interface ResolvedAccount {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
}

export interface ResolveAccountOpts {
  /** ConfigStore 用来未来读 [wechat] override 配置；当前未访问，预留依赖 */
  configStore: ConfigStore;
  /** Credentials 存储；启动时 `load()` 取 `bot_token` */
  credentialStore: CredentialStore<WeixinCredentials>;
}

export async function resolveAccount(
  opts: ResolveAccountOpts,
): Promise<ResolvedAccount> {
  // opts.configStore 当前未读 — 未来按需扩展 [wechat] override
  const creds = await opts.credentialStore.load();
  if (!creds) {
    throw new Error(
      'wechat credentials not found — run `multi-cc-im login wechat` (QR scan) first',
    );
  }
  return {
    accountId: 'default',
    baseUrl: DEFAULT_BASE_URL,
    cdnBaseUrl: CDN_BASE_URL,
    token: creds.token,
  };
}
