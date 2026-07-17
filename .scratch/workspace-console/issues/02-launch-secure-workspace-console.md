# 02 — Launch a secure Workspace Console

**What to build:** A user can launch a local Workspace Console and see a useful Overview backed by the same Workspace application interface as the CLI, without exposing local state to the network or introducing a second server-side authority.

**Blocked by:** 01 — Establish the Workspace application interface and versioned state.

**Status:** ready-for-agent

- [ ] A local command starts the Console on a loopback address, reports the chosen address, and can open it in the user's browser.
- [ ] The frontend uses Vite, React, and shadcn Base UI and is delivered as static assets by the Python process.
- [ ] The Overview shows Producer Project identity, configured Source count, latest Bundle state, active Run state, blockers, and primary next actions.
- [ ] The browser reads Workspace data only through the local HTTP adapter and never accesses SQLite or configuration files directly.
- [ ] CLI and HTTP inspection return equivalent resolved Workspace state and validation errors.
- [ ] An unguessable session token protects the Console session, and state-changing requests validate both the token and request origin.
- [ ] The Console binds only to loopback by default and does not silently accept remote bind addresses.
- [ ] A restrictive Content Security Policy is applied, and the shell loads without CDN scripts, analytics, remote fonts, or other external UI assets.
- [ ] Empty, loading, invalid-Workspace, and server-error states use accessible shadcn feedback primitives.
- [ ] Browser and security tests prove local launch, Overview rendering, offline shell loading, token rejection, origin rejection, CSP, and CLI/HTTP parity.
