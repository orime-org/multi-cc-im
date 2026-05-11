import { join } from 'node:path';
import {
  createLarkAdapter,
  LarkCredentialsSchema,
  larkSetupSchema,
  type LarkCredentials,
} from '@multi-cc-im/im-lark';
import type { AdapterSetupSchema, IMAdapter } from '@multi-cc-im/shared';
import { createCredentialStore } from '@multi-cc-im/storage-files';
import type { AppPaths } from './config-paths.js';
import { defaultDocsDir } from './wizard/guide.js';

/**
 * Single source of truth for "which IM adapters this binary can wire up".
 * Adding a new adapter = adding one entry to `adapters` (no other CLI / start
 * code changes required, modulo test-stub adapters used by the start-test
 * harness).
 *
 * Each entry encapsulates everything CLI side needs to:
 *  - render the adapter-selection menu (`id`, `setupSchema.displayName`)
 *  - run the schema-driven wizard (`setupSchema`)
 *  - persist the wizard's output into `~/.multi-cc-im/credentials/<id>.json`
 *    (`buildPersistShape` adds adapter-specific metadata like `savedAt`)
 *  - construct the runtime IM adapter from the persisted credentials
 *    (`buildAdapterRuntime`)
 *
 * Per [DD §10.1 W5](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
 */
export interface AdapterRegistryEntry {
  /** Stable adapter id; used as the credential filename root and `start <id>`. */
  id: string;

  /** W2 schema-driven setup contract; consumed by the W4 wizard. */
  setupSchema: AdapterSetupSchema;

  /**
   * Convert the wizard's `Record<string, unknown>` into the JSON shape
   * actually persisted to `~/.multi-cc-im/credentials/<id>.json`. Each
   * adapter adds its own metadata here (e.g. lark adds `savedAt`).
   *
   * Exposed mainly for tests; production code calls `persist` (which
   * applies this shape internally before writing).
   */
  buildPersistShape: (
    values: Record<string, unknown>,
  ) => Record<string, unknown>;

  /**
   * Persist wizard values to `~/.multi-cc-im/credentials/<id>.json` via
   * the adapter's typed credential store. Encapsulates the per-adapter
   * Zod schema so `start.ts` / the selector don't need to know about
   * `LarkCredentialsSchema` etc.
   */
  persist: (
    values: Record<string, unknown>,
    paths: AppPaths,
  ) => Promise<void>;

  /**
   * Construct the runtime IM adapter from already-persisted credentials.
   * Encapsulates the per-adapter `createCredentialStore<T>` typing +
   * factory call so `start.ts` doesn't have to switch on `id`.
   */
  buildAdapterRuntime: (opts: {
    paths: AppPaths;
    log: (line: string) => void;
  }) => IMAdapter;

  /**
   * Absolute path to a markdown guide rendered inline before the W4
   * wizard's first prompt. Optional — adapters without a guide skip
   * the W6 hook silently. Per
   * [DD §10.1 W6](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
   */
  guideDocPath?: string;
}

function buildLarkPersistShape(
  values: Record<string, unknown>,
): LarkCredentials {
  const v = values as { appId: string; appSecret: string };
  return {
    appId: v.appId,
    appSecret: v.appSecret,
    savedAt: new Date().toISOString(),
  };
}

const larkEntry: AdapterRegistryEntry = {
  id: 'lark',
  setupSchema: larkSetupSchema,
  buildPersistShape: buildLarkPersistShape,
  persist: async (values, paths) => {
    const credentialStore = createCredentialStore<LarkCredentials>({
      filePath: paths.credentialFor('lark'),
      schema: LarkCredentialsSchema,
    });
    await credentialStore.save(buildLarkPersistShape(values));
  },
  buildAdapterRuntime: ({ paths, log }) => {
    const credentialStore = createCredentialStore<LarkCredentials>({
      filePath: paths.credentialFor('lark'),
      schema: LarkCredentialsSchema,
    });
    return createLarkAdapter({ credentialStore, log });
  },
  guideDocPath: join(defaultDocsDir(), 'setup-feishu.md'),
};

/**
 * Adapter registry for production builds. Tests can construct their own
 * arrays for fixtures (e.g. a fake adapter that doesn't need the network).
 */
export const adapters: readonly AdapterRegistryEntry[] = [larkEntry];

/**
 * Look up a registry entry by id. Returns `undefined` for unknown ids;
 * caller renders the user-facing "unsupported adapter" error with the
 * known ids list.
 */
export function findAdapter(
  id: string,
  registry: readonly AdapterRegistryEntry[] = adapters,
): AdapterRegistryEntry | undefined {
  return registry.find((a) => a.id === id);
}
