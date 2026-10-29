# First-session implementation status

The current slice is **owner onboarding → claim → pairing → dual consent → encrypted session**. It is an alpha implementation, not completion of the full PRD.

| Boundary                  | Implemented                                                                                                     | Evidence / remaining gate                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Owner identity            | Passkeys, origin/challenge/UV checks, independent sessions and approval keys                                    | Tests use valid synthetic authenticator attestations; the real browser's authenticator UI still needs a human acceptance check        |
| Native account connection | OAuth discovery, CIMD/DCR, PKCE, resource/scope binding, per-Agent token and revocation                         | Protocol tests pass; Dot/Muse's actual hosted installation and OAuth screens remain to be tested against the hosted pilot             |
| Endpoint enrollment       | Local key generation, signed public registration, owner safety code, signed claim and endpoint confirmation     | Two independent endpoint processes complete this in the E2E test                                                                      |
| Pairing                   | One-time fragment invitation, separate owners, owner signatures, pinned keys and both endpoint acknowledgements | Wrong owner, changed identity and replay boundaries covered; real two-person safety-code ceremony pending                             |
| Session authorization     | Immutable policy signed by both owners, distinct native readiness proofs                                        | Hub grants never override native platform approval; native execution evidence is explicitly agent-reported                            |
| Transport                 | Ciphertext-only envelopes, signatures, fixed routing, counters, idempotency and exact reply chain               | Four actual age-encrypted messages decrypted by the opposite endpoint, package digests matched                                        |
| Stops and cleanup         | Transactional quota/deadline/revocation; signed cleanup receipts; stale auth/challenge cleanup                  | Native task creation/removal must run through the platform's official tools; Hub cannot claim native cleanup from its own timer alone |
| User interface            | Owner dashboard, connection guide, claims, invitations, safety-code approval, session status and activity       | Public UI build inspected; authenticated browser flows need a real/available test authenticator                                       |

## Next acceptance milestone

Use a fixed HTTPS, invite-only pilot with two non-project participants. Each uses their own native Dot or Muse account and their own browser-held owner key. They must complete installation, OAuth, claim, pairing and one limited session without a developer entering credentials or configuration on their behalf. Record the actual initial permission cards, callback behavior, all later approvals and final native cleanup.

Until that milestone passes, the repository must not describe the new MVP as already proven for two real users on the native platforms. The prior 21-message experiment remains a separate manually configured feasibility result.

## Deliberately not in this slice

Private history reading, owner-key recovery across devices, production backup deletion and retention, forward secrecy, multi-device enrollment, vendor identity attestation, generic external wake-up, public connector marketplace review and third-party content audit remain open PRD work.

## Hosting migration

The implementation now targets Vercel Functions and Turso/libSQL. The Cloudflare deployment configuration and Workers emulator were removed. The original 18 protocol/HTTP tests and actual Python encryption E2E run on Node.js/libSQL; additional tests cover transactional rollback, OAuth expiry/pagination/restart persistence, concurrent authorization-code redemption, cron authentication and public-network metadata policy. This is local runtime evidence; live Vercel/Turso deployment and two-human Dot/Muse acceptance are separate gates.
