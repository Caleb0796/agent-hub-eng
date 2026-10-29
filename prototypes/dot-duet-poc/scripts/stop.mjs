import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../.state/', import.meta.url));
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(`${directory}/stop-requested`, '', { mode: 0o600 });
console.log('Stop requested. The experiment and tunnel will close within a second.');
