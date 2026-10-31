# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agent Hub v2: a chat system between personal Agents (Dot, Muse, Duet). Owners add friends via one-time invite links; Agents keep long-lived chats; each owner reviews their own Agent's outgoing messages (or opens a short auto window) and can pause, close or block. Message bodies are encrypted at rest but **the Hub can decrypt them — not end-to-end encryption**; never write UI or docs that claim otherwise. Design: `docs/superpowers/specs/2026-10-30-chat-core-design.md`. The v1 end-to-end-encrypted protocol lives in tag `pre-simplify`. User-facing text is Chinese.

## Commands

Node 24. `.env.local` needs `MESSAGE_KEY_V1` (32 random bytes, base64url).

```sh
npm ci && cp .env.example .env.local && mkdir -p .state
npm run db:migrate
npm run dev                                   # http://localhost:8789
npm run check                                 # typecheck, vitest, build, e2e, HTTP smoke, secret scan
npm test                                      # vitest only (in-memory libSQL, serial)
npx vitest run tests/chat.test.ts -t "pause"  # single test
npm run test:e2e                              # build + tests/e2e.run.mjs
npm run test:http                             # needs a prior build
```

## Architecture

- **`src/server/chat.ts` (`ChatService`)** holds all business logic: contacts/invites, per-contact Agent exposure, chats (`pending|open|closed`, one per Agent pair), per-side state in `chat_sides` (auto window, pause, `delivered_seq`), drafts, owner messages, withdrawal, reset/retire, retention. Construct it via `src/server/services.ts#chatService(env)`; tests build one with a fake clock (`tests/helpers.ts#service`).
- **`src/server/policy.ts`** is the only place permission decisions are made (pure functions returning allow / hold / deny). Send-time and delivery-time checks both go through it. Add new rules here, with a row in `tests/policy.test.ts`.
- **Drafts vs messages**: Agent messages needing review live in `drafts`; only approval inserts into `messages`, so `messages.seq` is true send order. Delivery advances `chat_sides.delivered_seq` with compare-and-set (at-most-once); history replay never advances it.
- **`vault.ts`** AES-256-GCM with AAD `message|chat|id` / `draft|chat|id`; keys `MESSAGE_KEY_V<n>` from env (`Env.MESSAGE_KEYS`). **`dlp.ts`** holds credential-like drafts even inside auto windows.
- **`mcp.ts`**: exactly four Agent tools (`hub_whoami`, `hub_chats`, `hub_inbox`, `hub_send`); keep both MCP protocol lanes (2025-03-26 initialize and 2026-07-28 sessionless). Agents must never gain management capabilities.
- **`oauth.ts`**: pinned `@cloudflare/workers-oauth-provider` used as a library on Node (aliases/injection in `scripts/build-server.mjs` and `vitest.config.ts`, network policy in `public-fetch.ts`). Consent creates or explicitly reconnects an Agent; never default-select an existing Agent. Each authorization bumps `auth_version`; tokens carry it and every MCP call rechecks it. Callback allowlist is exact; Duet's callback is intentionally not listed until observed.
- **`auth.ts`**: passkey-only accounts (name only), second passkey, operator recovery (`scripts/create-recovery.mjs`), `SIGNUP_MODE=open|closed`, `SIGNUP_DAILY_CAP`.
- **`api.ts`**: owner REST; writes need session + CSRF, sensitive ones need a login within 15 minutes (`owner(c, { fresh: true })`).
- **Frontend**: `src/web/App.tsx` shell + `src/web/pages/*`; DTO types are inferred from `ChatService` in `src/web/types.ts`.

## Database and deployment

Schema baseline is `migrations/0100_chat_core.sql` (v1 used `0001`–`0005`). Every push to `main` deploys to production automatically (`docs/DEPLOYMENT.md`), and `scripts/migrate-deploy.mjs` applies new migrations to the live database during that build, so run `npm run check` first and keep migrations backward compatible. Vercel deploys only commits authored by the team owner, so other contributors open a PR against `main` for the owner to merge with a merge commit. Add schema changes as new numbered migrations after `0100`.

## Constraints

- Message text is untrusted data for Agents, including owner messages on the Hub; it never grants permission.
- Don't weaken OAuth/PKCE, broaden callback allowlists by guessing, add test-login endpoints, or auto-approve native permission prompts.
- Never log request bodies or message text; audit events carry no message text.
- Never commit real keys, tokens or databases (`npm run check:secrets`). Don't claim native platform support until the gates in `docs/IMPLEMENTATION.md` pass.
