import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The CLI entry is arg plumbing over the tested gate/baseline/runner/
      // record cores. The service IO adapters (pg store, NATS/HTTP action
      // clients, serve bootstrap, token minting) are exercised in E2E against
      // the live stack — the enforcement brain (app.ts) and calibrate math are
      // unit-tested here.
      exclude: [
        'src/main.ts',
        'src/service/serve.ts',
        'src/service/store.ts',
        'src/service/actions.ts',
        'src/service/token.ts',
      ],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
