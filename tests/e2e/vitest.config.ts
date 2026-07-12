import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Long scenarios: platform boot, ingestion, tasks, audit, kill switch.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // The scenario steps build on each other deliberately.
    sequence: { concurrent: false },
    // Each file boots the platform on fixed ports — never in parallel.
    fileParallelism: false,
  },
});
