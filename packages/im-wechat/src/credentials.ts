import { z } from 'zod';

/**
 * Wechat credentials shape persisted at `~/.multi-cc-im/credentials/wechat.json`
 * (mode 0600). Per [DD: credentials 持久化策略](../../docs/superpowers/specs/2026-05-03-keychain-library-dd.md)
 * we store on disk in plain JSON behind owner-only file permissions, **not** in
 * an OS keychain — same approach as Tencent OpenClaw vendor upstream.
 *
 * Layout matches OpenClaw upstream's `WeixinAccountData` subset (only the
 * fields we actually need in v1: `token` + `savedAt` for auditability).
 * `baseUrl` / `userId` overrides are out of scope; future ConfigStore
 * `[wechat]` section will own those.
 */
export const WeixinCredentialsSchema = z.object({
  /** iLink bot_token returned by the QR-login flow. */
  token: z.string().min(1),
  /** ISO 8601 timestamp of the last successful save (audit / rotation hint). */
  savedAt: z.string().optional(),
});

export type WeixinCredentials = z.infer<typeof WeixinCredentialsSchema>;
