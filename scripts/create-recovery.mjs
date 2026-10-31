import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createClient } from '@libsql/client';

// Issues a one-time account recovery link after the operator has verified the owner
// out of band. Only the hash is stored; the link is printed once. Using it registers a
// new passkey and removes every previous passkey and session of that owner.
const { values } = parseArgs({
  options: { user: { type: 'string' }, hours: { type: 'string', default: '24' } },
});
const hours = Number(values.hours);
if (!values.user || !/^[0-9a-f-]{36}$/.test(values.user))
  throw new Error('--user <owner id> is required');
if (!Number.isFinite(hours) || hours <= 0 || hours > 72)
  throw new Error('--hours must be within 0-72');
const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken, PUBLIC_ORIGIN } = process.env;
if (!url || !PUBLIC_ORIGIN) throw new Error('TURSO_DATABASE_URL and PUBLIC_ORIGIN are required');

const token = randomBytes(32).toString('base64url'),
  at = Math.floor(Date.now() / 1000),
  expiresAt = at + Math.floor(hours * 3600);
const client = createClient({ url, authToken });
try {
  const user = await client.execute({
    sql: 'SELECT id FROM users WHERE id=? AND deleted_at IS NULL',
    args: [values.user],
  });
  if (!user.rows.length) throw new Error('No active owner with that id');
  await client.batch(
    [
      {
        sql: 'INSERT INTO recovery_links(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',
        args: [
          createHash('sha256').update(token, 'utf8').digest('hex'),
          values.user,
          at,
          expiresAt,
        ],
      },
      {
        sql: 'INSERT INTO audit_events(id,event_type,owner_id,agent_id,entity_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
        args: [randomUUID(), 'recovery_link_issued', values.user, null, values.user, '{}', at],
      },
    ],
    'write',
  );
} finally {
  client.close();
}
console.log(`Recovery link (expires ${new Date(expiresAt * 1000).toISOString()}):`);
console.log(`${new URL(PUBLIC_ORIGIN).origin}/recover#${token}`);
