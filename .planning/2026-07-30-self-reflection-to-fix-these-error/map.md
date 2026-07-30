# Wayfinder map: 2026-07-30-self-reflection-to-fix-these-error

## Destination

Make the two highest-recurrence failure-memory clusters — **(1) test-hermeticity** (local-pass / CI-fail, ~8 instances: watchdog #937, hermes #938, config.test, tool-gate, …) and **(2) failure-store noise** (near-duplication + re-bloat: SurrealDB-subquery ×3, mupdf API ×3, ask_user_question-header ×2, web_search-broken ×2; store went 96%→69%→98% this session) — **stop recurring** by finding why each *existing* guard/lesson fails to prevent recurrence and applying a **structural** fix (CI gate / pre-push hook / automated check) that demonstrably fires on a known-bad instance. Done = each cluster has a guard that provably catches a recurrence; the stored lesson is no longer the only line of defense.

## Notes

- **Domain**: hermes failure store (`~/.pi/agent/pi-hermes-memory/failures.md`, ~47 entries), repo portability audit (`scripts/test-portability-audit.sh`, P1–P5 classes), CI regression gates (`.github/workflows/ci.yml`), `pi-memory-bulk-dedup` skill.
- **Skills every session consults**: `systematic-debugging` (root-cause each recurrence gap — don't fix the symptom), `test-driven-development` (implement any guard RED→GREEN).
- **OVERRIDE — this effort carries execution into the map.** Per wayfinder default the map is planning-only, but this destination's done-criterion is a *deliverable* (a guard that fires), so task tickets **decide AND implement**. Close a task ticket only after the guard demonstrably catches a known-bad instance.
- **Standing preference**: structural fixes (CI gate / hook / automated check) **rank above** stored lessons — a lesson the agent keeps ignoring is evidence the lesson alone is insufficient. Verify the guard fires on a reproduced known-bad instance before closing.
- Re-verify premises against current state (this session's standing lesson): the failure store + audit may have moved since the instances were logged.

## Decisions so far

- [00 Why the top clusters recur despite existing guards](tickets/00-why-the-top-clusters-recur-despite-guards.md) — **research DONE**: hermeticity recurs because the portability audit misses config-mutating env vars (P3 = `*_API_KEY`/`*_TOKEN` only; the `PI_HERMES_CONSOLIDATING`/#938 class is undetected), excludes `loadConfig(`/`os.homedir(` from P5, and is CI-only (no local pre-push gate). Store-noise recurs because there's no write-time near-dup gate and `dedup.sh` only hard-deletes *exact* dups (near-dups are report-only → accumulate; worst cluster mupdf ×5). Concrete candidate fix shapes recorded in the ticket for 01/02.
- [01 Structural fix for test-hermeticity recurrence](tickets/01-structural-fix-for-test-hermeticity-recurrence.md) — **task DONE**: detection was at its limit (loadConfig = false positives; env-var = #938 false-positive-prone), so the fix closed the *local-enforcement* gap (00 #3) + gave the untested audit regression coverage: `--root` flag, 5-case regression test, `PORTABILITY-GUARDED` marker, `test:portability` scripts, shared `.githooks/pre-push` (auto-active), CI step. Known-bad fixture caught locally by the hook (done criterion met). Env-var-mutating class stays convention-only (deferred).

## Not yet specified

<!-- fog graduated into 01/02 by ticket 00; remaining fog is the exact fix SHAPE each task ticket will pick (resolved when the task is worked, informed by 00's candidate shapes) -->
- Hermeticity (01): P6 class for config-mutating env vars vs local pre-push enforcement vs both — 00 recommends both.
- Store-noise (02): write-time near-dup gate (if hermes hook feasible) vs automated compaction vs check-before-write convention — 00 recommends the gate if feasible.
- If either fix surfaces a larger design (e.g. the hermes write-seam can't host a near-dup hook), the task ticket splits at resolution.

## Out of scope

- **Pre-push verification gaps cluster** (SDD-reviewer-skips-tsc, pi-upgrade cross-pkg typecheck, `git add -A` sweep) — each already has a guard (commitScope, update-pi.sh typecheck gate); lower recurrence than the top-2. Separate effort if any resurfaces.
- **SurrealDB `memory_search` timeout** — already fixed (PR #948).
- **4-live-session `.md` file-lock contention** — environmental, separate concern.

## Tickets

- [00 Why the top clusters recur despite existing guards](tickets/00-why-the-top-clusters-recur-despite-guards.md) — **research** (fired in charting)
- [01 Structural fix for test-hermeticity recurrence](tickets/01-structural-fix-for-test-hermeticity-recurrence.md) — **task** (blocked by 00)
- [02 Structural fix for failure-store noise](tickets/02-structural-fix-for-failure-store-noise.md) — **task** (blocked by 00)
