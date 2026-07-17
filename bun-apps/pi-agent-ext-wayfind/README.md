# pi-agent-ext-wayfind

A **Pi-native** port of [Matt Pocock's decision-chain skill suite](https://github.com/mattpocock/skills) — the grilling + wayfinder family that turns a fuzzy plan or a huge effort into settled decisions before any code is written. Ships as a first-class Pi extension package: CSO-compliant skills **plus** slash commands that kick off grilling/wayfinding sessions.

**Pure TypeScript — no `python3`, no shell.** The grilling/wayfinding interview is driven by the agent; the extension provides the commands, the on-disk map store, and a coordination seam with `pi-agent-ext-planning-with-files`.

## What it does

| capability | implementation |
|---|---|
| 7 skills | grilling, grill-me, grill-me-with-docs (flagship), domain-modeling, to-spec, to-tickets, wayfinder |
| 2 dispatcher slash commands | `/grill [me\|docs\|done\|domain]` (`docs` is flagship), `/wayfind [<destination>\|status\|spec\|tickets\|seed\|sync]` |
| coordination seam | publishes `globalThis.__piWayfindActive`; **planning-with-files yields** its injection/auto-continue during a live grill (mirror of the `goal↔planning` pattern). Reverse: reads pwf's `globalThis.__piPlanPhases` to close tickets whose phase completed |
| continuous chain | `/grill docs → /wayfind spec → /wayfind tickets → /wayfind seed → /plan execute → /wayfind sync` — lossless handoffs + a closed feedback loop (ADR-0001) |
| wayfinder map store | local-markdown map + tickets under `.planning/<effort>/` (no issue-tracker dependency) |
| domain artifacts | `CONTEXT.md` glossary + `docs/adr/` ADRs, written inline during a with-docs grill |

## The flagship: `/grill docs`

A relentless, one-question-at-a-time interview that **leaves a paper trail**. As terms resolve they're written to `CONTEXT.md`; hard-to-reverse decisions land as ADRs. When you reach shared understanding, `/grill done --seed-plan` synthesizes the resolved decisions + glossary into a `task_plan.md` — hand it to planning-with-files with `/plan execute`.

```
grill docs → wayfind spec → wayfind tickets → (planning-with-files /plan execute) → implement → code-review
```

## Where it fits

```
wayfind ──► grill docs ──► wayfind tickets ──► planning-with-files
(decompose)   (interview + CONTEXT/ADR)  (synthesize)   (task_plan.md substrate)
```

- **grilling** is the engine: one question at a time, a recommended answer for each, facts from the environment, decisions to the user.
- **grill docs** = grilling + `domain-modeling` (the glossary + ADR capture), fused.
- **wayfinder** charts an effort too big for one session as a local-markdown map of decision tickets, then works them one at a time until the route is clear.

## Commands

| command | what it does |
|---|---|
| `/grill me [topic]` | kick off a plain grilling interview (no artifacts) |
| `/grill docs [topic]` | **flagship** — grilling + writes `CONTEXT.md` glossary + ADRs inline; publishes the coordination seam |
| `/grill done [--seed-plan]` | end the grill; `--seed-plan` reads `CONTEXT.md` + writes a `task_plan.md` seed (handoff to planning-with-files) |
| `/grill domain` | kick off the glossary + ADR discipline directly |
| `/wayfind [destination]` | chart a new map under `.planning/<effort>/`; (no args) work the next frontier ticket |
| `/wayfind status [effort]` | show the frontier + open/closed/claimed/fog counts |
| `/wayfind spec [effort]` | synthesize the conversation + codebase into a spec (PRD) at `.planning/<effort>/spec.md` |
| `/wayfind tickets [effort]` | break a spec/plan into tracer-bullet tickets (unified spine format) under `.planning/<effort>/tickets/` |
| `/wayfind seed [effort]` | route-aware: flatten tickets (topo-sorted, `[ticket-id]` phase headers) or CONTEXT.md decisions into a `task_plan.md`; refuses to overwrite |
| `/wayfind sync [effort]` | close wayfind tickets whose planning-with-files phase reported complete (the loop's feedback half) |

## Coordination with planning-with-files

Both extensions are loaded in the same pi process. wayfind publishes `globalThis.__piWayfindActive = () => boolean`; planning-with-files reads it (via `isExternalDriverActive()`, alongside its existing `/goal` check) and **yields** its plan injection + auto-continue while a grill or wayfinder session is active — so the two never double-drive. The status bar shows `… — /goal or /grill driving, injection yielded`. Graceful: if either side is absent, the seam is a no-op.

**Reverse seam (ADR-0001).** The coordination is bidirectional. `syncChainState` (auto-run at `/wayfind`, `/wayfind status`, `/wayfind seed`, and on demand via `/wayfind sync`) reads pwf's published `globalThis.__piPlanPhases(cwd) → [{id, status, ticketIds?}]` and **closes any ticket whose phase reports `complete`** — appending a decision line to the effort's `map.md`. A phase header references a ticket by id or stem (`### Phase N — [03-foo]`); both resolve. Idempotent (already-closed → skipped) and graceful (no-op when pwf is absent). This is what makes the chain a *loop*, not a one-way handoff: ticket → phase → execute → close. The seam is 4 globalThis keys; neither package imports the other.

## Install (local)

Registered in the deploy manifest (`bun-apps/pi-agent/run-dir/manifest.json`) — the bundler picks it up. For ad-hoc loading:

```bash
pi -e ./bun-apps/pi-agent-ext-wayfind/extensions/index.ts
```

Both load the extension **and** the skills via the `pi` manifest in `package.json`.

## Verify

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test )   # 103 tests, 0 fail
```

CSO skill rules + pure helpers (grill priming, plan-seed, glossary parse, map frontier computation, ticket lifecycle) are all unit-tested with no LLM, no network.

## Source & license

Adapted from Matt Pocock's [skills](https://github.com/mattpocock/skills) (MIT). Pi-native port by the video_generation monorepo. MIT.
