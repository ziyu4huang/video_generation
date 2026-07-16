# pi-agent-ext-wayfind

The ubiquitous language of pi-agent-ext-wayfind — a Pi-native port of Matt Pocock's decision-chain skill suite. The grilling + wayfinder family turns a fuzzy plan or a huge effort into settled decisions *before any code is written*, leaving a paper trail (CONTEXT.md glossary + ADRs) and handing off to planning-with-files.

## Language

### The engine

**Grilling**:
The relentless, one-question-at-a-time interview at the heart of the suite. One question, a recommended answer for each, facts pulled from the environment, decisions deferred to the user.
_Avoid_: interview, Q&A, brainstorming (it is a single-question-at-a-time decision resolver, not open discussion)

**`grill-me`**:
The plain grilling variant — an interview with no artifacts.
_Avoid_: chat, session (it is a no-artifact grilling run)

**`grill-me-with-docs`** (flagship):
Grilling fused with `domain-modeling` — as terms resolve they're written to `CONTEXT.md`; hard-to-reverse decisions land as ADRs. The variant that leaves a paper trail.
_Avoid_: documented grilling, annotated grill (it is grilling + live domain capture, fused)

**Paper trail**:
The artifacts a with-docs grill leaves behind — the `CONTEXT.md` glossary (settled terms) + `docs/adr/` ADRs (load-bearing decisions), written inline as the grill runs.
_Avoid_: notes, transcript (it is structured domain artifacts, not a record)

### Domain capture

**`domain-modeling`**:
The glossary + ADR discipline — captures ubiquitous language into `CONTEXT.md` and crystallizes decisions as ADRs the moment they settle. Usable standalone (`/domain-modeling`) or fused into the flagship grill.
_Avoid_: documentation, specing (it is ubiquitous-language + decision capture, not prose docs)

**CONTEXT.md glossary**:
The opinionated term list a with-docs grill produces — each term with a tight definition and an `_Avoid_` list of synonyms not to use.
_Avoid_: dictionary, vocab (it is an opinionated project-specific ubiquitous-language file)

**ADR** (Architecture Decision Record):
A recorded hard-to-reverse decision, written during a with-docs grill when a decision crystallizes.
_Avoid_: note, decision log (it is a crystallized, dated decision record)

### Wayfinder

**Wayfinder**:
Charts an effort too big for one session as a local-markdown map of decision tickets, then works them one at a time until the route is clear. The decomposition tool for huge efforts.
_Avoid_: planner, roadmap (it is a ticket-map decomposition of an effort's open decisions)

**Map**:
The local-markdown index of an effort's decision tickets, stored under `.planning/<effort>/` (no issue-tracker dependency).
_Avoid_: backlog, board (it is a markdown decision-map, not a kanban)

**Decision ticket**:
One open decision on the map, with dependencies, claim state, and a resolution block. Worked one at a time.
_Avoid_: issue, task (it is a decision to be settled, not work to be done)

**Frontier**:
The set of open, unblocked, unclaimed tickets computeFrontier returns — the next workable decisions, ascending by id.
_Avoid_: queue, next-up (it is the dependency-resolved workable set)

### Synthesis

**`to-spec`**:
Synthesize the resolved decisions + glossary into a spec.
_Avoid_: specing, writing (it is the grill→spec synthesis step)

**`to-tickets`**:
Flatten decisions into tickets (optionally seeding a `task_plan.md` — the bridge into planning-with-files' execution substrate).
_Avoid_: planning, breakdown (it is the decision→ticket synthesis)

### Coordination

**Coordination seam** (`globalThis.__piWayfindActive`):
The process-singleton reader wayfind publishes so planning-with-files can **yield** during a live grill/wayfinder session — mirror of the `goal↔planning` pattern. Graceful: if either side is absent, the seam is a no-op.
_Avoid_: hook, signal (it is a published globalThis reader for cross-extension turn-ownership)

**grill→plan handoff** (`/grill-done --seed-plan`):
Ends the grill and synthesizes the resolved decisions + `CONTEXT.md` glossary into a `task_plan.md` seed, which planning-with-files then drives via `/plan-execute`.
_Avoid_: export, transfer (it is a synthesis + handoff into the planning substrate)
