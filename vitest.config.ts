import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
export default defineConfig({
  plugins: [
    {
      name: 'endpoint-source',
      async load(id) {
        if (id.endsWith('.py'))
          return `export default ${JSON.stringify(await readFile(id, 'utf8'))}`;
        if (id.endsWith('/@cloudflare/workers-oauth-provider/dist/oauth-provider.js'))
          return `import { fetch, Cloudflare } from ${JSON.stringify(resolve('src/server/public-fetch.ts'))};\n${await readFile(id, 'utf8')}`;
      },
    },
  ],
  resolve: { alias: { 'cloudflare:workers': resolve('src/server/oauth-runtime.ts') } },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
