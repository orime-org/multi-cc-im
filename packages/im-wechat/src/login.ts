import qrcodeTerminal from 'qrcode-terminal';
import type { CredentialStore } from '@multi-cc-im/shared';
import { DEFAULT_BASE_URL } from '../lib/ilink/auth/accounts.js';
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from '../lib/ilink/auth/login-qr.js';
import type { WeixinCredentials } from './credentials.js';

/**
 * IO sink for the login flow. Bridge core / CLI passes a custom impl when it
 * needs to render somewhere other than `process.stdout` (e.g. into an IM
 * conversation, a TUI panel, a test stub). Default writes the QR via
 * `qrcode-terminal` + a URL fallback line, and prints prompts to stdout.
 */
export interface LoginOutput {
  /** Render the scannable QR for the given URL. */
  renderQR(qrcodeUrl: string): void;
  /** Print a single user-facing line (without trailing newline). */
  println(message: string): void;
}

const defaultOutput: LoginOutput = {
  renderQR: (url) => {
    qrcodeTerminal.generate(url, { small: true });
    process.stdout.write(
      `\n如果上面二维码未能成功展示，请用浏览器打开以下链接扫码：\n${url}\n\n`,
    );
  },
  println: (msg) => process.stdout.write(`${msg}\n`),
};

export interface LoginWechatOpts {
  /** Where to persist the obtained `bot_token` after a successful login. */
  credentialStore: CredentialStore<WeixinCredentials>;
  /**
   * Long-poll wait timeout (ms) before giving up. Vendored default is 8 min;
   * passing through unchanged.
   */
  timeoutMs?: number;
  /** Override IO sink. Defaults to qrcode-terminal + stdout. */
  output?: LoginOutput;
}

/**
 * Drive the wechat QR-login flow end-to-end:
 * 1. Fetch QR from iLink (`startWeixinLoginWithQr`)
 * 2. Render to user (default: qrcode-terminal + URL fallback)
 * 3. Long-poll until status = `confirmed` (`waitForWeixinLogin`, vendored — handles
 *    `wait` / `scaned` / `expired` (auto-refresh ×3) / `scaned_but_redirect` /
 *    `confirmed`)
 * 4. On success, persist `{ token, savedAt }` to `credentialStore` and return
 *
 * Throws on any non-confirm outcome (initial fetch failure / timeout / expired
 * exhausted / server returned no `bot_token`). credentialStore is **not**
 * touched on failure paths.
 */
export async function loginWechat(
  opts: LoginWechatOpts,
): Promise<WeixinCredentials> {
  const output = opts.output ?? defaultOutput;

  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl: DEFAULT_BASE_URL,
  });
  if (!startResult.qrcodeUrl) {
    throw new Error(
      `wechat login start failed: ${startResult.message}`,
    );
  }

  output.println(startResult.message);
  output.renderQR(startResult.qrcodeUrl);

  const waitOpts: Parameters<typeof waitForWeixinLogin>[0] = {
    sessionKey: startResult.sessionKey,
    apiBaseUrl: DEFAULT_BASE_URL,
  };
  if (opts.timeoutMs !== undefined) waitOpts.timeoutMs = opts.timeoutMs;

  const result = await waitForWeixinLogin(waitOpts);

  if (!result.connected || !result.botToken) {
    throw new Error(`wechat login failed: ${result.message}`);
  }

  const credentials: WeixinCredentials = {
    token: result.botToken,
    savedAt: new Date().toISOString(),
  };
  await opts.credentialStore.save(credentials);
  output.println(result.message);

  return credentials;
}
