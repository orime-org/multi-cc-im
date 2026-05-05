import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
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
        'packages/openclaw/src/plugin-sdk/reply-runtime.ts',
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
