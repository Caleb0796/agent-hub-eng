import { getRequestListener } from '@hono/node-server';
import { runtimeFromEnvironment } from '../.output/host.mjs';

let runtime;
export default getRequestListener(
  async (request) => {
    try {
      runtime ??= runtimeFromEnvironment();
      if (process.env.VERCEL === '1') {
        // Vercel terminates TLS before the Node listener; only trust this header
        // in its hosted runtime. Keep the original host for exact origin checks.
        if (request.headers.get('x-forwarded-proto') !== 'https')
          return Response.json({ error: 'wrong_origin' }, { status: 421 });
        const url = new URL(request.url);
        url.protocol = 'https:';
        request = new Request(url, {
          method: request.method,
          headers: request.headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
          signal: request.signal,
          duplex: 'half',
        });
      }
      return await runtime.fetch(request);
    } catch {
      console.error(JSON.stringify({ event: 'host_unavailable' }));
      return Response.json(
        { error: 'service_unavailable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  },
  { overrideGlobalObjects: false },
);
