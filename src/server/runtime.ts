import type { Client } from '@libsql/client';
import handler, { cleanup, errorResponse, headers } from './index';
import { boundedRequest, wrongOrigin } from './common';
import { Connection, OAuthStore } from './storage';
import './env';

export type RuntimeSettings = Pick<
  Env,
  'PUBLIC_ORIGIN' | 'APP_ENV' | 'SIGNUP_MODE' | 'SIGNUP_DAILY_CAP' | 'MESSAGE_KEYS' | 'CRON_SECRET'
>;

export function createRuntime(
  client: Client,
  settings: RuntimeSettings,
  assets: Env['ASSETS'],
  waitUntil?: (promise: Promise<unknown>) => void,
) {
  const bindings = (connection: Connection): Env => ({
    ...settings,
    DB: connection,
    OAUTH_KV: new OAuthStore(connection) as unknown as KVNamespace,
    ASSETS: assets,
  });
  const env = bindings(new Connection(client));
  let oauthQueue = Promise.resolve();
  const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    // Node adapters can supply a lightweight Request without the native internal
    // slots required by new Request(input). Copy its public fields explicitly.
    let request =
      typeof input === 'string' || input instanceof URL
        ? new Request(input, init)
        : new Request(input.url, {
            method: input.method,
            headers: input.headers,
            signal: input.signal,
            body: ['GET', 'HEAD'].includes(input.method) ? undefined : input.body,
            duplex: 'half',
            ...init,
          } as RequestInit);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    // Do not hold the database write lock while receiving an untrusted body.
    try {
      if (wrongOrigin(request, env))
        return headers(Response.json({ error: 'wrong_origin' }, { status: 421 }));
      request = await boundedRequest(request);
    } catch (error) {
      return headers(errorResponse(error, env));
    }
    const path = new URL(request.url).pathname;
    // Authorization-code consumption and refresh rotation must be atomic across Node
    // instances. Keep the provider's reads/writes and owner mutations in one transaction.
    const atomic =
      request.method === 'POST' && (path === '/authorize' || path.startsWith('/oauth/'));
    let release: (() => void) | undefined;
    if (atomic) {
      const previous = oauthQueue;
      oauthQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
    }
    let tx: Awaited<ReturnType<Client['transaction']>> | undefined;
    try {
      if (atomic) tx = await client.transaction('write');
      const response = await handler.fetch(request, tx ? bindings(new Connection(tx)) : env, ctx);
      if (tx) {
        await Promise.all(pending);
        if (response.status >= 500) await tx.rollback();
        else await tx.commit();
      } else if (waitUntil) {
        for (const promise of pending) waitUntil(promise);
      } else await Promise.all(pending);
      return response;
    } catch (error) {
      if (tx && !tx.closed) await tx.rollback();
      throw error;
    } finally {
      tx?.close();
      release?.();
    }
  };
  return { env, fetch, cleanup: () => cleanup(env) };
}
