import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Sets DATA_DIR to a throwaway folder before a test file imports anything that opens the database.
    setupFiles: ['./test/env.ts'],
    // One process per test file, so each file gets a database of its own.
    pool: 'forks',
  },
});
