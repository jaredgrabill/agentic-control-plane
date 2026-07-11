import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The CLI entry is arg plumbing over the tested run/compare cores.
      exclude: ['src/main.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
