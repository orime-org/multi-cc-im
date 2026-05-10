import { z } from 'zod';
import type { AdapterSetupSchema } from '@multi-cc-im/shared';
import {
  validateLarkCredentials,
  type LarkLoginClientFactory,
} from './login.js';

/**
 * Construction-time options for `buildLarkSetupSchema`. The only knob is
 * the SDK client factory used by the adapter-level `validate` callback,
 * exposed so tests can inject a stub instead of hitting `open.feishu.cn`.
 *
 * Per [DD §10.1 W3](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
 */
export interface BuildLarkSetupSchemaOpts {
  /**
   * Override the SDK client factory used by the adapter-level
   * `validate(values)` callback. Tests pass a stub returning a
   * predetermined `code`/`msg`/throw to exercise the success / Feishu-
   * rejection / network-error branches without real network IO.
   *
   * Default: undefined → real `lark.Client` against Feishu CN domain
   * (production behavior).
   */
  buildClient?: LarkLoginClientFactory;
}

/**
 * Build an `AdapterSetupSchema` for the Lark / Feishu IM adapter, with
 * an injectable SDK client factory for testing.
 *
 * Production code can either call this with no arguments (returns a
 * schema using the real Feishu network) or import the convenience
 * `larkSetupSchema` constant exported alongside.
 *
 * **Field shape** (per DD §9.D5 + §9.D4):
 *  - `appId` — non-secret (D4-2: full display when editing). Must start
 *    with `cli_` per Feishu's self-built-app prefix convention.
 *  - `appSecret` — secret (D4-3: AWS-style mask `'*'*16+last_4` when
 *    editing, no echo on input). Free-form non-empty string; Feishu
 *    doesn't publish a fixed length, so we only require non-empty.
 *
 * **Adapter validate** (per DD §9.D5 hybrid pattern):
 *  - Calls `validateLarkCredentials` (live Feishu auth ping). The W4
 *    wizard catches and surfaces the error message back to the prompt
 *    loop, letting the user retry without losing their values.
 *  - Does NOT persist anything — the wizard handles persistence via the
 *    schema's `id` once validate resolves.
 */
export function buildLarkSetupSchema(
  opts: BuildLarkSetupSchemaOpts = {},
): AdapterSetupSchema {
  return {
    id: 'lark',
    displayName: 'Lark / 飞书',
    fields: [
      {
        key: 'appId',
        label: 'App ID',
        hint: 'From Feishu Open Platform → 凭证与基础信息; starts with `cli_`',
        secret: false,
        schema: z.string().trim().min(1).startsWith('cli_'),
      },
      {
        key: 'appSecret',
        label: 'App Secret',
        hint: 'Long random string from the same Credentials page; treat like a password',
        secret: true,
        schema: z.string().trim().min(1),
      },
    ],
    validate: async (values) => {
      const { appId, appSecret } = values as {
        appId: string;
        appSecret: string;
      };
      await validateLarkCredentials({
        appId,
        appSecret,
        buildClient: opts.buildClient,
      });
    },
  };
}

/**
 * Convenience default-injected schema for production use. Equivalent to
 * `buildLarkSetupSchema()` (no test seam). Tests should call
 * `buildLarkSetupSchema(opts)` with a stub `buildClient` instead.
 */
export const larkSetupSchema: AdapterSetupSchema = buildLarkSetupSchema();
