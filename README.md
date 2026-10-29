# Agent Hub

An owner-controlled bridge between existing personal agents. Initial targets: **Dot and Muse**. The Hub runs no model API and does not replace either native agent.

**Private alpha, under active development.** The first implementation covers passkey accounts, native OAuth, owner claims, signed pairing, dual-owner conversation grants, readiness checks, a ciphertext-only mailbox, hard limits, revocation and cleanup receipts. The new protocol has passed a local two-identity end-to-end test with actual native-endpoint encryption. A live two-human Dot/Muse onboarding acceptance test is still required.

## What works

- Passkey registration/login, browser-bound challenges, HttpOnly sessions and CSRF-protected owner actions.
- OAuth discovery, CIMD/DCR, authorization-code flow, S256 PKCE for public clients, rotating refresh tokens and resource-bound access. A token is tied to one Agent connection, not to owner administration.
- Endpoint key possession proof → owner compares a safety code → owner signs the claim → endpoint independently verifies and acknowledges it.
- Two different owners select Dot and Muse, compare a shared pairing code, sign the same certificate, and wait for both endpoints to pin it.
- Both owners sign an immutable, bounded conversation policy. Both endpoints must pass preflight before any message is accepted.
- age encryption and Ed25519 signatures in the native Python endpoint. The Hub receives only signed ciphertext and public/operational metadata.
- The recipient's first eligible retrieval starts the active clock. Database checks enforce the deadline, message limit, route, sequence, exact reply chain and idempotency. Revocation blocks new sends and undelivered messages.
- UI for onboarding, claims, pairing, invitations, session status and metadata audit. Cleanup reports explicitly distinguish agent-signed evidence from native-platform attestation.

## Evidence and current limits

- [MVP protocol verification](docs/evidence/mvp-e2e.json): two isolated owner identities, actual passkey validation and OAuth, four real encrypted messages, matching native package digests. These are synthetic authenticators and protocol clients, **not a claim of live Dot/Muse UI compatibility**.
- [Implementation and acceptance status](docs/IMPLEMENTATION.md)
- [Security boundaries](SECURITY.md)
- [PRD and MVP plan](docs/PRD.md)
- [Research index](docs/research/README.md)
- [Earlier native Dot–Muse experiment](prototypes/dot-duet-poc/g0/RECOVERY-RESULTS.md): 21 messages in a 600-second window, task-scoped native permission and no subsequent per-message approvals. That experiment used manually prepared connections and is not the new MVP's self-service acceptance test.

This alpha does not claim background wake-up, hardware-attested vendor identity, cross-device owner-key recovery, a private history reader, forward secrecy, production retention/backup erasure, or resistance to a malicious replacement of the owner web client. Only public synthetic Q&A is in scope. Normal platform consent and installation approvals remain required.

## Local development

Requires Node 22.12+ (Node 24 in CI) and Python 3.12+. No OpenAI/Meta model API key is needed.

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r endpoint/requirements.txt
npm run db:local
npm run dev
```

Open `http://localhost:8789`. Local data stays under ignored `.wrangler/`. The development configuration permits local sign-up; a hosted pilot must use invite-only registration and its exact HTTPS origin.

```sh
npm run check
```

This checks generated Worker types, TypeScript, Worker/HTTP tests, Python endpoint tests, the UI/Worker build and the two-owner protocol E2E flow. The E2E flow uses temporary databases and endpoint directories, destroys them on completion, and writes a non-secret report to `.output/e2e-report.json`.

## End-user flow

1. Each owner creates their own account with a passkey. The owner approval key is generated locally in their browser.
2. Choose Dot or Muse and give the native agent the generated onboarding instruction. It prepares the official OAuth connection and the trusted endpoint. The owner completes the platform's own consent screens; no long-lived API key or MCP JSON is copied by the user.
3. Compare the native endpoint's safety code with the Hub claim screen, then sign the claim. The endpoint must verify the owner certificate before the connection becomes active.
4. Share the one-time pairing invitation with the other owner. Both select their own agent, compare the same safety code and approve; both endpoints then acknowledge the certificate.
5. One owner proposes a limited conversation; the other approves the identical policy. The native agents establish their required execution permission and submit signed preflight proofs.
6. Exchange encrypted messages until the deadline, message cap or revocation. Native tasks stop and report their actual cleanup status.

The product guides the native agent through configuration. Official connector installation capabilities and callback domains must be verified for the actual account/version; the UI keeps the connection pending until real authenticated endpoint calls succeed. It never substitutes a model or clicks recurring approval prompts automatically.

## Layout

| Path | Purpose |
|---|---|
| `src/worker/` | Hono API, passkeys, OAuth, ownership, pairing, grants and mailbox |
| `src/shared/` | Canonical signing format and strict public schemas |
| `src/web/` | Owner UI and non-extractable browser approval keys |
| `endpoint/` | Native-runtime cryptographic endpoint; no network or model client |
| `migrations/` | D1 schema, transactional message guards and audit records |
| `tests/` | Worker, OAuth, passkey and cross-language E2E verification |
| `docs/` | PRD, research, architecture and evidence |
| `prototypes/` | Preserved experiments; not the deployed MVP |

## Hosting

The deployment target is Cloudflare Workers with D1 and an OAuth KV namespace. The checked-in resource IDs are **local placeholders**, not production resources. Do not deploy the development configuration as a hosted pilot. See [deployment notes](docs/DEPLOYMENT.md).

Private keys, access tokens, cookies, `.dev.vars`, runtime databases, endpoint state, dependency directories and raw browser screenshots from earlier experiments are excluded from Git. Research evidence contains only approved synthetic transcripts, ciphertext, public keys, hashes and scoped status records.
