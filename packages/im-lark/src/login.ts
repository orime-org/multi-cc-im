import * as lark from '@larksuiteoapi/node-sdk';
import { formatErrorWithCause, type CredentialStore } from '@multi-cc-im/shared';
import type { LarkCredentials } from './credentials.js';

export interface LoginLarkOpts {
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
  /** Where to persist the validated credentials. */
  credentialStore: CredentialStore<LarkCredentials>;
  /**
   * Override the SDK client factory. Tests inject a stub so they don't
   * have to mock the entire `@larksuiteoapi/node-sdk` surface or hit the
   * real network. Default constructs `new lark.Client({ ... })` against
   * Feishu CN domain.
   */
  buildClient?: (params: { appId: string; appSecret: string }) => {
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
}

/**
 * Validate `app_id` + `app_secret` against Feishu's open API and persist
 * them to the credential store on success.
 *
 * Validation strategy: ask Feishu for a `tenant_access_token` via
 * `auth.v3.tenantAccessToken.internal`. The Feishu open API returns
 * `code === 0` on success and a non-zero `code` (with a `msg` describing
 * the failure — `app id not exist`, `app secret invalid`, etc.) on
 * credential errors. Network / TLS / DNS failures throw and surface via
 * `formatErrorWithCause` to keep the cause chain visible (per the lessons
 * baked into prior PRs).
 *
 * The returned `tenant_access_token` is **not** persisted — it has a 2 h
 * TTL and the SDK refreshes it internally on every adapter start. We
 * persist only the long-lived `appId` + `appSecret` pair.
 *
 * @throws Error with formatted cause chain when:
 *  - Feishu rejects credentials (non-zero `code`)
 *  - Network error reaches the SDK (`fetch failed (cause: ...)` shape)
 *  - Credential store `save()` fails (e.g. EACCES on the credential file)
 *
 * Per [DD #86 §11.4 M2](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md).
 */
export async function loginLark(opts: LoginLarkOpts): Promise<LarkCredentials> {
  const buildClient =
    opts.buildClient ??
    ((params: { appId: string; appSecret: string }) =>
      new lark.Client({
        appId: params.appId,
        appSecret: params.appSecret,
        domain: lark.Domain.Feishu,
        // We control caching via this function; SDK token cache is fine
        // for the M2 ping but not used for any persisted state.
        disableTokenCache: false,
      }));

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

  const credentials: LarkCredentials = {
    appId: opts.appId,
    appSecret: opts.appSecret,
    savedAt: new Date().toISOString(),
  };
  await opts.credentialStore.save(credentials);
  return credentials;
}
