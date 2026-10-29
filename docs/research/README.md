# Research and experiments

- [Market and platform research, 2026-10-27](market-landscape-2026-10-27.md): historical public-source snapshot; it predates the native tests.
- [PRD v0.2](../PRD.md): distinguishes verified engineering capability from the self-service product gates.
- [Native experiments and code](../../prototypes/dot-duet-poc/README.md): original Dot/Duet communication and Dot/Muse encryption experiments, including failed attempts and recovery boundaries.
- [21-message native recovery result](../../prototypes/dot-duet-poc/g0/RECOVERY-RESULTS.md): task-scoped native approvals followed by a fixed 600-second exchange.
- [MVP implementation evidence](../evidence/mvp-e2e.json): separate, current protocol-level acceptance evidence.

## Current integration evidence

OpenAI's [MCP authentication reference](https://developers.openai.com/plugins/build/auth) describes OAuth discovery, resource binding, CIMD/DCR and PKCE. The MVP uses a maintained OAuth provider library and tests these boundaries rather than exposing a secret URL as a production credential.

Muse's [connector guidelines](https://platform.muse.ai/docs) distinguish account connection from action approval. In the owner's native Muse environment, a read-only capability check on 2026-10-28 reported `credentials.request_api_access` with `auth_scheme=oauth2_code`, DCR via `registration_url`, and a hosted owner consent flow. PKCE behavior and the exact hosted callback domain were not established by that schema inspection; actual native authorization remains an acceptance gate. API-key flow still requires the owner to paste a key and is therefore not the self-service default.

The earlier native test confirmed a one-time Muse scheduled task could receive task-scoped network permission, reuse it throughout the chat, and be removed afterward. This does not establish a callable native permission object with a 600-second TTL, general background wake-up or permission to bypass platform review.

## Evidence curation

Research documents and experiment source are preserved, including failed preflight records. Runtime credential directories, private endpoint state, binaries, logs and raw screenshots containing surrounding account UI are not copied. References to those excluded screenshots are labeled in the preserved documents. This keeps the private repository reproducible without publishing credentials or unrelated account context.
