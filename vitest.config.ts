import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * The suite runs against a real (in-memory) MongoDB via mongodb-memory-server,
 * so the pricing engine is exercised end to end - the same queries, the same
 * settings singleton, the same rounding - rather than against mocks that could
 * drift from production behaviour.
 *
 * Timeouts are generous because the very first run downloads a mongod binary
 * and every run spins one up in `beforeAll`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/db.setup.ts'],
    // config/env.ts validates required secrets at import time and hard-exits if
    // any are missing. Supply valid dummies for the worker; the real MongoDB
    // connection uses the in-memory server's URI (config/db accepts a uri arg),
    // so this MONGODB_URI is only here to satisfy the schema.
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/autoparts_test',
      JWT_ACCESS_SECRET: 'test_access_secret_key_0123456789',
      JWT_REFRESH_SECRET: 'test_refresh_secret_key_0123456789',
    },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // A single shared mongod and one mongoose connection - keep files serial so
    // the per-test collection wipe can never race another file.
    fileParallelism: false,
  },
});
