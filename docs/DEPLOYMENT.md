# Deployment (v2)

Target: **Vercel Functions (Node.js) + Turso/libSQL** on one fixed HTTPS origin. No model API key or Cloudflare service is required.

## Environment

| Variable                                 | Notes                                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Injected by the Vercel Turso integration. Hosted startup requires a remote `libsql://` database.                                                                                                   |
| `PUBLIC_ORIGIN`                          | The exact fixed HTTPS origin (passkeys and OAuth are bound to it).                                                                                                                                 |
| `MESSAGE_KEY_V1`                         | 32 random bytes, base64url. Required. Generate per environment; never reuse a key across environments or commit it. Rotation: add `MESSAGE_KEY_V2`, deploy, then run `scripts/rekey-messages.mjs`. |
| `SIGNUP_MODE`                            | `open` (default) or `closed`. `closed` stops new sign-ups; existing owners keep working.                                                                                                           |
| `SIGNUP_DAILY_CAP`                       | Completed sign-ups per UTC day (default 200).                                                                                                                                                      |
| `CRON_SECRET`                            | Random secret for the daily `/api/cron/cleanup` (expires messages after 30 days, drafts after 7).                                                                                                  |

`APP_ENV` is forced to `production` whenever Vercel hosts the function.

## Database switch and migration order (important)

Production builds run `scripts/migrate-deploy.mjs`, which applies every file in `migrations/` to the **currently attached** database. v2 starts from a new baseline (`0100_chat_core.sql`) and must only ever run against a **new, empty** database:

1. Create a new Turso database for v2. Keep the v1 database (`agent-hub-alpha`) untouched as a backup.
2. Before any v2 commit is deployed to production, either pause automatic deployments (Vercel → Settings → Git → Ignored Build Step) or keep the production branch on v1.
3. In one window: attach the new database to Production (disconnect, do not delete, the old one), add `MESSAGE_KEY_V1`, `SIGNUP_MODE`, `SIGNUP_DAILY_CAP`, then deploy v2. Migrations run only on the new database.
4. Never deploy v1 code against the new database or v2 code against the old one. To roll back, reattach the old database and promote the last v1 deployment.

Consequences of switching: every owner registers again (old passkeys for the same domain stay in people's password managers and must be ignored), and every Dot/Muse/Duet connection must be authorized again.

## Verification after deploy

Check the UI, `/healthz`, `/.well-known/agent-hub.json` (tools and `end_to_end_encrypted: false`), OAuth discovery, unauthenticated API rejection, `/api/auth/signup-status`, and cron authentication. Then follow the native acceptance gates in `IMPLEMENTATION.md`.

## Operator tasks

- Recovery link after out-of-band identity check: `node --env-file=<ignored env file> scripts/create-recovery.mjs --user <owner id>` (one-time, 24 hours, only the hash is stored).
- Close sign-ups quickly: set `SIGNUP_MODE=closed` and redeploy.

## Native OAuth

The callback allowlist covers `chatgpt.com`, `muse.ai` subdomains and the exact observed Muse callback `https://agent.meta.ai/api/hatch/oauth/callback`. **Duet (Claude) callbacks are not allowlisted yet**: capture the real callback from a real connection, then add exactly that value to `permittedRedirect` (`src/server/oauth.ts`) and the metadata host list (`src/server/public-fetch.ts`). Do not broaden allowlists by guessing.

## Runtime notes

`vercel.json` allows 30 seconds per request; `hub_inbox` long-polls at most 20 seconds. OAuth mutation requests run in one interactive write transaction. The pinned OAuth provider library and its Node network adapter must be reviewed together on upgrade.
