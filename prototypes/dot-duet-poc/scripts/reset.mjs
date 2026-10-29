import { BridgeStore } from '../src/store.mjs';
import { fileURLToPath } from 'node:url';
const store = new BridgeStore(fileURLToPath(new URL('../.state', import.meta.url)));
store.reset();
console.log('Experiment reset; endpoint credentials preserved. Restart the server before continuing.');
