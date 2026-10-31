import { databaseClient } from '../src/server/storage';
import { createRuntime } from '../src/server/runtime';
export const client = databaseClient(':memory:');
// A fixed, test-only message key; never used outside the in-memory test database.
export const TEST_MESSAGE_KEY = 'dGVzdC1vbmx5LW1lc3NhZ2Uta2V5LTMyLWJ5dGVzISE';
export const runtime = createRuntime(
  client,
  {
    APP_ENV: 'test',
    PUBLIC_ORIGIN: 'http://localhost:8789',
    SIGNUP_MODE: 'open',
    SIGNUP_DAILY_CAP: 200,
    MESSAGE_KEYS: { 1: TEST_MESSAGE_KEY },
    CRON_SECRET: 'test-cron-secret',
    RUNNER_DAILY_CAP: 100000,
  },
  { fetch: async () => new Response('API test', { status: 404 }) },
);
export const env = runtime.env;
export const server = { fetch: runtime.fetch };
