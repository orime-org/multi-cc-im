import qrcodeTerminal from 'qrcode-terminal';
import type { CredentialStore } from '@multi-cc-im/shared';
import { DEFAULT_BASE_URL } from '../lib/ilink/auth/accounts.js';
import { createHealthProbedDispatcher } from '../lib/ilink/api/dispatcher.js';
import type { HealthProbedDispatcher } from '../lib/ilink/api/dispatcher.js';
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
      `\nIf the QR code above did not render correctly, open the following URL in a browser to scan it:\n${url}\n\n`,
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
  /**
   * Override the dispatcher factory. Default: real
   * `createHealthProbedDispatcher` (DNS resolve + concurrent TCP probe of
   * iLink LB IPs, picks healthy ones round-robin). Tests inject a stub so
   * they don't touch the network.
   *
   * Per CLAUDE.md "禁止直接用 global fetch 绕开 dispatcher" + DD: iLink
   * dispatcher health probe — Tencent iLink LB has 4 backend IPs of which
   * 1-2 are intermittently dead. Default `dns.lookup` picks one and has no
   * fallback, so login over the bare global fetch fails on every dead-IP
   * roll with `Client network socket disconnected before secure TLS
   * connection was established [ECONNRESET]`.
   */
  createDispatcher?: () => Promise<HealthProbedDispatcher>;
}

/** Hostname used by login QR fetch + status long-poll. Locked in vendor as `https://ilinkai.weixin.qq.com`. */
const LOGIN_HOSTNAME = 'ilinkai.weixin.qq.com';

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

  // Build a health-probed dispatcher up front so both the QR fetch and the
  // subsequent long-poll route only to healthy LB IPs. Without this, default
  // `dns.lookup` picks one of iLink's 4 backend IPs at random; 1-2 are
  // intermittently dead, leaving login fails with TLS ECONNRESET. Always
  // closed in `finally` (even when login throws) so we don't leak the
  // re-probe interval timer.
  const dispatcherFactory =
    opts.createDispatcher ??
    (() => createHealthProbedDispatcher({ hostname: LOGIN_HOSTNAME }));
  const dispatcher = await dispatcherFactory();

  try {
    const startResult = await startWeixinLoginWithQr({
      apiBaseUrl: DEFAULT_BASE_URL,
      dispatcher: dispatcher.agent,
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
      dispatcher: dispatcher.agent,
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
  } finally {
    await dispatcher.stop();
  }
}
