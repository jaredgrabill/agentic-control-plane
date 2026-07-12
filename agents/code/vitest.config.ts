import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // main.ts is the live worker bootstrap (E2E covers it); eval-report.ts
      // is the CI report emitter CLI whose core (buildReport) IS unit-tested.
      exclude: ['src/main.ts', 'src/eval-report.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
