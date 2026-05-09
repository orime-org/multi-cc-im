// @multi-cc-im/im-lark — Lark/Feishu IM adapter (DD #86 §11.4 milestone tracker).
//
// **M2 (current)**: credentials schema + loginLark validation + persistence.
// **M3-M8 (pending)**: createLarkAdapter / IMReplyContext.lark variant fields /
//   interactive card flow / orchestrator wiring.
//
// Adapter (M3) is NOT yet exported — daemon won't start until that's ready.

export { loginLark, type LoginLarkOpts } from './login.js';
export { LarkCredentialsSchema, type LarkCredentials } from './credentials.js';
