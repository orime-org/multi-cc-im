import {
  loginWechat,
  WeixinCredentialsSchema,
  type LoginOutput,
  type WeixinCredentials,
} from '@multi-cc-im/im-wechat';
import { createCredentialStore } from '@multi-cc-im/storage-files';
import { resolveAppPaths } from './config-paths.js';

export interface RunLoginWechatCommandOpts {
  /** Override `~/.multi-cc-im` root (e.g. `MULTI_CC_IM_HOME` for sandbox tests). */
  root?: string;
  /**
   * IO sink for QR rendering + status lines. Default in real CLI dispatcher
   * uses `qrcode-terminal` + `process.stdout`; tests pass a stub.
   */
  output?: LoginOutput;
}

export interface LoginCommandResult {
  exitCode: number;
  stderr: string;
}

/**
 * Implement `multi-cc-im login wechat`. Drives the full QR-login flow:
 * 1. Build a `CredentialStore<WeixinCredentials>` rooted at
 *    `<root>/credentials/wechat.json` (mode 0600, atomic write — see
 *    [DD: credentials 持久化策略](../../../docs/superpowers/specs/2026-05-03-keychain-library-dd.md))
 * 2. Call `loginWechat` from `@multi-cc-im/im-wechat`, which fetches the QR,
 *    renders via the supplied `output`, long-polls `iLink` until confirmed,
 *    and saves the resulting `bot_token` to the credential store.
 * 3. Errors → exit 1 with stderr explaining what failed.
 *
 * The function is **pure-ish**: returns `{ exitCode, stderr }` instead of
 * touching `process.*`. CLI dispatcher writes / exits — tests assert on the
 * return value.
 */
export async function runLoginWechatCommand(
  opts: RunLoginWechatCommandOpts = {},
): Promise<LoginCommandResult> {
  const paths = opts.root
    ? resolveAppPaths({ env: { MULTI_CC_IM_HOME: opts.root } })
    : resolveAppPaths();

  const credentialStore = createCredentialStore<WeixinCredentials>({
    filePath: paths.credentialFor('wechat'),
    schema: WeixinCredentialsSchema,
  });

  try {
    await loginWechat({
      credentialStore,
      ...(opts.output ? { output: opts.output } : {}),
    });
    return { exitCode: 0, stderr: '' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stderr: `multi-cc-im login wechat: ${msg}` };
  }
}
