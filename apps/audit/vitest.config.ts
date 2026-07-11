import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Bootstrap, the JetStream consume loop, and the Postgres adapter
      // need live infrastructure; the E2E suite exercises them. The
      // message-handling decision logic is unit-tested directly.
      exclude: ['src/main.ts', 'src/store.ts', 'src/loop.ts'],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
