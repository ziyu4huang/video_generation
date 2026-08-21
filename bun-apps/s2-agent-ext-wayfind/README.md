# s2-agent-ext-wayfind

> **Part of the [Superpowers](../s2-agent-ext-superpowers/README.md) ecosystem** — the grilling + wayfinder family is the decompose-and-decide phase of the Superpowers methodology.

A **Pi-native** port of [Matt Pocock's decision-chain skill suite](https://github.com/mattpocock/skills) — the grilling + wayfinder family that turns a fuzzy plan or a huge effort into settled decisions before any code is written. Ships as a first-class Pi extension package: CSO-compliant skills **plus** slash commands that kick off grilling/wayfinding sessions.

**Pure TypeScript — no `python3`, no shell.** The grilling/wayfinding interview is driven by the agent; the extension provides the commands and the on-disk map store, plus a reverse-seam read that closes tickets when a plan coordinator reports a Task complete.

## What it does

| capability | implementation |
|---|---|
| 16 skills | core family: grilling, grill-me, grill-me-with-docs (flagship), domain-modeling, to-spec, to-tickets — plus ask-matt (router), codebase-design, handoff, improve-codebase-architecture, resolving-merge-conflicts, teach, to-questionnaire, triage, wait-what, wizard |
| 2 dispatcher slash commands | `/grill [me\|docs\|done\|domain]` (`docs` is flagship), `/wayfind [<destination>\|status\|spec\|tickets\|seed\|sync\|done\|validate]` |
| reverse seam | reads the plan coordinator's `globalThis.__piPlanPhases` to close tickets whose Task reported `completed` (ADR-wayfind-0003). **No forward coordination seam is published**: mutual-exclusion between a grill/wayfinder session and `/goal` or `/loop` is user-initiated — run one driver at a time |
| continuous chain | `/grill docs → /wayfind spec → /wayfind tickets → /wayfind seed → execute the plan → /wayfind sync` — lossless handoffs + a closed feedback loop (ADR-wayfind-0003) |
| wayfinder map store | local-markdown map + tickets under `.planning/<effort>/` (no issue-tracker dependency) |
| domain artifacts | `CONTEXT.md` glossary + `docs/adr/` ADRs, written inline during a with-docs grill |

## The flagship: `/grill docs`

A relentless, one-question-at-a-time interview that **leaves a paper trail**. As terms resolve they're written to `CONTEXT.md`; hard-to-reverse decisions land as ADRs. When you reach shared understanding, `/grill done --seed-plan` synthesizes the resolved decisions + glossary into a `task_plan.md` — then execute the plan.

```
grill docs → wayfind spec → wayfind tickets → (execute the plan) → implement → code review (superpowers requesting-code-review/receiving-code-review)
```

## Where it fits

```
wayfind ──► grill docs ──► wayfind tickets ──► the plan coordinator
(decompose)   (interview + CONTEXT/ADR)  (synthesize)   (task_plan.md substrate)
```

- **grilling** is the engine: one question at a time, a recommended answer for each, facts from the environment, decisions to the user.
- **grill docs** = grilling + `domain-modeling` (the glossary + ADR capture), fused.
- **wayfinder** charts an effort too big for one session as a local-markdown map of decision tickets, then works them one at a time until the route is clear.

## Commands

| command | what it does |
|---|---|
| `/grill me [topic]` | kick off a plain grilling interview (no artifacts) |
| `/grill docs [topic]` | **flagship** — grilling + writes `CONTEXT.md` glossary + ADRs inline |
| `/grill done [--seed-plan]` | end the grill; `--seed-plan` reads `CONTEXT.md` + writes a `task_plan.md` seed (handoff to the plan coordinator) |
| `/grill domain` | kick off the glossary + ADR discipline directly |
| `/wayfind [destination]` | chart a new map under `.planning/<effort>/`; (no args) work the next frontier ticket; `/wayfind -- <destination>` force-charts a name that begins with a reserved keyword (`status`/`spec`/`tickets`/`seed`/`sync`/`done`/`validate`) |
| `/wayfind status [effort]` | show the frontier + open/closed/claimed/fog counts |
| `/wayfind spec [effort]` | synthesize the conversation + codebase into a spec (PRD) at `.planning/<effort>/spec.md` |
| `/wayfind tickets [effort]` | break a spec/plan into tracer-bullet tickets (unified spine format) under `.planning/<effort>/tickets/` |
| `/wayfind seed [effort]` | route-aware: flatten tickets (topo-sorted, `[ticket-id]` phase headers) or CONTEXT.md decisions into a `task_plan.md`; refuses to overwrite |
| `/wayfind sync [effort]` | close wayfind tickets whose plan coordinator phase reported completed (the loop's feedback half) |
| `/wayfind done [effort]` | closing ceremony: harvest the map into output/next-goal-<ts>.md + surface the next goal |
| `/wayfind validate [effort]` | validate effort structure: tickets, frontmatter, blocking edges |
| `/wayfind statusbar on\|off` | toggle the opt-in status-bar section (`🧭 wayfind │ …` on ext-task's shared widget; persisted in `~/.pi/agent/settings.json`) |
| `/wayfind help` / `usage` | subcommand table + on-disk efforts ranked by recency |

## Reverse seam (plan coordinator → wayfind)

Both extensions can be loaded in the same pi process. wayfind has **no forward coordination seam** and there is no plan-coordinator yield: mutual-exclusion between a grill/wayfinder session and `/goal` or `/loop` is user-initiated — run one driver at a time. (wayfind does publish the grill-specific `globalThis.__piWayfindGrill`, consumed by hermes-memory; and it reads the plan coordinator's `globalThis.__piPlan*` keys below.)

**Reverse seam (ADR-wayfind-0003).** The coordination is bidirectional. `syncChainState` (auto-run at `/wayfind`, `/wayfind status`, `/wayfind seed`, and on demand via `/wayfind sync`) reads the plan coordinator's published `globalThis.__piPlanPhases(cwd) → [{id, status, ticketIds?}]` and **closes any ticket whose Task reports `completed`** — appending a decision line to the effort's `map.md`. A Task header references a ticket by id or stem (`### Task N — [03-foo]`); both resolve. Idempotent (already-closed → skipped) and graceful (no-op when the plan coordinator is absent). This is what makes the chain a *loop*, not a one-way handoff: ticket → Task → execute → close. The seam is 4 globalThis keys; neither package imports the other.

## Install (local)

Registered in the deploy manifest (`bun-apps/s2-agent/run-dir/manifest.json`) — the bundler picks it up. For ad-hoc loading:

```bash
pi -e ./bun-apps/s2-agent-ext-wayfind/extensions/wayfind.ts
```

Both load the extension **and** the skills via the `pi` manifest in `package.json`.

## Verify

```bash
( cd bun-apps/s2-agent-ext-wayfind && bun run test )   # biome check + bun test (tests/)
```

CSO skill rules + pure helpers (grill priming, plan-seed, glossary parse, map frontier computation, ticket lifecycle) are all unit-tested with no LLM, no network.

## Locally deleted skills (2026-08-16) — do NOT re-port

Six methodology skills were deliberately removed 2026-08-16, superseded by superpowers counterparts — do NOT re-port/re-add them from Matt Pocock's upstream suite (era simplification, ADR-wayfind-0007; plan `.planning/plans/2026-08-16-solution-extension-simplification.md`). `skills/ask-matt/SKILL.md` carries the user-facing redirect table (expires at the `0.2.0` release marker, per `docs/versioning.md`):

| deleted wayfind skill | superseded by superpowers |
|---|---|
| `research` | `dispatching-parallel-agents` (background research subagent + cited findings artifact) |
| `prototype` | `brainstorming` (prototype pointer section) |
| `subagent-dispatch-discipline` | `dispatching-parallel-agents` (pre-dispatch guardrails) |
| `code-review` | `requesting-code-review` + `receiving-code-review` (Standards-vs-Spec dual axis) |
| `diagnosing-bugs` | `systematic-debugging` (reproduction-loop engineering) |
| `writing-for-agents` | `writing-skills` (generalized to all agent-consumed docs) |

## Source & license

Adapted from Matt Pocock's [skills](https://github.com/mattpocock/skills) (MIT). Pi-native port by the video_generation monorepo. MIT.

**Ported skills** — batch 1 (PR #1138): `prototype`, `resolving-merge-conflicts`, `to-questionnaire`, `wizard`, `handoff`. Batch 2 (2026-08-09): `diagnosing-bugs`, `research`, `wait-what` — ported from mattpocock/skills @ `84fdeff` with pi adaptations (Use-when frontmatter, `.planning/<effort>/` convention, superpowers routing).

## Moved out

architecture:render moved to s2-agent-ext-archify (2026-08-16) — do not re-add here.
