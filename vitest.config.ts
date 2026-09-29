import { defineConfig } from 'vitest/config';

// Phase 27 test runner. `envDir` points at a directory that holds no .env files, so tests never load the
// repository's .env* files (production values); integration tests reach only the guarded local stack.
export default defineConfig({
  envDir: 'tests/no-env',
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
