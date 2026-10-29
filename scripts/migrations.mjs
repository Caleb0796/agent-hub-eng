import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function migrate(client, directory = 'migrations') {
  await client.execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  for (const name of (await readdir(directory)).filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
    const tx = await client.transaction('write');
    try {
      const existing = await tx.execute({
        sql: 'SELECT name FROM schema_migrations WHERE name=?',
        args: [name],
      });
      if (!existing.rows.length) {
        // Connection-level foreign keys are already on; this PRAGMA cannot change inside a transaction.
        const sql = (await readFile(join(directory, name), 'utf8')).replace(
          /^PRAGMA foreign_keys = ON;\s*/m,
          '',
        );
        await tx.executeMultiple(sql);
        await tx.execute({
          sql: 'INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)',
          args: [name, Math.floor(Date.now() / 1000)],
        });
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
}
