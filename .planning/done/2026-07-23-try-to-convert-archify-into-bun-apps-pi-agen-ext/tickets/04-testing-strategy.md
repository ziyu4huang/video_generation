## Question

Keep archify's own `node --test` suite for the vendored renderer (proves the snapshot works) **and** add `bun test` for the TS tool wrappers — or go bun-only and discard the upstream suite?

**Recommendation:** hybrid. Run archify's `node --test test/*.test.mjs` + `golden.mjs` via an npm script for the vendored code (preserves upstream coverage + catches snapshot regressions), plus `bun test` for the pi wrapper/tools. `testGate` in the manifest points at the bun suite.

**type:** grilling
**blocked by:** —
**claimed:** wayfind-session (2026-07-24) — resolving

## Resolution (2026-07-24) — CLOSED

**DECISION: Bun-only — single runtime, no `node` dependency in CI. Discard archify's 64 `node --test` files; re-cover everything in `bun test`.** (User rejected the hybrid recommendation in favor of single-runtime bun; user directive: "golden harness → try to use bun only".)

The bun-only choice collapses the decision tree — the testGate-composition and CI-unsafe-subset sub-questions are determined by it:

1. **Corpus:** do NOT vendor archify's `test/` dir (consistent with the ingestion "runtime subset" — `renderers/` / `schemas/` / `bin/` / `shared/` only). Write a fresh `bun test` suite.
2. **Golden snapshot — re-implemented in bun:** keep the snapshot CONCEPT but render via **bun**, not `execFileSync('node', …)`. Verified path from [01](01-verify-vendored-runtime-under-bun.md): `bun bin/archify.mjs render <type> <sample.json> <out.html>` works. The bun test renders representative sample IRs (via that CLI, or by ESM-importing an exported render fn if the vendored renderers expose one) and byte-compares the HTML to checked-in reference fixtures (CRLF-normalized — same normalize as upstream `golden.mjs`). Reference HTML generated once + checked in under the package.
3. **TS wrapper / tool tests:** `bun test` — `archify_render` (sample IR → non-empty + structurally-valid HTML), `archify_validate` (good/bad IR → expected diagnostics), `archify_delta` (two snapshots → before/after). Deterministic, local, no network.
4. **`check:validators` (ajv codegen drift gate):** KEEP — run under bun (ajv is runtime-agnostic) as a pre-test step / bun test; fails if `renderers/shared/generated-validators.mjs` drifts from the 6 schemas. The codegen script (`generate-validators.mjs`) runs under bun too.
5. **testGate:** `cd bun-apps/pi-agent-ext-archify && bun test` — **UNCHANGED from [03](03-registration-mode.md)**. Single runtime, single check; 03's note anticipated this ("testGate is bun test regardless of 04").
6. **CI-unsafe subset:** N/A — discarding archify's node suite also discards its ~10 CI-unsafe tests (`real-repository-proof` repo-clone, `repository-evidence` git-spawn, `preview`/`open-artifact` browser-launch, `webm-artifact.smoke`). Our bun suite is local/deterministic by construction; we simply don't write network/git/browser tests.

**Trade-off accepted (flagged for visibility, not re-litigated):** we lose archify's 64 renderer-INTERNAL tests (layout, semantic-passport, story, lens, route-probe, …). Coverage rests on (a) the golden end-to-end snapshot (render correctness for sampled IRs) + (b) wrapper/tool tests. A renderer-internal regression surfaces as a golden diff (re-render mismatch) — coarse, but catches output changes. Mitigation if the gap bites: broaden the snapshot sample set; optionally keep archify's node suite as a NON-CI local `npm run test:archify-upstream` for manual drift-checks when re-syncing upstream (noted here, not re-opened as a decision).
