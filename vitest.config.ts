import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// im-wechat vendored ilink lib imports `openclaw/plugin-sdk/{infra,reply}-runtime`
// via tsconfig path alias. Vitest doesn't honor tsconfig paths, so we mirror
// the alias here at the root so apps/* tests (which transitively import
// im-wechat) can resolve the shim too.
const wechatShimDir = fileURLToPath(
  new URL('./packages/im-wechat/src/openclaw-shim/', import.meta.url),
);

export default defineConfig({
  test: {
    globals: false,
    alias: {
      'openclaw/plugin-sdk/infra-runtime': `${wechatShimDir}infra-runtime.ts`,
      'openclaw/plugin-sdk/reply-runtime': `${wechatShimDir}reply-runtime.ts`,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: [
        'apps/*/src/**/*.test.ts',
        'packages/*/src/**/*.test.ts',
        'packages/*/src/**/__tests__/**',
        'apps/*/src/index.ts',
        'packages/*/src/index.ts',
        // Bin entry point with top-level side effects (process.exit). Real
        // logic lives in apps/multi-cc-im/src/{hook,login,start}.ts which ARE tested.
        'apps/multi-cc-im/src/cli.ts',
        // Pure-type files (no runtime code, type-stripped at compile)
        'packages/*/src/adapter/im.ts',
        'packages/*/src/adapter/term.ts',
        'packages/*/src/adapter/cli.ts',
        'packages/im-wechat/src/openclaw-shim/reply-runtime.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
