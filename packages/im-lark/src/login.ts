import * as lark from '@larksuiteoapi/node-sdk';
import { formatErrorWithCause } from '@multi-cc-im/shared';

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

/**
 * Pure validation — ask Feishu whether `appId` + `appSecret` are real
 * credentials, throwing on failure. Does **not** persist anything; the
 * caller decides whether/where to write the credential file.
 *
 * This is the function used by the setup-wizard schema's adapter-level
 * `validate(values)` callback (W3+W7), which only needs verification —
 * persistence is handled by `AdapterRegistryEntry.persist` based on the
 * schema's `id`.
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

