import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entrypoints bind real ports; the HTTP door is exercised by the E2E
      // suite (its directive plumbing is unit-tested via failure.ts).
      exclude: [
        'src/cloud/main.ts',
        'src/forge/main.ts',
        'src/netsec/main.ts',
        'src/a2a/main.ts',
        'src/shared/http.ts',
        'src/index.ts',
      ],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
