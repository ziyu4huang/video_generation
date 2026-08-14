**ID:** `ADR-superpowers-0006` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# 0006 — The superpowers ↔ subagent cooperation contract

**Status:** accepted (2026-07-25; part of the `2026-07-25-align-superpowers-with-subagent-ext` effort)

This ADR records how `pi-agent-ext-superpowers` cooperates with the standalone
`pi-agent-ext-subagent` package after the latter was extracted out of
`pi-agent-ext-workflow` (see that package's ADR-0001). It exists because the two
extensions interact, but **not** through a code dependency — the interaction is
entirely at the instructional layer, which makes the rules for keeping that
layer correct non-obvious.

## Context: the extraction

The subagent subsystem — the `subagent`/`subagent_runs` tools, the
`WorkflowAgent` runner, `spawnSubagent`, the in-flight registry, run-persistence,
agent-registry, model-tier, worktree, and the SDD-report parser — was extracted
into `pi-agent-ext-subagent`. That package ships its own extension (Design B) so
the tools load independently of the workflow engine. Workflow stopped
registering the tools and now only reads the singletons for its `/subagents`
viewer; it re-exports `spawnSubagent` from its root purely for back-compat.

`pi-agent-ext-superpowers` was named in the extraction ADR as one of the peer
consumers that "had to depend on the whole workflow package just to make one
child-model call." This ADR clarifies that, for superpowers specifically, that
framing is **aspirational, not actual**: superpowers never imported
`spawnSubagent` in code. Its entire relationship to the subagent capability is
the instructional text that tells the agent how to call the `subagent` tool.

## The five rules of the cooperation

### 1. Consumption is purely the LLM tool path — no code import

superpowers drives subagents via the agent emitting `subagent({...})` tool calls
(the SDD flow: controller dispatches an implementer/reviewer per task). It does
**not** import `spawnSubagent`, `WorkflowAgent`, or any singleton. Verified:
`grep -rn spawnSubagent` across `pi-agent-ext-superpowers/{src,extensions}`
returns nothing; the only importers in the repo are `pi-agent-ext-subagent`
(owner) and `pi-agent-ext-workflow` (back-compat re-export).

**Consequence.** The module-identity rule from subagent ADR-0001 (singletons
must be imported via the `@repo/pi-agent-ext-subagent/src/*` subpath) does **not**
apply to superpowers — it imports no singletons. If a future superpowers feature
ever needs *programmatic* dispatch, import values/types from the package root
(`@repo/pi-agent-ext-subagent`); only the two singletons demand the `src/`
subpath, and only a viewer/command would need those (not superpowers' role).

### 2. The SDD status contract composes without either side forking

The byte-identical SDD implementer-prompt (`skills/subagent-driven-development/
implementer-prompt.md`, pinned verbatim per ADR-0004) instructs the implementer
to close with a `**Status:** DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED`
block. The `subagent` tool **auto-parses** that block into `details.report`
(`SddReport`) — a separate axis from the process status (`done`/`failed`/
`timedout`): a run can finish while self-reporting BLOCKED.

The two compose with **zero coordination**: the parser reads the prompt's
*output*, never the template. superpowers keeps the prompt byte-identical; the
tool owns parsing. Neither side needs to know the other changed. This is why the
extraction did not require any SDD skill-body edit.

### 3. Single source of truth for subagent usage detail

Two instructional surfaces mention the `subagent` tool:

- **`src/superpowers.ts` `piToolMapping()`** — injected into context every
  session (until the first `agent_end`). Must be **self-contained**: the agent is
  not guaranteed to read the reference before its first dispatch.
- **`skills/using-superpowers/references/pi-tools.md`** — read on demand when
  the using-superpowers skill loads on Pi (its "Platform Adaptation" section
  links it).

**Decision:** `references/pi-tools.md` is the **canonical full doc** (full param
surface, rationale, every capability). `piToolMapping()` is a **terse, accurate
summary** carrying only the directives the agent must act on every dispatch,
closing with an explicit deferral ("full param surface + rationale: read
`references/pi-tools.md`"). Both name the correct package: `pi-agent-ext-subagent`.

This closes the prior drift, where the two surfaces disagreed (the reference
carried parallel-fan-out / auto-SDD-status / auto-persistence notes the bootstrap
omitted, and both named the wrong package). Primary/secondary beats duplication:
one authoritative detail doc, one always-present summary that defers to it.

### 4. Divergence from upstream lives at the injection layer only

The byte-identical skill bodies stay verbatim (ADR-0004). Every Pi-side
divergence is applied in our own `src` / `references`:

- **tier-over-model** — the upstream SDD skill says "always specify the model
  explicitly" (a raw `model:` id). On Pi we teach `tier` instead (rule 5 below).
- **parallel-via-workflow** — the upstream `dispatching-parallel-agents` says
  "issue all dispatches in one response, they run in parallel." On Pi the
  `subagent` tool is `executionMode: sequential`, so concurrent fan-out must go
  through the `workflow` tool's `parallel()`.
- **commitScope** — the SDD commit-hygiene guardrail (catch the `git add -A`
  sweep) is a Pi-tool capability, taught at the injection layer.

These never edit a pinned body. This is the operating consequence of ADR-0004
("don't fork verbatim bodies") and ADR-0005 ("express divergence at the injection
layer").

### 5. Decision: SDD dispatches prefer `tier` over raw `model`

The `subagent` tool's own schema recommends `tier` (`'small'|'medium'|'big'`,
resolved from `~/.pi/workflows/model-tiers.json` via `/workflows-models`) over a
concrete `model` id, because a raw id is user-specific and breaks if that
provider isn't configured, while `tier` is portable and user-tunable. Override
priority: `model` > `tier` > session model.

**Decision:** SDD dispatches pass `tier` where the byte-identical prompt's
`model:` field asks for a model. SDD role→tier convention:

| SDD role | tier | why |
| --- | --- | --- |
| implementer / fix | `medium` | the workhorse — capable enough for real implementation, not wasteful |
| focused research / exploration | `small` | read-mostly, high count, cheap is right |
| synthesis / final code review | `big` | the one dispatch where quality matters most |

This is guidance, not a hard contract — a controller may still pass an explicit
`model` when it has a reason. It aligns superpowers with the tool's own stated
preference and makes SDD portable across users without per-user prompt edits.

## Consequences

- superpowers' instructional layer names `pi-agent-ext-subagent` in both the
  bootstrap and the reference; the bootstrap test asserts the correct package
  (and asserts the stale `pi-agent-ext-workflow` string is absent).
- A host that loads only `pi-agent-ext-subagent` (Design B's premise) gets
  accurate guidance from the superpowers bootstrap — it no longer claims the
  tool comes from a workflow package that may not be installed.
- The two-source drift is closed by a primary (reference) / secondary (bootstrap)
  relationship, not by deleting either surface.
- No upstream skill body is edited; all divergence remains at the injection layer
  (ADR-0004/0005 compliant).

## Considered alternatives

- **Have superpowers import `spawnSubagent` and dispatch programmatically.**
  Rejected — the SDD flow is fundamentally agent-driven (the controller emits
  tool calls so the child gets an isolated context and the controller's context
  stays lean for coordination). Programmatic dispatch would re-couple superpowers
  to the subagent package for no benefit and against the skill's design.
- **Embed the full mapping in the bootstrap and delete the reference.** Rejected
  (this is dedup-strategy B from the spec) — the bootstrap is injected every
  session, so bloating it raises per-session token cost for every conversation,
  and the reference is the canonical surface the using-superpowers skill links.
  Terse-summary + deferral (strategy A, chosen) keeps the bootstrap lean while
  guaranteeing the always-present essentials are correct.

## Related

- `pi-agent-ext-subagent/docs/adr/0001-why-extracted.md` — the extraction, the
  singleton module-identity rule, Design B.
- `0004-skill-fidelity-positive-pin.md` — don't fork verbatim skill bodies.
- `0005-parallel-coexistence-boundary.md` — express superpowers↔wayfind
  divergence at the injection layer (this ADR is the subagent analogue).
