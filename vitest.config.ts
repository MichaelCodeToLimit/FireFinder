import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The first run downloads the gte-small model (~34 MB) into .cache/models.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: 'forks',
  },
});
