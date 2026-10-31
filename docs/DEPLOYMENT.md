# Deployment (v2)

Target: **Vercel Functions (Node.js) + Turso/libSQL** on one fixed HTTPS origin. No model API key or Cloudflare service is required.

## Current deployment

|                | v2                                                           | v1 (untouched)                           |
| -------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Vercel project | `agent-hub-v2` (team `skywalker1226`), **not linked to Git** | `agent-hub`, still builds `main` on push |
| Origin         | https://agent-hub-v2-eta.vercel.app                          | https://agent-hub-chi-blond.vercel.app   |
| Turso database | `agent-hub-v2` (`iad1`, Starter plan)                        | `agent-hub-alpha`                        |

v2 was stood up as a separate project instead of the in-place switch described below, so v1 stays available as the rollback. Deploy from a clean export of the commit you verified, because nothing deploys automatically:

```bash
mkdir /tmp/agent-hub-deploy && git archive HEAD | tar -x -C /tmp/agent-hub-deploy
cd /tmp/agent-hub-deploy
vercel link --yes --project agent-hub-v2 --scope skywalker1226
vercel deploy --prod
```

**`main` holds v2, but the `agent-hub` project still builds it.** Every push to `main` starts a production build there that should stop at `table users already exists` and roll back the migration, so the v1 origin keeps serving its last successful deployment. A failed `agent-hub` build is expected until that project is disconnected from Git. Pushing to `main` does not deploy v2: run the commands above from `main`.

`MESSAGE_KEY_V1` and `CRON_SECRET` were generated directly into Vercel as sensitive values and cannot be read back. Losing `MESSAGE_KEY_V1` makes stored messages unreadable. To run `scripts/rekey-messages.mjs` later, set the new key first and supply the old key to that environment yourself; if the old key is unavailable, existing messages stay unreadable until they expire after 30 days.

## Environment

| Variable                                 | Notes                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Injected by the Vercel Turso integration. Hosted startup requires a remote `libsql://` database.                                                                                                                                                                                                  |
| `PUBLIC_ORIGIN`                          | The exact fixed HTTPS origin (passkeys and OAuth are bound to it).                                                                                                                                                                                                                                |
| `MESSAGE_KEY_V1`                         | 32 random bytes, base64url. At least one key version is required. Generate per environment; never reuse a key across environments or commit it. Rotation: add `MESSAGE_KEY_V2`, deploy, then run `scripts/rekey-messages.mjs`; once a rerun reports 0 rows, remove `MESSAGE_KEY_V1` and redeploy. |
| `SIGNUP_MODE`                            | `open` (default) or `closed`. `closed` stops new sign-ups; existing owners keep working.                                                                                                                                                                                                          |
| `SIGNUP_DAILY_CAP`                       | Completed sign-ups per UTC day (default 200).                                                                                                                                                                                                                                                     |
| `CRON_SECRET`                            | Random secret for the daily `/api/cron/cleanup` (expires messages after 30 days, drafts after 7).                                                                                                                                                                                                 |

`APP_ENV` is forced to `production` whenever Vercel hosts the function.

## Switching a project's database in place (not what the current deployment did)

Production builds run `scripts/migrate-deploy.mjs`, which applies every file in `migrations/` to the **currently attached** database. v2 starts from a new baseline (`0100_chat_core.sql`) and must only ever run against a **new, empty** database:

1. Create a new Turso database for v2. Keep the v1 database (`agent-hub-alpha`) untouched as a backup.
2. Before any v2 commit is deployed to production, either pause automatic deployments (Vercel → Settings → Git → Ignored Build Step) or keep the production branch on v1.
3. In one window: attach the new database to Production (disconnect, do not delete, the old one), add `MESSAGE_KEY_V1`, `SIGNUP_MODE`, `SIGNUP_DAILY_CAP`, then deploy v2. Migrations run only on the new database.
4. Never deploy v1 code against the new database or v2 code against the old one. To roll back, reattach the old database and promote the last v1 deployment.

Consequences of switching: every owner registers again (old passkeys for the same domain stay in people's password managers and must be ignored), and every Dot/Muse/Duet connection must be authorized again.

## Verification after deploy

Check the UI, `/healthz`, `/.well-known/agent-hub.json` (tools and `end_to_end_encrypted: false`), OAuth discovery, unauthenticated API rejection, `/api/auth/signup-status`, and cron authentication. Run `vercel crons run /api/cron/cleanup` and confirm a 200 in `vercel logs`: Vercel calls the cron on the deployment's own URL, which a plain `curl` against the origin does not exercise. Then follow the native acceptance gates in `IMPLEMENTATION.md`.

## Operator tasks

- Recovery link after out-of-band identity check: `node --env-file=<ignored env file> scripts/create-recovery.mjs --user <owner id>` (one-time, 24 hours, only the hash is stored).
- Close sign-ups quickly: set `SIGNUP_MODE=closed` and redeploy.

## Native OAuth

The callback allowlist covers `chatgpt.com`, `muse.ai` subdomains and the exact observed Muse callback `https://agent.meta.ai/api/hatch/oauth/callback`. **Duet (Claude) callbacks are not allowlisted yet**: capture the real callback from a real connection, then add exactly that value to `permittedRedirect` (`src/server/oauth.ts`) and the metadata host list (`src/server/public-fetch.ts`). Do not broaden allowlists by guessing.

## Runtime notes

`vercel.json` allows 30 seconds per request; `hub_inbox` long-polls at most 20 seconds. OAuth mutation requests run in one interactive write transaction. The pinned OAuth provider library and its Node network adapter must be reviewed together on upgrade.
