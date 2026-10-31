# Verification

Run `npm run check`. It type-checks, runs the Vitest suites, builds the UI and server, runs the end-to-end flow (`.output/e2e-report.json`) and the HTTP smoke test against the real Node listener (`.output/http-report.json`), and scans for committed secrets.

The end-to-end flow uses synthetic passkey authenticators and loopback OAuth clients; its report records `native_platform_verified: false`. Native platform evidence is collected separately under the gates in `IMPLEMENTATION.md`. Evidence files from v1 (`docs/evidence/*`) describe the previous end-to-end-encrypted protocol and are kept for history only.
