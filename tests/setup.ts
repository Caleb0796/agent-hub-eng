import { beforeAll, afterAll } from 'vitest';
import { client } from './runtime';
import { migrate } from '../scripts/migrations.mjs';
beforeAll(async () => {
  await migrate(client);
});
afterAll(() => {
  client.close();
});
