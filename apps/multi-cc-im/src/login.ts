import { resolveAppPaths } from './config-paths.js';
import {
  adapters as defaultAdapters,
  findAdapter,
  type AdapterRegistryEntry,
} from './adapters.js';

export interface RunLoginCommandOpts {
  /**
   * Adapter id (e.g. `'lark'`). Must exist in the registry passed via
   * `registry` (default: production `adapters` array).
   */
  adapter: string;

  /**
   * Field values keyed by `entry.setupSchema.fields[*].key` (camelCase,
   * e.g. `appId` / `appSecret`). Caller (CLI dispatcher) sources these
   * from `--<flag>` args or env vars and passes them in raw — this
   * function trims strings, runs each through the field's zod schema,
   * and then through the adapter's whole-form `validate` callback.
   */
  values: Record<string, unknown>;

  /** Override `~/.multi-cc-im` root (test sandbox / `MULTI_CC_IM_HOME`). */
  root?: string;

  /** Override the adapter registry (tests inject a stub registry). */
  registry?: readonly AdapterRegistryEntry[];
}

export interface LoginCommandResult {
  exitCode: number;
  stderr: string;
  /** Adapter id on success (handy for CLI banners). */
  adapter?: string;
}

/**
 * Implement the non-interactive `multi-cc-im login <adapter>` shortcut.
 * Routes through the same `entry.setupSchema.validate + entry.persist`
 * path the W4 wizard uses so the persisted JSON file is bit-for-bit
 * identical regardless of which entry point the user chose.
 *
 * Per [DD §10.1 W7](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
 *
 * Pipeline:
 *   1. Resolve `entry = findAdapter(adapter)`. Unknown id → exit 2.
 *   2. Trim string values (user copy-paste hygiene — trailing whitespace
 *      from paste otherwise fails Feishu's strict matcher silently).
 *   3. Per-field `zod.safeParse` on each `entry.setupSchema.fields[*]`.
 *      Failure → exit 2 with the field label + zod issue message.
 *   4. Adapter-level `entry.setupSchema.validate(values)` (live API
 *      check, e.g. Feishu auth.v3.tenantAccessToken.internal). Throw
 *      → exit 1.
 *   5. `entry.persist(values, paths)` — writes JSON to
 *      `<root>/credentials/<adapter>.json` (mode 0600, atomic write).
 *      Failure → exit 1.
 *
 * @returns `{exitCode, stderr, adapter?}`. Pure-ish: never touches
 *  `process.*`; the CLI dispatcher writes / exits.
 */
export async function runLoginCommand(
  opts: RunLoginCommandOpts,
): Promise<LoginCommandResult> {
  const paths = opts.root
    ? resolveAppPaths({ env: { MULTI_CC_IM_HOME: opts.root } })
    : resolveAppPaths();

  const registry = opts.registry ?? defaultAdapters;
  const entry = findAdapter(opts.adapter, registry);
  if (!entry) {
    return {
      exitCode: 2,
      stderr:
        `multi-cc-im login: unknown adapter '${opts.adapter}'\n` +
        `  Available: ${registry.map((a) => a.id).join(', ')}`,
    };
  }

  // Trim strings so trailing whitespace from copy-paste doesn't silently
  // tank Feishu's exact-match credential check.
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts.values)) {
    trimmed[k] = typeof v === 'string' ? v.trim() : v;
  }

  // Per-field zod validation. Mirrors the prompt's `validate` callback
  // path so CLI rejection messages line up with what wizard users see.
  for (const field of entry.setupSchema.fields) {
    const v = trimmed[field.key];
    if (v === undefined || v === '') {
      return {
        exitCode: 2,
        stderr:
          `multi-cc-im login ${opts.adapter}: missing ${field.label}.\n` +
          `  Provide via --${fieldKeyToFlag(field.key)} <value> or ${fieldKeyToEnvVar(entry.id, field.key)} env var.`,
      };
    }
    const parsed = field.schema.safeParse(v);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? 'invalid';
      return {
        exitCode: 2,
        stderr: `multi-cc-im login ${opts.adapter}: ${field.label} invalid — ${issue}`,
      };
    }
    trimmed[field.key] = parsed.data;
  }

  // Adapter-level live-API validation (e.g. Feishu auth ping).
  if (entry.setupSchema.validate) {
    try {
      await entry.setupSchema.validate(trimmed);
    } catch (err) {
      return {
        exitCode: 1,
        stderr: `multi-cc-im login ${opts.adapter}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Persist — single source of truth for the on-disk JSON shape,
  // shared with the wizard's W4/W5 flow.
  try {
    await entry.persist(trimmed, paths);
  } catch (err) {
    return {
      exitCode: 1,
      stderr: `multi-cc-im login ${opts.adapter}: persist failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { exitCode: 0, stderr: '', adapter: opts.adapter };
}

/**
 * Convert a field key (camelCase) to its CLI flag form (kebab-case).
 * Used by both the CLI dispatcher to parse args and by error messages
 * to point users at the right flag. e.g. `appId` → `app-id` → flag
 * `--app-id`; `botToken` → `--bot-token`.
 */
export function fieldKeyToFlag(key: string): string {
  return key.replace(/([A-Z])/g, '-$1').toLowerCase();
}

/**
 * Convert a field key + adapter id to its env-var form
 * (SCREAMING_SNAKE_CASE prefixed with the adapter id). e.g.
 * `('lark', 'appId')` → `LARK_APP_ID`; `('tg', 'botToken')` →
 * `TG_BOT_TOKEN`.
 */
export function fieldKeyToEnvVar(adapterId: string, key: string): string {
  return `${adapterId.toUpperCase()}_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
}
