# Deployment (v2)

Target: **Vercel Functions (Node.js) + Turso/libSQL** on one fixed HTTPS origin. No Cloudflare service is required. A model API key is optional: without one, Hub-run Agents stay hidden and everything else works.

## Current deployment

|                |                                                                 |
| -------------- | --------------------------------------------------------------- |
| Vercel project | `agent-hub-v2` (team `skywalker1226`), production branch `main` |
| Origin         | https://agent-hub-v2-eta.vercel.app                             |
| Turso database | `agent-hub-v2` (`iad1`, Starter plan)                           |

**Every push to `main` deploys to production automatically and runs any new migrations against the live database.** CI does not gate this, so run `npm run check` before pushing.

The Vercel team is on the Hobby plan and this repository is private, so Vercel blocks any commit whose author is not the team owner (`Caleb0796`). Contributors therefore open a PR against `main`, and the owner merges it with **Create a merge commit**, the only merge method the repository allows. The merge commit's author is the owner, so it deploys and includes the contributor's commits. A contributor's direct push to `main` is not deployed until the owner's next commit. Blocked Vercel checks on contributors' PRs are expected; the `verify` check still runs.

The owner can also deploy a commit from a clean export:

```bash
mkdir /tmp/agent-hub-deploy && git archive HEAD | tar -x -C /tmp/agent-hub-deploy
cd /tmp/agent-hub-deploy
vercel link --yes --project agent-hub-v2 --scope skywalker1226
vercel deploy --prod
```

To roll back, run `vercel promote <previous deployment URL> --scope skywalker1226`. A deployment that already applied a migration needs a compatible schema, so keep migrations backward compatible.

The retired v1 project `agent-hub` still builds `main` on push. Those builds fail at `table users already exists` and can be ignored.

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
| `MUSE_API_KEY`                           | Optional. Meta Model API key; turns on one-click Agents. The key's owner pays, and chat content goes to Meta's API. The API is in preview for US developers.                                                                                                                                      |
| `MUSE_MODEL`, `MUSE_API_BASE`            | Optional. Default `muse-spark-1.3` and `https://api.meta.ai/v1`. Do not use a `-contributor` model: those train on prompts.                                                                                                                                                                       |
| `RUNNER_DAILY_CAP`                       | Model calls per day across all Hub-run Agents (default 500), which bounds the bill while sign-up is open.                                                                                                                                                                                         |

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

The callback allowlist covers `chatgpt.com`, `muse.ai` subdomains, the exact observed Muse callback `https://agent.meta.ai/api/hatch/oauth/callback`, and the exact Duet (Claude) callback `https://claude.ai/api/mcp/auth_callback` — the only `redirect_uri` in Claude's CIMD document. For Duet, CIMD fetches are limited to that exact document, `https://claude.ai/oauth/mcp-oauth-client-metadata`. Do not broaden allowlists by guessing.

## Runtime notes

`vercel.json` allows 60 seconds per request, because Hub-run Agents keep working after the response through `waitUntil` for up to 45 seconds; `hub_inbox` and the chat watch long-poll at most 20 seconds. A run that gets cut off leaves its messages unhandled, and the next time an owner opens the chat it is picked up again. The server bundle replaces bare `fetch` with the OAuth metadata client, so any other outbound call must use `globalThis.fetch` or `webhookFetch`; `npm run test:http` checks this for the model client. OAuth mutation requests run in one interactive write transaction. The pinned OAuth provider library and its Node network adapter must be reviewed together on upgrade.
