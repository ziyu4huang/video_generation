## Question

Author the **Layer-1 probe-prompt corpus** — the deterministic capability signal
that becomes the CI-runnable gate. Raise fidelity by making it a concrete
artifact to react to (a curated prompt table + assertions), not a spec.

**Per gate in `GATES`, three case classes:**
1. **Must-fire** — intent-bearing prompts that MUST activate the gate (e.g.
   "generate an image of a cat" → flux2 gate; "orchestrate a montage" → movie).
   Include CJK keywords (圖像, 分鏡) and co-occurrence cases.
2. **Must-NOT-fire (lookalikes)** — plausible prompts that share a keyword but
   lack intent, to catch false-fires (e.g. "docker image", "video call" must NOT
   fire flux2/ltx). This is where `requires` co-occurrence earns its keep.
3. **Escape-hatch reachable** — a miss prompt where `enable_tool({ intent })` /
   `enable_tool({ name })` must surface the gate (assert via `matchIntent`).

**Assert against the pure exports directly** — `gateFires`, `matchesKeyword`,
`matchIntent`, `filterActive` — NO agent run, NO LLM. This is what makes it a
deterministic gate.

**Decisions to surface while authoring:** which gates lack lookalike coverage
(gap report); whether any keyword is so broad it needs `requires` added.

**Deliverable:** a probe-corpus data file + a bun-test that runs the three case
classes per gate. This is ticket 02's L1 payload.

**type:** prototype
**blocked by:** —
**claimed:** wayfind-session (2026-07-23) — ✅ CLOSED

## Resolution

Built `qa/probes.ts` (corpus) + `qa/probes.test.ts` (runner). **158 tests,
all green** (83 existing + 75 new L1 probes). Pure-function assertions only —
`gateFires` / `matchIntent` / `GATES` — no agent run, no LLM. Auto-discovered by
`bun test`, so it's already the CI-runnable L1 gate (ticket 02 will assemble it
with savings into the unified entrypoint).

### Coverage (all 9 gates)
27 must-fire · 18 must-not-fire · 9 escape-name · 9 escape-intent. Every gate
has both a must-fire and a must-not-fire (`gates missing coverage: none`).

### Gap report — capability is NOT fully preserved

**(A) 6 precision FALSE-FIRES** (tracked as characterization tests — assert
they fire today; turn red the moment tool-gate is fixed, then move to
MUST_NOT_FIRE):
- `[high]` **inspect** — bare `inspect` fires on *"inspect element in chrome
  devtools"* (browser devtools, not agent introspection)
- `[med]` **flux2** — *"make the docker image smaller"* (noun `image` ∧ verb
  `make` — requires co-occurrence over-matches dev/infra)
- `[med]` **ltx** — *"make the video buffer larger"* (noun `video` ∧ verb `make`)
- `[med]` **workflow** — *"the gitlab pipeline failed"* (keyword `pipeline` →
  CI/CD context)
- `[med]` **workflow** — *"review this multi-step todo list"* (keyword
  `multi-step` → plain todo)
- `[med]` **movie** — *"the movie director won an oscar"* (keyword `movie
  director` → a person, not a request)

**(B) 1 keyword OVERLAP** — `storyboard` fires BOTH ltx + movie → ambiguous
routing.

**(C) 4 escape-intent BLIND gates** — `enable_tool({ intent })` CANNOT reach
these without a keyword; only `name`-mode is a guaranteed escape:
- **krea2**, **zai-mcp**, **inspect** — a reasonable keyword-free intent (even
  the gate's own description) misses in `matchIntent` (which matches keywords /
  requires only, NOT description — confirmed by design in tool-gate.ts).
- **movie** — *"orchestrate scenes into a film"* **mis-routes to workflow**
  ("orchestrate" is a workflow keyword).

**(D) Dead keyword observed** — workflow's `fan.out` (with a dot) never matches
real prompts (`fan-out` / `fan out`); effectively unreachable. (Not asserted —
flagged here for a tool-gate fix.)

### Implications handed forward

- **Ticket 05 (verdict):** capability preservation FAILS the strict bar today —
6 false-fires + 4 blind intent-gates are real precision/recall gaps. The
  verdict must weigh "savings (real, ~5.5k) vs these gaps". Note the asymmetry:
  false-fires are *benign* (extra tool loads, minor token cost), but blind
  intent-gates + mis-routes can *break* a task (agent can't reach the tool by
  intent) — the higher-severity half.
- **Ticket 04 (L2 task suite):** seed tasks that probe these weak spots — a
  false-fire task (does the docker-image false-fire hurt?), and a blind-gate
  task (does the agent reach krea2 by *name* when intent-mode would miss?).
- **Fixing tool-gate** is out of scope (we verify, not fix). The
  characterization tests auto-detect any future fix.

**Asset:** `qa/probes.ts` + `qa/probes.test.ts`.
