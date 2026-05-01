import type { ConfigStore } from '@multi-cc-im/shared';
import {
  CDN_BASE_URL,
  DEFAULT_BASE_URL,
} from '../lib/ilink/auth/accounts.js';

/**
 * Multi-cc-im 单 account 解析。
 *
 * Multi-cc-im 是 owner-only 单租户（CLAUDE.md「关键设计假设」表 ACL + 多机
 * 行硬约束 ✓），不需要 OpenClaw plugin framework 的多 account 索引/存储。
 * 每次调用返回 same {accountId, baseUrl, cdnBaseUrl, token} 4 元组。
 *
 * - `token`: caller 从 OS keychain 取（CLAUDE.md「关键规范」凭据进 keychain），传入
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
  /** iLink bot_token，caller 从 keychain 取后传入 */
  token: string;
}

export async function resolveAccount(
  _opts: ResolveAccountOpts,
): Promise<ResolvedAccount> {
  // _opts.configStore 当前未读 — 未来按需扩展 [wechat] override
  return {
    accountId: 'default',
    baseUrl: DEFAULT_BASE_URL,
    cdnBaseUrl: CDN_BASE_URL,
    token: _opts.token,
  };
}
