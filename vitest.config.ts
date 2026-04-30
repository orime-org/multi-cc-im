import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/*/src/**/__tests__/**',
        'packages/*/src/index.ts',
        // Pure-type files (no runtime code, type-stripped at compile)
        'packages/*/src/adapter/im.ts',
        'packages/*/src/adapter/term.ts',
        'packages/*/src/adapter/cli.ts',
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
