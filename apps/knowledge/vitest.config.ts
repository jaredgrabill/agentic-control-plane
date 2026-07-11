import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Bootstrap, the pgvector adapter, the NATS responder loop, and the
      // Temporal workflow isolate are exercised by the E2E suite against
      // the dev stack; unit tests cover the decision logic directly.
      exclude: ['src/main.ts', 'src/store.ts', 'src/bus.ts', 'src/ingestion-workflows.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
