import type { Connection } from './storage';

declare global {
  interface Env {
    DB: Connection;
    OAUTH_KV: KVNamespace;
    ASSETS: { fetch(request: Request): Promise<Response> };
    APP_ENV: string;
    PUBLIC_ORIGIN: string;
    /** 'open' or 'closed'. */
    SIGNUP_MODE: string;
    SIGNUP_DAILY_CAP: number;
    /** Message encryption keys by version (base64url, 32 bytes each). */
    MESSAGE_KEYS: Record<number, string>;
    CRON_SECRET?: string;
  }
}
export {};
