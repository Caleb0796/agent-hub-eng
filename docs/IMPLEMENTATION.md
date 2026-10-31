# Implementation status (v2)

The chat core described in [the design](superpowers/specs/2026-10-30-chat-core-design.md) is implemented and covered by automated tests (`npm run check`): permission matrix (`tests/policy.test.ts`), lifecycle scenarios (`tests/chat.test.ts`), MCP tools (`tests/mcp.test.ts`), OAuth, passkeys, storage, an end-to-end flow with two owners and three platform identities (`tests/e2e.run.mjs`) and an HTTP smoke test.

| Area               | Implemented                                                                                                                                   | Remaining                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Owner identity     | Open sign-up with a name and one passkey, login with discoverable passkeys, second passkey, operator recovery links, account deletion         | Real browser and mobile checks (iPhone, Android, opening from WeChat) |
| Agent connection   | One-button OAuth consent that creates or explicitly reconnects an Agent; reset and retire; "authorized" vs "online"                           | Gates A, B, D below                                                   |
| Contacts and chats | One-time invites, per-contact Agent exposure, chat requests with receiver approval and 24-hour cooldown, same-owner chats, block, remove      | —                                                                     |
| Sending            | Direct by default, per-side optional review, DLP holds, Agent run limit, mentions, idempotent sends, owner messages, withdrawal, pause, close | Gate C on Duet                                                        |
| Delivery           | Per-side progress with compare-and-set (at-most-once), history replay, 30-day retention, instant updates in an open chat (long poll)          | Background wake-up for native Agents (gate F)                         |
| Hub-run Agents     | One-click Agents answered by the Hub through the Muse model API, with lease, retry, budgets and a run limit                                   | Never called against the real API; needs `MUSE_API_KEY` (see below)   |
| Tasks and reports  | Tasks per chat, standing notes, reports only the owner sees, a badge only when the Agent needs a decision                                     | —                                                                     |
| Evaluation         | 12 prompt injection scenarios (`evals/injection.ts`, `npm run eval:injection`), scored without any message text in the output                 | No model results yet                                                  |

## Hub-run Agents

These are not native Muse app support and pass none of the gates below. Tests and the local walkthrough use a stand-in for the model; `npm run test:http` proves the built bundle can reach a model server, but no request has been made to Meta's API. Prompt quality, the JSON reply format and refusals are therefore unverified on the real model until the checklist in [DEMO.md](DEMO.md) is done.

## Native acceptance gates (not yet verified)

Protocol tests passing does not mean a platform works. Record each gate in `docs/evidence/`: click counts, native confirmation cards, actual callback URLs, failures and recovery.

- **A** Dot and Muse connect through OAuth and use the four new tools. Dot previously cached the old tool list; reconnect after the switch.
- **B** Duet connects through OAuth. Unverified; its callback must be captured from a real connection before it is allowlisted. If it fails, Duet is not part of the first release.
- **C** Duet sending approval behaviour. If every send needs native approval, direct sending is marked limited on Duet.
- **D** Muse continuous receive/send. Only one-time tasks with task-scoped permission were observed before.
- **E** Two owners who are not project members complete first setup and one chat without engineering help. Required before any external pilot. Measure time and website versus platform steps separately.
- **G** An owner talks to the other Agent from the Dot, Muse or Duet page itself: the Agent finds the chat, sends, waits with `hub_inbox` and relays the answer. The tools and instructions are tested, but no platform has run this. `hub_inbox` is not marked read-only because it consumes messages, so a platform may ask for confirmation on each call; record how many taps a question takes. A platform Agent's owner never speaks on the Hub this way, so a long run still hits the Agent run limit until they speak there.
- **F** Background wake-up on all three platforms: unverified. Native Agents only receive when they run and fetch. Only Hub-run Agents are woken, by the Hub itself.
