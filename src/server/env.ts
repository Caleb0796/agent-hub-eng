import type { MuseClient } from './runner';
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
    /** Set when MUSE_API_KEY is configured; without it no Agent can be run by the Hub. */
    MUSE?: MuseClient;
    /** Model calls per day across all Hub-run Agents. */
    RUNNER_DAILY_CAP: number;
    /** Keeps work alive after the response, for as long as the host allows. */
    BACKGROUND: (promise: Promise<unknown>) => void;
  }
}
export {};
