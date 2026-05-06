import type { Config, ConfigStore } from '@multi-cc-im/shared';
import { ConfigSchema } from '@multi-cc-im/shared';
import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';
import { atomicWrite } from './atomic-write.js';
import { isENOENT } from './utils.js';

export interface ConfigStoreOpts {
  /** Absolute path to `~/.multi-cc-im/config.toml`. */
  filePath: string;
}

/**
 * TOML-backed ConfigStore. Validates with zod (`ConfigSchema`) on both load
 * and save — fail-fast per `docs/architecture.md`. Save is atomic.
 *
 * On first run, returns the schema's default-populated Config object
 * (empty acl.owners, empty external_paths).
 */
export function createConfigStore(opts: ConfigStoreOpts): ConfigStore {
  const { filePath } = opts;
  return {
    async load(): Promise<Config> {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (err) {
        if (isENOENT(err)) return ConfigSchema.parse({});
        throw err;
      }
      const data = parse(raw);
      return ConfigSchema.parse(data);
    },
    async save(config: Config): Promise<void> {
      const validated = ConfigSchema.parse(config);
      const text = stringify(validated);
      await atomicWrite(filePath, text);
    },
  };
}
