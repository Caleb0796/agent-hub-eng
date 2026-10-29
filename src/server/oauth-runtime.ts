/**
 * The pinned upstream OAuth package imports this marker for its optional Workers RPC API.
 * Agent Hub only uses its standard fetch handlers. No Workers RPC, Cloudflare account,
 * KV service or network call is used. Fail closed if someone enables that API on Node.
 */
export class WorkerEntrypoint {
  constructor() {
    throw new Error('Workers RPC is not supported by the Node.js host');
  }
}
