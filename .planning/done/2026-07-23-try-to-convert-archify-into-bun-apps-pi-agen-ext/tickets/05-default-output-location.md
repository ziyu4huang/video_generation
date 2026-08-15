## Question

Where do `archify_render` / `archify_delta` write artifacts by default — cwd `<slug>.html` (matches archify's own CLI), a configurable `outputPath` param, or vault-integrated?

**Recommendation:** an `outputPath` param defaulting to `<cwd>/<slug>.html`. Vault integration is deferred to fog (see map's *Not yet specified*); it can graduate as a fast-follow once the default is settled.

**type:** grilling
**blocked by:** —
**claimed:** wayfind-session (2026-07-24) — resolving

## Resolution (2026-07-24) — CLOSED

**DECISION: cwd default, vault deferred.** Default output location = the current working directory; vault integration stays in fog as a deferred fast-follow.

**`outputPath` is an optional param** on `archify_render` / `archify_delta`, resolved in this order:
1. The tool's `outputPath` param (if given — absolute, or relative to cwd).
2. Else the IR's `meta.output` (optional string in all 5 schemas — only `meta.title` is required; relative to cwd).
3. Else fallback `<diagram_type>.html` in cwd (collision-safe: if it exists, `<diagram_type>-<short-hash>.html`).

The tool writes the file and **returns the absolute path** (so the agent can surface / link it). `archify_delta` follows the same order; its before/delta/after HTML lands at the resolved path with a `.receipt.json` sibling (matching archify's `compareReceiptPath`).

**Vault:** deferred (fog). Rationale: a ~580 KB self-contained interactive HTML is a standalone deliverable, not vault-note material; and vault-integration via `resolveVaultRoot` carries the silent-cwd-fallback footgun (arxiv_fetch2md wrote to repo root that way) — if ever pursued, it deserves its own careful ticket, not a rushed default.

**Fog updated:** the map's "Vault integration for artifacts" patch is reframed — default is now settled (cwd); vault remains a deferred fast-follow, still not sharp enough to ticket on its own.
