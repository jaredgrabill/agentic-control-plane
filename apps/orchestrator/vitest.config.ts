import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Workflow tests run against Temporal's time-skipping test server
    // (downloaded on first use) and bundle workflow code per run.
    testTimeout: 120_000,
    hookTimeout: 240_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Worker bootstrap needs a live cluster; covered by the E2E suite.
      // Workflow code runs inside the Temporal isolate where v8 coverage
      // cannot see it; the workflow tests assert its behavior instead.
      exclude: ['src/main.ts', 'src/workflows.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
