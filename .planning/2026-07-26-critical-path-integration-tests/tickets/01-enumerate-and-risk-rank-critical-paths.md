## Question

Enumerate + risk-rank the **critical paths** across superpowers + wayfind — the
behaviors most likely to break in real use and least covered by the current
unit suites. Candidates already on the radar (from the charting grill):

- **SDD fix-loop cross-round memory** (superpowers) — smoke-tested once (real
  subagent, report round-trip), no regression test; the resume-in-place →
  fresh-dispatch fallback is subtle and pi-specific.
- **Routing disk-state 5-stage transitions** (wayfind) — the 4→2 rewrite; stage
  detection + effort×plan nesting (`.planning/<effort>/sdd/<plan-basename>/`)
  under real disk state.
- **Bootstrap injection lifecycle** (both) — session_start/compact re-arm,
  agent_end inert, post-compaction insertion order, dedup vs visible messages.
- **skill-exclude under real pi** (superpowers) — `DEFAULT_SKILL_EXCLUDE` + env
  composition + the `-ns`/run-dir `--skill` splice interaction (unit-tested
  against a mock, never against real pi's `resources_discover`).

Surface others (wayfind's 7 skills' runtime behavior? determinism surfaces? the
subagent-driven-development `commitScope` guardrail? the sdd-workspace
`PLAN_FILE`/`PI_PLANNING_EFFORT` derivation?) and risk-rank all by
(break likelihood × blast radius). Output: a ranked queue the later tickets
graduate test designs from.

type: research

---

**Status: closed** — research resolved in the charting session (2026-07-26).

## Resolution

Audited both exts' test files vs their runtime surfaces. Risk rank (break
likelihood × blast radius), each tagged **[D]** deterministic vs **[L] LLM-
behavior-dependent — that classification is a fact feeding 03's pattern choice:

**Tier 1 — HIGH (untested, high blast radius):**
1. **`piBoundaryOverrides` routing table** (`superpowers.ts`) **[D]** — decides
   superpowers↔wayfind↔other routing from disk state (the 4→2 five-stage
   rewrite). **Zero test coverage** — no test references it. Recent rewrite + it
   routes the whole agent workflow → top priority. Golden-output: feed fixed
   disk layouts, assert the route.
2. **SDD fix-loop cross-round memory** (subagent-driven-development) **[L]** —
   the resume→fresh-dispatch fallback, report-file-as-cross-round-memory,
   re-review-prompt. **Smoke-tested once only**; no regression test. Silently
   loses state if it breaks. Rubric / real-pi.

**Tier 2 — MEDIUM:**
3. **skill-exclude under real pi** (superpowers) **[D side-effect]** —
   `DEFAULT_SKILL_EXCLUDE` + env composition + the `-ns`/run-dir `--skill`
   splice. Unit-tested vs a mock only; never against real `resources_discover`.
   Real-pi behavioral check: assert the advertised skill paths.
4. **sdd-workspace `PLAN_FILE` / `PI_PLANNING_EFFORT` derivation** **[D]** — the
   pi-port glue (plan-basename from filename, effort nesting). Mis-derivation
   lands SDD files in the wrong dir. Golden-output: run the script with fixed
   args, assert the derived path.
5. **determinism** — neither ext has a `determinism · <ext>` CI job (hermes /
   obsidian / workflow do). Adding seeded determinism tests catches
   non-deterministic output.

**Tier 3 — LOWER (already largely unit-covered):**
6. Bootstrap injection lifecycle — `bootstrap.test.ts` covers session_start /
   compact / agent_end / dedup; edge cases only remain.
7. wayfind effort/stage detection — `effort-slug.test.ts` + `commands.test.ts`
   unit-cover it.

**Feeds 03:** paths 1, 4 are **[D]** → golden; path 2 is **[L]** → rubric;
path 3 is a real-pi side-effect check. 03 confirms the queue order + patterns.
The "wayfind skill runtime behavior" fog resolved — wayfind skills are largely
prompt-content; their runtime logic lives in unit-tested `src/`.
