import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createClient } from '@libsql/client';

// Creates short-lived, single-use signup invitations. Only SHA-256 hashes are stored;
// the raw tokens are printed once and never written to disk.
const { values } = parseArgs({
  options: { count: { type: 'string', default: '1' }, hours: { type: 'string', default: '72' } },
});
const count = Number(values.count),
  hours = Number(values.hours);
if (!Number.isInteger(count) || count < 1 || count > 20)
  throw new Error('--count must be an integer from 1 to 20');
if (!Number.isFinite(hours) || hours <= 0 || hours > 168)
  throw new Error('--hours must be greater than 0 and at most 168');
const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken, PUBLIC_ORIGIN } = process.env;
if (!url || !PUBLIC_ORIGIN) throw new Error('TURSO_DATABASE_URL and PUBLIC_ORIGIN are required');

const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
const tokens = Array.from({ length: count }, () => randomBytes(32).toString('base64url'));
const client = createClient({ url, authToken });
try {
  await client.batch(
    tokens.map((token) => ({
      sql: 'INSERT INTO signup_invites(token_hash,expires_at) VALUES(?,?)',
      args: [createHash('sha256').update(token, 'utf8').digest('hex'), expiresAt],
    })),
    'write',
  );
} finally {
  client.close();
}
const origin = new URL(PUBLIC_ORIGIN).origin;
console.log(
  `Created ${count} invitation(s), expiring ${new Date(expiresAt * 1000).toISOString()}:`,
);
for (const token of tokens) console.log(`${origin}/#signupInvite=${token}`);
