import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One long scenario: platform boot, ingestion, task, audit, kill switch.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // The scenario steps build on each other deliberately.
    sequence: { concurrent: false },
  },
});
