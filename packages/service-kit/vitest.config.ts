import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Infrastructure adapters need a live bus/collector and are exercised
      // by the E2E suite against the dev stack, not by unit tests.
      exclude: ['src/nats.ts', 'src/otel.ts', 'src/index.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
