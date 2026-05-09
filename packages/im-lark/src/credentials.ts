import { z } from 'zod';

/**
 * Persisted credentials for the lark IM adapter (DD #86 §11.1).
 *
 * `appId` + `appSecret` come from the user's self-built (enterprise
 * internal) app in Feishu Open Platform → "凭证与基础信息". Both are
 * long-lived and supplied by the user during `multi-cc-im login lark`.
 *
 * `tenant_access_token` is **derived** from these (2-hour TTL, auto-
 * refreshed by `@larksuiteoapi/node-sdk` via its internal cache) and is
 * NOT persisted — re-acquired on every adapter start.
 *
 * File path: `~/.multi-cc-im/credentials/lark.json` (mode 0600).
 */
export const LarkCredentialsSchema = z.object({
  /** Feishu Open Platform self-built app `app_id` (e.g. `cli_xxxxxxxx`). */
  appId: z.string().min(1),
  /** Feishu Open Platform self-built app `app_secret` (long random string). */
  appSecret: z.string().min(1),
  /** ISO 8601 UTC timestamp when this credential was last validated + saved. */
  savedAt: z.string(),
});

export type LarkCredentials = z.infer<typeof LarkCredentialsSchema>;
