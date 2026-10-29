import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { databaseClient } from './storage';
import { createRuntime } from './runtime';

export function fileAssets(root = resolve('dist')): Env['ASSETS'] {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  return {
    async fetch(request) {
      let path: string;
      try {
        path = resolve(root, '.' + decodeURIComponent(new URL(request.url).pathname));
      } catch {
        return new Response(null, { status: 400 });
      }
      if (!path.startsWith(root + '/')) return new Response(null, { status: 404 });
      try {
        return new Response(await readFile(path), {
          headers: { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    },
  };
}

export function runtimeFromEnvironment(waitUntil?: (promise: Promise<unknown>) => void) {
  const hosted = process.env.VERCEL === '1';
  const APP_ENV = hosted ? 'production' : (process.env.APP_ENV ?? 'development');
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN;
  if (!url || !PUBLIC_ORIGIN) throw new Error('TURSO_DATABASE_URL and PUBLIC_ORIGIN are required');
  if (hosted && (!token || !/^libsql:\/\//.test(url)))
    throw new Error('Hosted deployment requires a remote Turso database');
  if (hosted && process.env.SIGNUP_MODE !== 'invite')
    throw new Error('Hosted alpha requires invite-only registration');
  const client = databaseClient(url, token);
  return createRuntime(
    client,
    {
      APP_ENV,
      PUBLIC_ORIGIN,
      SIGNUP_MODE: process.env.SIGNUP_MODE ?? 'invite',
      CRON_SECRET: process.env.CRON_SECRET,
    },
    fileAssets(),
    waitUntil,
  );
}
