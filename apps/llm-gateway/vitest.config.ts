import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // main.ts is the live bootstrap (bus, JWKS, kill-switch watcher) —
      // exercised by the E2E suite against the dev stack.
      exclude: ['src/main.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
