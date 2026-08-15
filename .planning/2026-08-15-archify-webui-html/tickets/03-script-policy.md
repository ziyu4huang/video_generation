---
ticket: 03-script-policy
effort: archify-webui-html
type: decision
status: closed
created: 2026-08-15
last: 2026-08-16
note: resolved via 01-A (full-fidelity route chosen)
blocking: 01
---
# 03 — Script policy: trust posture for top-level served .html

## Question

If full-fidelity HTML is served: what trust posture for top-level served `.html`
(script execution)? Loopback-only + Host/Origin validation already exist for the server.

Options:

- serve only from explicit allowlist dirs (e.g. archify output dirs / output root);
- serve any realpath-contained file with correct `text/html`;
- require `WEBUI_FULL_HTML=1` opt-in;
- add CSP `sandbox` directive.

Must decide:

- **MIME handling** — `text/html` vs `octet-stream` for `.html`/`.svg` (current `/output`
  allowlist forces download);
- **path containment** — reuse `/output` realpath containment pattern.

## Decision

**CSP `sandbox allow-scripts` + configured directory allowlist.**

- **CSP**: every `/files` response carries `Content-Security-Policy: sandbox allow-scripts
  allow-downloads` — `allow-downloads` / `allow-popups` are added **only if** the vendored
  archify export menu mechanics (blob download / popup) require them; the implementer verifies
  against archify@2.12.0's vendored export code and documents the choice in a code comment.
  Served HTML gets an **opaque origin** → it cannot same-origin-call `/api` or the WS; scripts
  run but the page is not a webui principal.
- **Allowlist**: a new `fileRoots` config option wires configured roots via env
  `WEBUI_FILE_ROOTS` (`:`-separated). **Fail closed: empty roots = the route serves nothing**
  (uniform 404).
- **Containment**: per-request realpath containment — resolve the request path, `realpathSync`
  both sides, `startsWith(root + sep)` — reusing the proven `/output` route pattern.
- **MIME**: `.html` → `text/html; charset=utf-8`; everything else →
  `application/octet-stream` + `X-Content-Type-Options: nosniff` (same posture as `/output`).

This matches the loopback threat model: the server is loopback-only with Host/Origin
validation; the remaining risk of serving attacker-controlled HTML is neutralized by the CSP
opaque-origin sandbox, and filesystem exposure is bounded by the explicit root allowlist.

## Acceptance

- Security decision recorded, matches loopback threat model, pinned by tests.
