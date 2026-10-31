import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';

// Re-encrypts message, draft, grant and report bodies with the newest MESSAGE_KEY_V<n> after a key is added.
// Format matches src/server/vault.ts: base64url(iv | ciphertext | tag), AAD bound to the row.
const keys = new Map();
for (const [name, value] of Object.entries(process.env)) {
  const match = /^MESSAGE_KEY_V(\d{1,3})$/.exec(name);
  if (match && value) keys.set(Number(match[1]), Buffer.from(value, 'base64url'));
}
if (!keys.size) throw new Error('No MESSAGE_KEY_V<n> configured');
const current = Math.max(...keys.keys());
const open = (text, aad, version) => {
  const raw = Buffer.from(text, 'base64url'),
    d = createDecipheriv('aes-256-gcm', keys.get(version), raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
};
const seal = (plain, aad) => {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', keys.get(current), iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url');
};
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
let count = 0;
try {
  for (const [table, prefix, scope] of [
    ['messages', 'message', 'chat_id'],
    ['drafts', 'draft', 'chat_id'],
    ['agent_grants', 'grant', 'agent_id'],
    ['agent_reports', 'report', 'chat_id'],
  ]) {
    const rows = await client.execute({
      sql: `SELECT id,${scope} AS scope,ciphertext,key_version FROM ${table} WHERE key_version<>?`,
      args: [current],
    });
    for (const r of rows.rows) {
      const aad = `${prefix}|${r.scope}|${r.id}`;
      await client.execute({
        sql: `UPDATE ${table} SET ciphertext=?,key_version=? WHERE id=? AND key_version=?`,
        args: [
          seal(open(r.ciphertext, aad, Number(r.key_version)), aad),
          current,
          r.id,
          r.key_version,
        ],
      });
      count++;
    }
  }
} finally {
  client.close();
}
console.log(`Re-encrypted ${count} rows with key version ${current}.`);
