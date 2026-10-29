# Hosted pilot deployment

Target: one Cloudflare Worker, D1 database and OAuth KV namespace on a fixed HTTPS origin. No model API key is required.

The root Wrangler configuration is local-only: placeholder binding IDs, `APP_ENV=development`, `SIGNUP_MODE=open`, `PUBLIC_ORIGIN=http://localhost:8789`. Origin checks deliberately prevent it from becoming a working public service by accident.

Before hosting:

1. Run `npm run check` and inspect the acceptance report and security boundaries.
2. Create dedicated D1 and OAuth KV resources in the owner's account. Apply every migration to the new D1 database.
3. Configure the exact fixed HTTPS `PUBLIC_ORIGIN`, `APP_ENV=production`, and `SIGNUP_MODE=invite`. Keep staging and production data separate.
4. Verify the native callback domains using actual platform registration metadata. The production allowlist currently covers `chatgpt.com` and `muse.ai` subdomains; it rejects arbitrary and loopback callbacks. Do not broaden it to bypass a failed native flow.
5. Deploy the built Worker and UI assets through the account's supported deployment path. Do not use a temporary tunnel or a temporary account as the pilot's permanent identity.
6. Generate short-lived, single-use sign-up invitations; store only their hashes in `signup_invites`. Share them explicitly with the selected testers. Do not commit invitation tokens.
7. Complete the two-human native acceptance test in `IMPLEMENTATION.md`, including refusal, wrong account, changed key, revocation and cleanup.

OAuth KV deletion is not treated as the only revocation mechanism: every MCP call rechecks the D1 Agent's owner, revocation status and authorization version. Message authorization and quota are also checked transactionally at insertion.

The scheduled handler expires abandoned state and OAuth records. It cannot terminate a native Muse task itself. Native task cleanup must be performed through the official native capabilities and returned as a scoped signed report.
