# Hosted pilot deployment

Target: **Vercel Functions (Node.js) + Turso/libSQL**, on one fixed HTTPS origin. The browser UI is built with Vite. No model API key or Cloudflare service is required.

The local template uses a disposable SQLite file, `APP_ENV=development`, `SIGNUP_MODE=open`, and `PUBLIC_ORIGIN=http://localhost:8789`. Hosted startup fails closed unless it has a remote Turso database/token and `SIGNUP_MODE=invite`. Do not share local or test databases with production.

## Provision and configure

1. Run `npm run check` and review `SECURITY.md`, `.output/e2e-report.json`, and `.output/http-report.json`.
2. Create/link the `agent-hub` project in the owner's Vercel team. Confirm the exact project with `vercel project inspect --non-interactive` from this repository.
3. Provision the Marketplace `tursocloud/database` integration on the **Starter ($0/month)** plan, region `iad1`, scoped to production. The owner may need to accept the provider's native terms. Use a separate database for previews if preview testing is needed; never attach production data to arbitrary preview branches.
4. Confirm `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` were injected. Configure the exact fixed HTTPS `PUBLIC_ORIGIN`, `SIGNUP_MODE=invite`, and a random secret `CRON_SECRET`. Do not print tokens or commit pulled environment files. `APP_ENV` is forced to production whenever Vercel hosts the function.
5. Pull production environment values to a dedicated ignored file. Apply migrations to the intended new database using `node --env-file=<ignored-file> scripts/migrate.mjs`. Migrations are versioned and transactional. They are **not** run on function cold starts.
6. Deploy the checked commit. Verify the stable origin's UI, assets, health, OAuth discovery, invitation gate, unauthenticated API rejection, and cron authentication before distributing invitations.
7. Generate short-lived, single-use sign-up invitations with `node --env-file=<ignored-file> scripts/create-invite.mjs --count 2 --hours 72` (locally: `npm run invite:create`). Only hashes are stored in `signup_invites`; each printed `<origin>/#signupInvite=<token>` link is shown once. Share them explicitly with selected testers. Never commit invitation tokens.
8. Complete the two-human native acceptance test in `IMPLEMENTATION.md`, including refusal, wrong account, changed key, revocation and cleanup.

Vercel's team access grant and any Marketplace terms are native user authorization steps. A connector returning `403 forbidden` is not a successful deployment; finish its requested grant and retry on the same connection.

## Runtime behavior

`vercel.json` deploys the API in `iad1`, with a 30-second maximum per request. Ten-minute conversations consist of short authenticated requests. No request or function needs to stay alive for the session duration. The two native endpoints still perform all encryption/decryption.

All persistent state lives in Turso. Atomic SQLite batches preserve the original message guards, counter updates and acceptance audit events. OAuth mutation requests hold a write transaction through code consumption and refresh rotation; transactions fail closed on timeout. The database's short interactive-transaction timeout makes production latency and load an explicit verification item.

The upstream MIT OAuth provider remains pinned. A narrow Node adapter replaces its unused Workers RPC marker and its outbound-fetch capability probe. The adapter only allows approved HTTPS metadata hosts, rejects redirects, checks all DNS answers at actual socket lookup, and bounds request time. Upgrading that dependency requires reviewing and testing this adapter, not merely changing the version number.

OAuth record deletion is not the sole revocation mechanism: every MCP call rechecks the Agent's owner, status and authorization version. Message authorization and quota are checked transactionally at insertion. Vercel's trusted forwarding header supplies the rate-limit source; local development is loopback-only.

A daily authenticated cron performs housekeeping. Read/send paths enforce expiry immediately even if cron is late. The cron cannot terminate a native Muse task itself. Native cleanup still uses official native capabilities and a scoped signed report.

## Native OAuth acceptance

The hosted callback allowlist currently covers `chatgpt.com` and `muse.ai` subdomains; it rejects arbitrary and loopback callbacks. CIMD outbound hosts are likewise limited to the supported native platforms. Verify real installation metadata for the actual accounts/version. Do not broaden allowlists or suppress platform consent to make a failed native flow appear successful.

Vercel preview protection remains in place. A hosted production origin must be reachable by the native OAuth clients for onboarding; its application-level signup gate remains invite-only. Previews without an explicitly configured test origin/database fail closed.

## Current status

The invite-only pilot is deployed at **https://agent-hub-chi-blond.vercel.app**, in Vercel team `skywalker1226`, project `agent-hub`. Its dedicated Turso resource is `agent-hub-alpha` on the free Starter plan in `iad1`, connected only to production. All three migrations have been applied. Production secrets are excluded from Git.

The first deployed commit (`f10e5c8`) passed live health/discovery checks and an actual database-backed invitation check: missing/invalid invites were rejected, one disposable valid invite produced passkey options for the correct RP ID, and owner APIs/cron rejected unauthenticated requests. No owner was created; the disposable invite and challenge were deleted. See [live verification](evidence/vercel-production-smoke.json). The two-human native Dot/Muse acceptance milestone remains pending.

New signup invitations use a URL fragment so their token is not sent in the page navigation URL. The Node major version is pinned to 24. Vercel Standard Protection continues to protect generated deployment URLs and previews; the canonical production domain is reachable by native OAuth clients.

## References

- [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [Turso TypeScript client and transaction semantics](https://docs.turso.tech/sdk/ts/reference)
- [Vercel request headers](https://vercel.com/docs/headers/request-headers)
