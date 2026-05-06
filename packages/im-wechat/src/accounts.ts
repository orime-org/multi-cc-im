import type { ConfigStore, CredentialStore } from '@multi-cc-im/shared';
import {
  CDN_BASE_URL,
  DEFAULT_BASE_URL,
} from '../lib/ilink/auth/accounts.js';
import type { WeixinCredentials } from './credentials.js';

/**
 * Multi-cc-im single-account resolver.
 *
 * Multi-cc-im is owner-only single-tenant (per CLAUDE.md "Key design assumptions"
 * — ACL + multi-machine row hard constraints), so we don't need OpenClaw plugin
 * framework's multi-account index/storage. Every call returns the same
 * `{accountId, baseUrl, cdnBaseUrl, token}` 4-tuple.
 *
 * - `token`: loaded from `CredentialStore<WeixinCredentials>` (a 0600-mode JSON
 *   file, see [DD: credentials persistence strategy](../../docs/superpowers/specs/2026-05-03-keychain-library-dd.md));
 *   when not logged in, `load()` returns `null` and we throw to guide the user
 *   to run QR login.
 * - `baseUrl` / `cdnBaseUrl`: default to the official iLink endpoint; future
 *   overrides will go through ConfigStore's `[wechat]` section (not implemented
 *   yet).
 */
export interface ResolvedAccount {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
}

export interface ResolveAccountOpts {
  /** ConfigStore reserved for future [wechat] override config; currently unused, declared as a forward-looking dependency. */
  configStore: ConfigStore;
  /** Credentials store; `load()` is called at startup to fetch the `bot_token`. */
  credentialStore: CredentialStore<WeixinCredentials>;
}

export async function resolveAccount(
  opts: ResolveAccountOpts,
): Promise<ResolvedAccount> {
  // opts.configStore is currently unread — extend on demand for [wechat] overrides in the future.
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
