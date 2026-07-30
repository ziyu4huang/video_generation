## Question

Apply a **structural** fix that makes the test-hermeticity cluster (local-pass / CI-fail) stop recurring — a guard that demonstrably fires on a known-bad instance, not another stored lesson.

Scope graduates from ticket 00's root-cause. Likely shape (confirm against 00 before building): broaden the portability audit's P-class detection to cover the gap 00 identifies (env-var leakage? homedir reads? both?) **and/or** add pre-push enforcement so authors hit the gate locally before CI does. The exact fix is ticket 00's output.

**Acceptance (done)**: a reproduced known-bad test (one that currently passes locally, fails CI) is caught **locally** by the new guard, RED→GREEN. Verify by constructing a deliberately-non-hermetic test, confirming the guard fires, then removing the known-bad. The stored hermeticity lessons become the *second* line of defense, not the first.

**claimed:** this-session (2026-07-30) — ✅ CLOSED

## Resolution — done: local enforcement + audit regression coverage

**Investigation pivot (informed by 00):** the hermeticity *detection* is at its practical limit — broadening P5 to `loadConfig(` produces false positives (workflow's `loadConfig` is a local test helper; config-parity is static text analysis), confirming the script's existing exclusion. The env-var-mutating class (#938: `PI_HERMES_CONSOLIDATING` local-flake) is false-positive-prone like P3/P4 (not block-detectable). So the fix is NOT more detection — it's **closing the local-enforcement gap (00 #3)** + **giving the untested audit regression coverage**.

**Delivered:**
1. **Audit `--root <dir>` flag** (`scripts/test-portability-audit.sh`) — makes the script pointable at synthetic fixture trees (was hardcoded to repo root). Additive; default behavior unchanged.
2. **Audit regression test** (`bun-apps/tests/test-portability-audit.test.ts`, 5 cases) — the audit had ZERO tests; now pins `--root` + P2/P5 classification (GUARDED vs UNGATED, block-under-strict) so a refactor can't silently disable a detection class. TDD RED→GREEN.
3. **Sanctioned `PORTABILITY-GUARDED` marker** — a `// PORTABILITY-GUARDED: <reason>` comment attests a spawn is CI-safe (needed because the audit's own test legitimately spawns bash in CI — a case the skipIf/opt-in guard signals can't express). Added to the audit GUARD_RE + documented in TEST-PORTABILITY.md.
4. **`test:portability` + `test:portability-audit` scripts** (`bun-apps/package.json`) — convenient local invocation.
5. **Shared `.githooks/pre-push`** — runs the audit `--strict` before every push (auto-active: `core.hooksPath` already points at the committed `.githooks/`). Closes the "audit was CI-only → slow feedback → conventions ignored" gap.
6. **CI step** (`.github/workflows/ci.yml`) — runs the regression test in the regression-gates job.

**Done criterion met:** a known-bad fixture (bare `loadModelTierConfig()` — the #937 class) is caught LOCALLY by the pre-push hook (demonstrated: hook exits 1 on the fixture, 0 on clean). The audit's classification logic is now regression-protected.

**Honest boundary (deferred):** the env-var-mutating class (#938: harness injects `PI_HERMES_CONSOLIDATING`/`TOOL_GATE_LOG_PATH` → config-test flakes locally) remains **convention-only** — not block-detectable (false-positive prone, same class as P3/P4). Proven fix stays the `beforeEach` snapshot+delete+restore pattern. A future effort could add a shared `clearHarnessEnvVars()` helper to reduce friction.

**Verified:** audit test 5/5; real-repo `--strict` clean; hook passes clean + blocks known-bad fixture; repo-level suite 2604 pass (7 pre-existing workflow-pack failures unrelated).

**blocked by:** 00 (✅ closed)

**type:** task
