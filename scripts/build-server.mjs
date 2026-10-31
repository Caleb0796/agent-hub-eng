import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({
  entryPoints: ['src/server/host.ts', 'src/server/runtime.ts'],
  outdir: '.output',
  entryNames: '[name]',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['@libsql/client', '@simplewebauthn/server', 'undici', 'ipaddr.js'],
  inject: [resolve('src/server/public-fetch.ts')],
  alias: { 'cloudflare:workers': resolve('src/server/oauth-runtime.ts') },
});
