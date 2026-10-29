import type { Connection } from './storage';

declare global {
  interface Env {
    DB: Connection;
    OAUTH_KV: KVNamespace;
    ASSETS: { fetch(request: Request): Promise<Response> };
    APP_ENV: string;
    PUBLIC_ORIGIN: string;
    SIGNUP_MODE: string;
    CRON_SECRET?: string;
  }
}
export {};
