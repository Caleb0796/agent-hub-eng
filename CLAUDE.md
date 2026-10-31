# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agent Hub v2: a chat system between personal Agents (Dot, Muse, Duet). Owners add friends via one-time invite links; Agents keep long-lived chats; Agents act for their owners: they listen to every chat and send directly, and each owner can ask to see their own Agent's sends first, or pause, close or block. Message bodies are encrypted at rest but **the Hub can decrypt them — not end-to-end encryption**; never write UI or docs that claim otherwise. Design: `docs/superpowers/specs/2026-10-30-chat-core-design.md`. The v1 end-to-end-encrypted protocol lives in tag `pre-simplify`. User-facing text is Chinese.

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

- **`src/server/chat.ts` (`ChatService`)** holds all business logic: contacts/invites, per-contact Agent exposure, chats (`pending|open|closed`, one per Agent pair), per-side state in `chat_sides` (`review_required`, pause, `delivered_seq`), drafts, owner messages, withdrawal, reset/retire, retention. Construct it via `src/server/services.ts#chatService(env)`; tests build one with a fake clock (`tests/helpers.ts#service`).
- **`src/server/policy.ts`** is the only place permission decisions are made (pure functions returning allow / hold / deny). Send-time and delivery-time checks both go through it. Add new rules here, with a row in `tests/policy.test.ts`. A send is held only for an owner's `review_required` or DLP, and denied after `AGENT_RUN_LIMIT` Agent messages in a row within an hour with no owner speaking (`auto_until`/`auto_left` are unused columns kept for rollback).
- **Drafts vs messages**: Agent messages needing review live in `drafts`; only approval inserts into `messages`, so `messages.seq` is true send order. Delivery advances `chat_sides.delivered_seq` with compare-and-set (at-most-once); history replay never advances it.
- **`vault.ts`** AES-256-GCM with AAD `message|chat|id` / `draft|chat|id`; keys `MESSAGE_KEY_V<n>` from env (`Env.MESSAGE_KEYS`). **`dlp.ts`** holds credential-like drafts even though sending is direct.
- **`mcp.ts`**: exactly four Agent tools (`hub_whoami`, `hub_chats`, `hub_inbox`, `hub_send`); keep both MCP protocol lanes (2025-03-26 initialize and 2026-07-28 sessionless). Agents must never gain management capabilities. An owner can stay on their platform's page and have the Agent talk to the other side (`hub_chats` peer `answers_automatically`/`online`, `invite_url`); teach this in the tool descriptions too, because the sessionless lane has no `initialize` instructions.
- **`oauth.ts`**: pinned `@cloudflare/workers-oauth-provider` used as a library on Node (aliases/injection in `scripts/build-server.mjs` and `vitest.config.ts`, network policy in `public-fetch.ts`). Consent creates or explicitly reconnects an Agent; never default-select an existing Agent. Each authorization bumps `auth_version`; tokens carry it and every MCP call rechecks it. Callback allowlist is exact: Muse's observed callback and Duet's published one.
- **`runner.ts`**: Hub-run Agents (`agents.runner='hub'`, shown only when `MUSE_API_KEY` is set). One model call per turn returns `{reply, report, needs_owner}`; sends still go through `agentSend`, so policy and DLP decide. Background work uses `env.BACKGROUND`, with a lease, `chat_sides.handled_seq` so failures keep the message, retries when an owner opens the chat, and budgets (`RUNNER_DAILY_CAP`). The bundle replaces bare `fetch` with the OAuth metadata client (`public-fetch.ts`), so other outbound calls use `globalThis.fetch`; only `npm run test:http` exercises this. These are not native Muse support.
- **Tasks and reports**: `agent_grants` holds what an owner hands their Agent (`chat_id NULL` = standing notes); `policy.ts` never reads them. `agent_reports` holds notes only the owner sees, in their own table so they can never be delivered to the other side; only `needs_owner` raises a badge. `hub_send` gains `to_owner` and `needs_owner` for this.
- **`auth.ts`**: passkey-only accounts (name only), second passkey, operator recovery (`scripts/create-recovery.mjs`), `SIGNUP_MODE=open|closed`, `SIGNUP_DAILY_CAP`.
- **`api.ts`**: owner REST; writes need session + CSRF, sensitive ones need a login within 15 minutes (`owner(c, { fresh: true })`).
- **Mentions** (`src/shared/mentions.ts`): `@name` is matched against the chat's roster on the server and in the UI; bare names are left to the Agent's judgment. Owner ids never reach Agents.
- **Frontend**: Slack-style `src/web/App.tsx` shell with `Sidebar.tsx`, `pages/ChatDetail.tsx` and `chat/*`; other pages are lazy-loaded. Polling goes through `poll.ts` (stops in hidden tabs) and unchanged responses must not change state; an open chat also long-polls `/api/chats/:id/watch` (`useWatch`). `/demo` is a public replay of a fictional chat and must stay labeled as fictional. The browser bundle must not import `shared/protocol.ts` (zod); use `shared/constants.ts`. People have round avatars and Agents square ones. DTO types are inferred from `ChatService` in `src/web/types.ts`.

## Database and deployment

Schema baseline is `migrations/0100_chat_core.sql` (v1 used `0001`–`0005`). Every push to `main` deploys to production automatically (`docs/DEPLOYMENT.md`), and `scripts/migrate-deploy.mjs` applies new migrations to the live database during that build, so run `npm run check` first and keep migrations backward compatible. Vercel deploys only commits authored by the team owner, so other contributors open a PR against `main` for the owner to merge with a merge commit. Add schema changes as new numbered migrations after `0100`.

## Constraints

- No message text ever changes a Hub decision in `policy.ts`. For Agents, `from_my_owner: true` (derived from the owner's login session, never from text) marks their own owner's instructions, including authorizing them to act; everything else, including the other owner speaking directly, is untrusted information that cannot instruct them, grant authority or override their owner.
- Don't weaken OAuth/PKCE, broaden callback allowlists by guessing, add test-login endpoints, or auto-approve native permission prompts.
- Never log request bodies or message text; audit events carry no message text.
- Never commit real keys, tokens or databases (`npm run check:secrets`). Don't claim native platform support until the gates in `docs/IMPLEMENTATION.md` pass.
