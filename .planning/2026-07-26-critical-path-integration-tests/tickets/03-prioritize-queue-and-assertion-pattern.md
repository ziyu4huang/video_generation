## Question

Once 01 enumerates + ranks the critical paths: (a) **prioritize the test
queue** — which paths get integration tests first (top of the risk rank), and
(b) pick the **assertion pattern** per path:

- **Phase-3-style behavioral rubric** (probe-runner A/B + a scored rubric) — for
  LLM-behavior-dependent paths (fix-loop correctness, skill-exclude effect on
  routing).
- **Golden-output assertion** — for deterministic paths (routing stage
  detection given a fixed disk layout, sdd-workspace PLAN_FILE derivation).
- **Real-pi behavioral check** — assert an observable side effect (a file
  written, a path advertised) without scoring model output.

The pattern depends on whether the path is deterministic (golden) or
LLM-behavior-dependent (rubric). 01's classification of each path feeds this.

blocked by: 01-enumerate-and-risk-rank-critical-paths

type: grilling

---

**Status: closed** — graduated (2026-07-26). Determined by 01 + 02, not separately grilled.

## Resolution

The queue order + assertion pattern are fully determined by 01's risk-rank
+ 02's [D]→buntest/CI vs [L]→real-pi/local split — no open decision remained, so
this ticket graduated straight into a plan (see `../plan.md`) rather than a
grill round:

- **Queue = 01's rank:** sdd-workspace derivation → (matrix slot) → real-pi
  probes (skill-exclude, fix-loop) → determinism-spotcheck.
- **Pattern per path = the [D]/[L] tag from 01:** [D] → golden-output buntest
  (sdd-workspace, CI); [L] → rubric real-pi probe (fix-loop, local-smoke);
  skill-exclude → real-pi side-effect check (local-smoke).

**Scope correction on graduation:** reading the code showed 01 over-stated the
piBoundaryOverrides gap — it is a pure string generator whose content is
already asserted by `bootstrap.test.ts` (lines 171-210). The only genuine
deterministic gap is `sdd-workspace` (bash, untested). The plan reflects this
(2 deterministic tasks + documented real-pi follow-up).
