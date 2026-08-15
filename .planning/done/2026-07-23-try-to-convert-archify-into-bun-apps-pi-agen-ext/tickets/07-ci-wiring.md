## Question

Add `pi-agent-ext-archify` to `.github/workflows/ci.yml` matrix + `.github/CI.md`, and decide the branch-protection posture for its `test · pi-agent-ext-archify` check (required vs advisory).

**Recommendation:** mirror `research-tool`'s ci.yml row; add the check as **required** on `main` once the package's `bun test` is green (server-side rule via `gh api .../branches/main/protection` — the granular sub-endpoint 404s on this repo; PUT the full protection object).

**type:** task
**blocked by:** 03-registration-mode (the required-check posture depends on the registration decision)
**claimed:** wayfind-session (2026-07-24) — resolving

## Resolution (2026-07-24) — CLOSED

**DECISION: Required from day 1.** `test · pi-agent-ext-archify` joins the server-side `required_status_checks.contexts[]` (CI.md's "24 required" → 25) when the package lands.

**Routing is automatic — VERIFIED this session.** `scripts/ci-changed-packages.sh` auto-discovers packages via a `bun-apps/*/package.json` glob + live `@repo/*` dep read (reverse-BFS transitive). No manual routing entry anywhere. The `tests` job step-gate `fromJSON(needs.changed_packages.outputs.packages)[matrix.package] == true` means archify's `bun test` runs **only when** archify files change OR shared config changes (fail-open) OR push-to-main; it no-ops on PRs touching only other packages. Confirmed archify is absent from `--all` today (no dir) and auto-included once `package.json` exists. The check always reports (no-op success when skipped) → required-check is viable.

**Manual CI edits (land WITH the scaffold, not before — the dir must exist):**
1. `.github/workflows/ci.yml` → `tests.matrix.include`: add `- { package: pi-agent-ext-archify, test-cmd: "bun test" }` (uniform `bun test`, matches research-tool / flux2 / etc.).
2. `.github/CI.md` → add `test · pi-agent-ext-archify` to the required-checks `contexts[]` block; bump the "24 required" / "matrix of 22" counts.
3. Server-side branch protection → add `test · pi-agent-ext-archify` to `required_status_checks.contexts` via `gh api -X PUT repos/ziyu4huang/video_generation/branches/main/protection` (**full body** — the granular `.../required_status_checks` sub-endpoint 404s on this repo; see CI.md). Include ALL existing contexts + the new one; preserve `enforce_admins` / `required_pull_request_reviews` / etc.

**NO change to** `scripts/ci-changed-packages.sh` (auto-discovery) or `run-dir/manifest.json` (that's [03](03-registration-mode.md)'s domain).

**Inherited caveat (a feature, not a bug):** fail-open — shared-config PRs (`.github/`, `scripts/`, root) re-run archify alongside everything. Correct.
