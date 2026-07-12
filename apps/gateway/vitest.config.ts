import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Process bootstrap and the Temporal adapter are exercised by the
      // E2E suite against the dev stack, not by unit tests (the adapter
      // needs a live cluster; taskWorkflowId is covered directly).
      // budget.ts is the pg IO adapter behind the BudgetAdmission seam (the
      // route logic against a fake is unit-tested; the SQL runs in E2E).
      exclude: ['src/main.ts', 'src/temporal.ts', 'src/budget.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
