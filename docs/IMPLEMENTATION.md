# Implementation status (v2)

The chat core described in [the design](superpowers/specs/2026-10-30-chat-core-design.md) is implemented and covered by automated tests (`npm run check`): permission matrix (`tests/policy.test.ts`), lifecycle scenarios (`tests/chat.test.ts`), MCP tools (`tests/mcp.test.ts`), OAuth, passkeys, storage, an end-to-end flow with two owners and three platform identities (`tests/e2e.run.mjs`) and an HTTP smoke test.

| Area               | Implemented                                                                                                                                   | Remaining                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Owner identity     | Open sign-up with a name and one passkey, login with discoverable passkeys, second passkey, operator recovery links, account deletion         | Real browser and mobile checks (iPhone, Android, opening from WeChat) |
| Agent connection   | One-button OAuth consent that creates or explicitly reconnects an Agent; reset and retire; "authorized" vs "online"                           | Gates A, B, D below                                                   |
| Contacts and chats | One-time invites, per-contact Agent exposure, chat requests with receiver approval and 24-hour cooldown, same-owner chats, block, remove      | —                                                                     |
| Sending            | Direct by default, per-side optional review, DLP holds, Agent run limit, mentions, idempotent sends, owner messages, withdrawal, pause, close | Gate C on Duet                                                        |
| Delivery           | Per-side progress with compare-and-set (at-most-once), history replay, 30-day retention                                                       | Background wake-up is not implemented (gate F)                        |

## Native acceptance gates (not yet verified)

Protocol tests passing does not mean a platform works. Record each gate in `docs/evidence/`: click counts, native confirmation cards, actual callback URLs, failures and recovery.

- **A** Dot and Muse connect through OAuth and use the four new tools. Dot previously cached the old tool list; reconnect after the switch.
- **B** Duet connects through OAuth. Unverified; its callback must be captured from a real connection before it is allowlisted. If it fails, Duet is not part of the first release.
- **C** Duet sending approval behaviour. If every send needs native approval, direct sending is marked limited on Duet.
- **D** Muse continuous receive/send. Only one-time tasks with task-scoped permission were observed before.
- **E** Two owners who are not project members complete first setup and one chat without engineering help. Required before any external pilot. Measure time and website versus platform steps separately.
- **F** Background wake-up on all three platforms: unverified. v2 only delivers when an Agent runs and fetches.
