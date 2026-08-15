# Phase-3 A/B results — skill-unload audit

**Method:** `bun scripts/probe-runner.ts probes/phase3-<skill>.ts --ab-skill <skill>` — fat (skill loaded) vs thin (`PI_SUPERPOWERS_SKILL_EXCLUDE=<skill>`), via `pi -p -ns` (routes skill-loading through the extension's `resources_discover`, which honors the exclude). 2 probes/skill. Gate: thin ≥ fat − 1 per rubric item AND zero structural regressions.

## Verdict

| Skill | Probes | Decision | Why |
|---|---|---|---|
| **test-driven-development** | tdd-clamp [3,3]→[0,3]; tdd-leapyear [3,3]→[0,3] | ❌ **KEEP** | Clear regression — rubric "writes test before implementation" dropped 3→0 on *both* probes. **Load-bearing.** |
| systematic-debugging | dbg-offbyone [3,3,1]→[2,2,0]; dbg-nullhandraw [0,0,0]→[3,0,0] | ⚠️ **KEEP** (inconclusive) | Technically within tolerance, but `dbg-nullhandraw` fat scored [0,0,0] — a skill-*loaded* run scoring zero on "forms hypothesis" is anomalous (649s/440s runtimes ⇒ load-degraded fat run). Signal too muddy to declare safe. |
| brainstorming | ratelimiter [3,3]→[3,3] struct:FAIL; settings [3,3]→[3,3] struct:ok | ⚠️ **KEEP** (gate-blocked) | Judge scores **identical** fat/thin ⇒ model already does explore-before-code. But the strict gate (zero structural regressions) tripped on a structural-regex false-negative in the ratelimiter prose. Evidence says unloadable; strict gate says no. |
| **verification-before-completion** | verify-primed [3,3]→[3,3]; verify-claim [3,3]→[3,3] | ✅ **UNLOAD** | Clean pass both probes — model resists confidence-priming equally well without the skill. |

## Headline finding

**The skills mostly earn their keep.** 3 of 4 candidates are NOT safely unloadable:
- **TDD is decisively load-bearing** — without it, the LLM stops writing tests first (3→0, both probes). The "LLM already knows TDD" hypothesis is **falsified**.
- **systematic-debugging** is inconclusive (load-noise collapsed a fat baseline to 0).
- **brainstorming** is behaviorally redundant (identical judge scores) but gate-blocked by an over-strict structural regex.

Only **verification-before-completion** (~139 tok) is cleanly redundant.

## Net prompt-weight outcome (this workstream)

| Phase | Saving | Status |
|---|---|---|
| 1 — slim `subagent`/`subagent_runs` schemas | ~265 tok/req | ✅ verified, probes PASS |
| 2 — thin 3 wayfind skill descriptions | ~112 tok/req | ✅ verified |
| 3 — skill unload | ~139 tok/req (verification only) | ⚠️ evidence supports; not auto-applied |
| **Total realized** | **~377 tok/req** | (Phase 3's ~139 is opt-in via `PI_SUPERPOWERS_SKILL_EXCLUDE`) |

## Recommendation

1. **Default-exclude `verification-before-completion`** via `PI_SUPERPOWERS_SKILL_EXCLUDE=verification-before-completion` in the session env (the knob from Task 5; trivially reversible). ~139 tok/req for ~zero behavioral cost.
2. **Keep TDD, systematic-debugging, brainstorming loaded** — the evidence says they change behavior.
3. **Optional follow-up:** (a) re-probe systematic-debugging under low load to resolve the noise; (b) relax the Phase-3 structural gate to judge-primary (would unlock brainstorming). Both deferred — low ROI.

## Artifacts

- Harness: `scripts/probe-runner.ts` (`--mode pi`, `--ab-skill`), `probes/phase3-*.ts`.
- Knob: `PI_SUPERPOWERS_SKILL_EXCLUDE` in `superpowers.ts` (`resources_discover`).
- Raw log: `probes/phase3-ab.log`.
