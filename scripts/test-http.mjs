import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
  process.env.SIGNUP_MODE = 'invite';
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
  const options = await fetch(`${base}/api/auth/register/options`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: 'httpowner',
      name: 'HTTP test',
      signingKey: Buffer.alloc(32, 1).toString('base64url'),
    }),
  });
  assert.equal(
    options.status,
    403,
    'hosted-style invite gate must reject signup without a valid invite',
  );
  const report = {
    result: 'passed',
    checked_at: new Date().toISOString(),
    adapter: 'actual api/index.mjs Node request listener',
    ui_and_assets: true,
    security_headers: true,
    unauthenticated_owner_rejected: true,
    invite_gate: true,
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
