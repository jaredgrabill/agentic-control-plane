import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Bootstrap and the Postgres/NATS adapters need live infrastructure
      // and are exercised by the E2E suite against the dev stack.
      exclude: ['src/main.ts', 'src/store.ts', 'src/bus.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
