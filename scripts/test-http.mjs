import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
import { migrate } from './migrations.mjs';

const directory = await mkdtemp(join(tmpdir(), 'agent-hub-http-'));
const client = createClient({ url: `file:${join(directory, 'http.db')}` });
let server;
try {
  await migrate(client);
  process.env.TURSO_DATABASE_URL = `file:${join(directory, 'http.db')}`;
  process.env.APP_ENV = 'test';
  process.env.SIGNUP_MODE = 'closed';
  process.env.MESSAGE_KEY_V1 = Buffer.alloc(32, 9).toString('base64url');
  delete process.env.VERCEL;
  const { default: listener } = await import('../api/index.mjs');
  server = createServer(listener);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_ORIGIN = base;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /Agent Hub/);
  const script = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(script);
  assert.match((await fetch(base + script)).headers.get('Content-Type'), /javascript/);
  assert.equal((await fetch(`${base}/api/me`)).status, 401);
  assert.equal((await fetch(`${base}/api/cron/cleanup`)).status, 401);
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const closed = await post('/api/auth/register/options', { name: 'HTTP test' });
  assert.equal(closed.status, 403, 'SIGNUP_MODE=closed must stop new sign-ups');
  assert.equal((await closed.json()).error, 'signup_closed');
  assert.deepEqual(await (await fetch(`${base}/api/auth/signup-status`)).json(), { open: false });
  const discovery = await (await fetch(`${base}/.well-known/agent-hub.json`)).json();
  assert.deepEqual(discovery.tools, ['hub_whoami', 'hub_chats', 'hub_inbox', 'hub_send']);
  assert.equal(discovery.data.end_to_end_encrypted, false);
  for (const platform of ['dot', 'muse', 'duet'])
    assert.equal((await fetch(`${base}/connect/${platform}?format=markdown`)).status, 200);
  const userId = crypto.randomUUID();
  await client.execute({
    sql: 'INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)',
    args: [userId, 'Recovery owner', Math.floor(Date.now() / 1000)],
  });
  const recovery = spawnSync(process.execPath, ['scripts/create-recovery.mjs', '--user', userId], {
    env: { ...process.env, PUBLIC_ORIGIN: base },
    encoding: 'utf8',
  });
  assert.equal(recovery.status, 0, recovery.stderr);
  const link = recovery.stdout.trim().split('\n').at(-1);
  assert.ok(link.startsWith(`${base}/recover#`));
  const recoverOptions = await post('/api/auth/recover/options', {
    token: new URL(link).hash.slice(1),
  });
  assert.equal(
    recoverOptions.status,
    200,
    'a generated recovery link must open passkey registration',
  );
  const report = {
    result: 'passed',
    checked_at: new Date().toISOString(),
    adapter: 'actual api/index.mjs Node request listener',
    ui_and_assets: true,
    security_headers: true,
    unauthenticated_owner_rejected: true,
    signup_closed_switch: true,
    discovery_v2: true,
    recovery_link: true,
    cron_authentication: true,
    live_vercel_deployment: false,
  };
  await writeFile('.output/http-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  client.close();
  await rm(directory, { recursive: true, force: true });
}
