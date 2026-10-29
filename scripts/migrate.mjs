import { createClient } from '@libsql/client';
import { migrate } from './migrations.mjs';
if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is required');
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
try {
  await migrate(client);
  console.log('Database migrations are current.');
} finally {
  client.close();
}
