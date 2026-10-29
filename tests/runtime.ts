import { databaseClient } from '../src/server/storage';
import { createRuntime } from '../src/server/runtime';
export const client = databaseClient(':memory:');
export const runtime = createRuntime(
  client,
  {
    APP_ENV: 'test',
    PUBLIC_ORIGIN: 'http://localhost:8789',
    SIGNUP_MODE: 'open',
    CRON_SECRET: 'test-cron-secret',
  },
  { fetch: async () => new Response('API test', { status: 404 }) },
);
export const env = runtime.env;
export const server = { fetch: runtime.fetch };
