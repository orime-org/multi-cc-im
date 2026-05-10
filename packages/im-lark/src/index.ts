// @multi-cc-im/im-lark — Lark/Feishu IM adapter (DD #86 §11.4 milestone tracker).
//
// **M2 + M3 + M4 (current)**: credentials schema + loginLark validation +
//   persistence + createLarkAdapter (WSClient long-connection inbound +
//   client.im.v1.message.create outbound) + LarkReplyContext field shape.
// **M5 (pending)**: interactive card rendering for tool-permission flow.
// **M7 (pending)**: orchestrator wiring in apps/multi-cc-im/src/start.ts.
// **M8 (pending)**: docs polish.

export {
  loginLark,
  validateLarkCredentials,
  type LoginLarkOpts,
  type ValidateLarkCredentialsOpts,
  type LarkLoginClientFactory,
} from './login.js';
export { LarkCredentialsSchema, type LarkCredentials } from './credentials.js';
export {
  createLarkAdapter,
  type CreateLarkAdapterOpts,
  type LarkClientShape,
  type LarkWSClientShape,
} from './adapter.js';
export {
  larkSetupSchema,
  buildLarkSetupSchema,
  type BuildLarkSetupSchemaOpts,
} from './setup.js';
