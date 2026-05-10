import * as lark from '@larksuiteoapi/node-sdk';
import { formatErrorWithCause, type CredentialStore } from '@multi-cc-im/shared';
import type { LarkCredentials } from './credentials.js';

/**
 * SDK client shape used by both the pure validator and the full login.
 * Extracted as a named type so the test seam is identical wherever the
 * Feishu auth ping is performed.
 */
export type LarkLoginClientFactory = (params: {
  appId: string;
  appSecret: string;
}) => {
  auth: {
    v3: {
      tenantAccessToken: {
        internal: (payload: {
          data: { app_id: string; app_secret: string };
        }) => Promise<{ code?: number; msg?: string; data?: unknown }>;
      };
    };
  };
};

/**
 * Default `LarkLoginClientFactory` — constructs a real `lark.Client`
 * against the Feishu CN domain with token caching enabled (the SDK's
 * own cache, not anything we persist).
 */
const defaultBuildClient: LarkLoginClientFactory = (params) =>
  new lark.Client({
    appId: params.appId,
    appSecret: params.appSecret,
    domain: lark.Domain.Feishu,
    disableTokenCache: false,
  });

export interface ValidateLarkCredentialsOpts {
  /**
   * `app_id` from Feishu Open Platform self-built (enterprise internal) app.
   * Typically starts with `cli_`.
   */
  appId: string;
  /**
   * `app_secret` from the same app. Long random string. The user copies
   * this from the app's "凭证与基础信息" page.
   */
  appSecret: string;
  /**
   * Override the SDK client factory. Tests inject a stub so they don't
   * have to mock the entire `@larksuiteoapi/node-sdk` surface or hit the
   * real network.
   */
  buildClient?: LarkLoginClientFactory;
}

export interface LoginLarkOpts extends ValidateLarkCredentialsOpts {
  /** Where to persist the validated credentials. */
  credentialStore: CredentialStore<LarkCredentials>;
}

/**
 * Pure validation — ask Feishu whether `appId` + `appSecret` are real
 * credentials, throwing on failure. Does **not** persist anything; the
 * caller decides whether/where to write the credential file.
 *
 * Used by both `loginLark` (which adds persistence on top) and the
 * setup-wizard schema's adapter-level `validate(values)` callback (W3),
 * which only needs verification — the wizard handles persistence
 * centrally based on the schema's `id`.
 *
 * Validation strategy: request a `tenant_access_token` via
 * `auth.v3.tenantAccessToken.internal`. Feishu returns `code === 0` on
 * success; non-zero `code` (with `msg` like `app id not exist`,
 * `app secret invalid`) means the credentials are wrong. Network / TLS /
 * DNS failures throw and surface via `formatErrorWithCause` so the cause
 * chain is preserved.
 *
 * @throws Error with formatted cause chain when:
 *  - Feishu rejects credentials (non-zero `code`)
 *  - Network error reaches the SDK (`fetch failed (cause: ...)` shape)
 */
export async function validateLarkCredentials(
  opts: ValidateLarkCredentialsOpts,
): Promise<void> {
  const buildClient = opts.buildClient ?? defaultBuildClient;

  const client = buildClient({
    appId: opts.appId,
    appSecret: opts.appSecret,
  });

  let response: { code?: number; msg?: string; data?: unknown };
  try {
    response = await client.auth.v3.tenantAccessToken.internal({
      data: {
        app_id: opts.appId,
        app_secret: opts.appSecret,
      },
    });
  } catch (err) {
    throw new Error(
      `lark login failed (network / SDK error): ${formatErrorWithCause(err)}`,
    );
  }

  if (response.code !== 0) {
    throw new Error(
      `lark login failed: Feishu rejected credentials (code=${response.code}, msg=${response.msg ?? '<empty>'})`,
    );
  }
}

/**
 * Validate `app_id` + `app_secret` against Feishu's open API and persist
 * them to the credential store on success. Equivalent to
 * `validateLarkCredentials` followed by `credentialStore.save()`.
 *
 * The returned `tenant_access_token` is **not** persisted — it has a 2 h
 * TTL and the SDK refreshes it internally on every adapter start. Only
 * the long-lived `appId` + `appSecret` pair are persisted.
 *
 * @throws Same as `validateLarkCredentials`, plus credential store
 *  `save()` failures (e.g. EACCES on the credential file).
 *
 * Per [DD #86 §11.4 M2](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md).
 */
export async function loginLark(opts: LoginLarkOpts): Promise<LarkCredentials> {
  await validateLarkCredentials({
    appId: opts.appId,
    appSecret: opts.appSecret,
    buildClient: opts.buildClient,
  });

  const credentials: LarkCredentials = {
    appId: opts.appId,
    appSecret: opts.appSecret,
    savedAt: new Date().toISOString(),
  };
  await opts.credentialStore.save(credentials);
  return credentials;
}
