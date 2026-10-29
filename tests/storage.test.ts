import { describe, it, expect } from 'vitest';
import { env, runtime, server } from './runtime';
import { Connection, OAuthStore, databaseClient } from '../src/server/storage';
import { fetch as metadataFetch, metadataUrl, isPublicAddress } from '../src/server/public-fetch';
import { migrate } from '../scripts/migrations.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Vercel and Turso runtime boundaries', () => {
  it('rolls back every statement in a failed batch and enforces foreign keys', async () => {
    const key = crypto.randomUUID();
    await expect(
      env.DB.batch([
        env.DB.prepare('INSERT INTO oauth_records(key,value) VALUES(?,?)').bind(key, 'first'),
        env.DB.prepare('INSERT INTO oauth_records(key,value) VALUES(?,?)').bind(key, 'conflict'),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare('SELECT key FROM oauth_records WHERE key=?').bind(key).first(),
    ).toBeNull();
    await expect(
      env.DB.prepare(
        'INSERT INTO browser_sessions(token_hash,user_id,csrf_hash,authenticated_at,expires_at) VALUES(?,?,?,?,?)',
      )
        .bind(key, 'missing-owner', 'csrf', 1, 2)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('expires OAuth values immediately and paginates by literal prefix without losing keys', async () => {
    let now = 1000;
    const store = new OAuthStore(env.DB, () => now),
      prefix = crypto.randomUUID() + '%';
    for (const suffix of ['a', 'b', 'c'])
      await store.put(prefix + suffix, JSON.stringify({ suffix }), { expirationTtl: 10 });
    await store.put(prefix.slice(0, -1) + 'not-matching', 'other');
    expect(await store.get(prefix + 'a', { type: 'json' })).toEqual({ suffix: 'a' });
    const first = await store.list({ prefix, limit: 2 });
    expect(first.list_complete).toBe(false);
    await store.delete(first.keys[1].name);
    const second = await store.list({ prefix, cursor: first.cursor, limit: 2 });
    expect(second.keys.map((x) => x.name)).toEqual([prefix + 'c']);
    now = 1010;
    expect(await store.get(prefix + 'a')).toBeNull();
    expect((await store.list({ prefix })).keys).toEqual([]);
  });

  it('keeps OAuth records when a Node instance is replaced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-hub-storage-'));
    const url = `file:${join(directory, 'test.db')}`;
    const first = databaseClient(url);
    try {
      await migrate(first);
      await new OAuthStore(new Connection(first)).put('restart-proof', 'persistent');
      first.close();
      const replacement = databaseClient(url);
      try {
        await migrate(replacement);
        expect(await new OAuthStore(new Connection(replacement)).get('restart-proof')).toBe(
          'persistent',
        );
      } finally {
        replacement.close();
      }
    } finally {
      first.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects private addresses and non-approved metadata URLs before making a request', async () => {
    for (const address of [
      '127.0.0.1',
      '10.1.1.1',
      '169.254.169.254',
      '192.168.1.2',
      '::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPublicAddress(address), address).toBe(false);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(metadataUrl('https://chatgpt.com/connector-client')).toBeInstanceOf(URL);
    for (const url of [
      'http://chatgpt.com/client',
      'https://evil.example/client',
      'https://chatgpt.com.evil.example/client',
      'https://chatgpt.com:8443/client',
      'https://user:secret@chatgpt.com/client',
    ])
      await expect(metadataFetch(url)).rejects.toThrow(/not approved/);
  });

  it('requires a cron credential and rejects oversized OAuth bodies before storage work', async () => {
    expect((await server.fetch('http://localhost:8789/api/cron/cleanup')).status).toBe(401);
    expect(
      (
        await server.fetch('http://localhost:8789/api/cron/cleanup', {
          headers: { Authorization: 'Bearer test-cron-secret' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await server.fetch('http://localhost:8789/oauth/token', {
          method: 'POST',
          body: 'a'.repeat(100_000),
        })
      ).status,
    ).toBe(413);
    expect(
      (await server.fetch('https://wrong.example/oauth/token', { method: 'POST', body: '' }))
        .status,
    ).toBe(421);
    await runtime.cleanup();
  });
});
