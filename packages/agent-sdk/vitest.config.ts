import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The worker bootstrap needs live Temporal + NATS and is exercised by
      // the E2E suite against the dev stack; telemetry mirrors service-kit's
      // otel.ts exclusion (needs a live collector).
      exclude: ['src/worker.ts', 'src/telemetry.ts', 'src/index.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
