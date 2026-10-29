import { serve } from '@hono/node-server';
import { runtimeFromEnvironment } from '../.output/host.mjs';
const runtime = runtimeFromEnvironment();
serve({ fetch: runtime.fetch, hostname: '127.0.0.1', port: 8789 }, () =>
  console.log('Agent Hub: http://localhost:8789'),
);
