/**
 * Feishu `tenant_access_token` cache.
 *
 * Card Kit v1 endpoints (and other raw REST calls under
 * `https://open.feishu.cn/open-apis/...`) authenticate via a tenant token
 * that the app gets by POSTing `app_id` + `app_secret` to the
 * tenant-token endpoint. Tokens expire after ~2h; the response includes
 * an `expire` field (seconds). We cache the token and refresh ~60s
 * before expiry to ride straight through the rotation without a 401.
 *
 * Separate from the `@larksuiteoapi/node-sdk` `Client`'s OAuth path —
 * OAuth is used for SDK-typed calls (`client.im.v1.message.create` etc.);
 * tenant token is used for raw `fetch` to endpoints the SDK doesn't
 * wrap (e.g. `cardkit/v1`). Both auth paths coexist without conflict.
 *
 * Cache is **per-credential-pair** (keyed by `appId`) so a daemon
 * managing two apps (rare) doesn't reuse one app's token for another.
 *
 * Per [DD #86 §11.6](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md#116-115-cancel-reasoning-撤销2026-05-18β-mvp-p1)
 * (β.MVP P1, 2026-05-18) — cards rely on this; pattern adapted from
 * lodestar (MIT) but rewritten TS-strict.
 */

const FEISHU_TENANT_TOKEN_URL =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

/** Default refresh margin — get a new token this many seconds before stated expiry. */
const REFRESH_MARGIN_SECONDS = 60;

/** Default fallback expiry when Feishu doesn't return an `expire` field (shouldn't happen). */
const FALLBACK_EXPIRE_SECONDS = 7200;

interface TenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  /** Seconds the token is valid for (typically 7200 = 2h). */
  expire?: number;
}

interface CacheEntry {
  token: string;
  /** Absolute ms timestamp at which this token should be refreshed. */
  refreshAt: number;
}

export interface TenantTokenStoreOpts {
  /** Override the HTTP transport. Tests pass a stub matching `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override `Date.now`. Tests inject deterministic time. */
  now?: () => number;
  /** Override the refresh margin (seconds before stated expiry). Default 60. */
  refreshMarginSeconds?: number;
}

export interface TenantTokenStore {
  /**
   * Get a valid tenant token. Hits cache if not yet at refresh
   * threshold; otherwise re-fetches from Feishu. Throws if Feishu
   * returns no token (network error, bad credentials, etc).
   */
  getToken(appId: string, appSecret: string): Promise<string>;
  /** Clear all cached tokens — used by tests + manual auth rotation. */
  clear(): void;
}

/**
 * Create a tenant-token store. Singleton-style — caller usually
 * creates one per daemon and shares across Card Kit + other raw-REST
 * call sites.
 */
export function createTenantTokenStore(
  opts: TenantTokenStoreOpts = {},
): TenantTokenStore {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const marginSec = opts.refreshMarginSeconds ?? REFRESH_MARGIN_SECONDS;
  const cache = new Map<string, CacheEntry>();

  return {
    async getToken(appId: string, appSecret: string): Promise<string> {
      const cached = cache.get(appId);
      if (cached && now() < cached.refreshAt) {
        return cached.token;
      }
      const res = await fetchImpl(FEISHU_TENANT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const data = (await res.json()) as TenantTokenResponse;
      if (!data.tenant_access_token) {
        const reason =
          data.code != null
            ? `code=${data.code} msg="${data.msg ?? '?'}"`
            : 'no tenant_access_token in response';
        throw new Error(`tenant-token fetch failed: ${reason}`);
      }
      const expire = data.expire ?? FALLBACK_EXPIRE_SECONDS;
      const refreshAt = now() + (expire - marginSec) * 1000;
      cache.set(appId, { token: data.tenant_access_token, refreshAt });
      return data.tenant_access_token;
    },
    clear(): void {
      cache.clear();
    },
  };
}
