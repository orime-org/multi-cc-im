import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config.js';

const shimDir = fileURLToPath(new URL('./src/openclaw-shim/', import.meta.url));

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      alias: {
        'openclaw/plugin-sdk/infra-runtime': `${shimDir}infra-runtime.ts`,
        'openclaw/plugin-sdk/reply-runtime': `${shimDir}reply-runtime.ts`,
      },
    },
  }),
);
