import {
  loginLark,
  LarkCredentialsSchema,
  type LarkCredentials,
} from '@multi-cc-im/im-lark';
import { createCredentialStore } from '@multi-cc-im/storage-files';
import { resolveAppPaths } from './config-paths.js';

export interface RunLoginLarkCommandOpts {
  /** Override `~/.multi-cc-im` root (e.g. `MULTI_CC_IM_HOME` for sandbox tests). */
  root?: string;
  /**
   * `app_id` — required. Caller (CLI dispatcher) sources this from
   * `LARK_APP_ID` env, an explicit `--app-id` arg, or interactive prompt;
   * this runner is non-interactive and just consumes whatever's passed in.
   */
  appId: string;
  /** `app_secret` — required. Same sourcing story as `appId`. */
  appSecret: string;
}

export interface LoginCommandResult {
  exitCode: number;
  stderr: string;
  /** Persisted credentials on success (handy for tests + CLI banners). */
  credentials?: LarkCredentials;
}

/**
 * Implement `multi-cc-im login lark`.
 *
 * Per [DD #86 §11.4 M2](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md):
 * 1. Build a `CredentialStore<LarkCredentials>` rooted at
 *    `<root>/credentials/lark.json` (mode 0600, atomic write — see
 *    [credentials persistence DD](../../../docs/superpowers/specs/2026-05-03-keychain-library-dd.md)).
 * 2. Call `loginLark` from `@multi-cc-im/im-lark`, which validates the
 *    `appId` / `appSecret` pair against Feishu's `auth.v3.tenantAccessToken.internal`
 *    endpoint, then persists `{appId, appSecret, savedAt}` on success.
 * 3. Errors → exit 1 with `stderr` explaining what failed (network, code,
 *    msg, or filesystem).
 *
 * Pure-ish: returns `{exitCode, stderr}` instead of touching `process.*`.
 * The CLI dispatcher in `cli.ts` writes / exits — tests assert on the
 * return value.
 */
export async function runLoginLarkCommand(
  opts: RunLoginLarkCommandOpts,
): Promise<LoginCommandResult> {
  if (opts.appId.trim().length === 0) {
    return {
      exitCode: 2,
      stderr:
        'multi-cc-im login lark: missing app_id. Provide via --app-id <id> or LARK_APP_ID env var.',
    };
  }
  if (opts.appSecret.trim().length === 0) {
    return {
      exitCode: 2,
      stderr:
        'multi-cc-im login lark: missing app_secret. Provide via --app-secret <secret> or LARK_APP_SECRET env var.',
    };
  }

  const paths = opts.root
    ? resolveAppPaths({ env: { MULTI_CC_IM_HOME: opts.root } })
    : resolveAppPaths();

  const credentialStore = createCredentialStore<LarkCredentials>({
    filePath: paths.credentialFor('lark'),
    schema: LarkCredentialsSchema,
  });

  try {
    const credentials = await loginLark({
      appId: opts.appId.trim(),
      appSecret: opts.appSecret.trim(),
      credentialStore,
    });
    return { exitCode: 0, stderr: '', credentials };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      stderr: `multi-cc-im login lark: ${msg}`,
    };
  }
}
