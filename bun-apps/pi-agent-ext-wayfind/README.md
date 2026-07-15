# pi-agent-ext-wayfind

A **Pi-native** port of [Matt Pocock's decision-chain skill suite](https://github.com/mattpocock/skills) — the grilling + wayfinder family that turns a fuzzy plan or a huge effort into settled decisions before any code is written. Ships as a first-class Pi extension package: CSO-compliant skills **plus** slash commands that kick off grilling/wayfinding sessions.

**Pure TypeScript — no `python3`, no shell.** The grilling/wayfinding interview is driven by the agent; the extension provides the commands, the on-disk map store, and a coordination seam with `pi-agent-ext-planning-with-files`.

## What it does

| capability | implementation |
|---|---|
| 8 skills | grilling, grill-me, grill-with-docs, grill-me-with-docs (flagship), domain-modeling, to-spec, to-tickets, wayfinder |
| 5 slash commands | `/grill-me`, `/grill-me-with-docs` (flagship), `/grill-done [--seed-plan]`, `/domain-modeling`, `/wayfinder [destination]`, `/wayfinder-status` |
| coordination seam | publishes `globalThis.__piWayfindActive`; **planning-with-files yields** its injection/auto-continue during a live grill (mirror of the `goal↔planning` pattern) |
| grill→plan handoff | `/grill-done --seed-plan` reads the `CONTEXT.md` glossary + writes a `task_plan.md` seed → run `/plan-execute` |
| wayfinder map store | local-markdown map + tickets under `.planning/<effort>/` (no issue-tracker dependency) |
| domain artifacts | `CONTEXT.md` glossary + `docs/adr/` ADRs, written inline during a with-docs grill |

## The flagship: `/grill-me-with-docs`

A relentless, one-question-at-a-time interview that **leaves a paper trail**. As terms resolve they're written to `CONTEXT.md`; hard-to-reverse decisions land as ADRs. When you reach shared understanding, `/grill-done --seed-plan` synthesizes the resolved decisions + glossary into a `task_plan.md` — hand it to planning-with-files with `/plan-execute`.

```
grill-me-with-docs → to-spec → to-tickets → (planning-with-files /plan-execute) → implement → code-review
```

## Where it fits

```
wayfinder ──► grill-me-with-docs ──► to-tickets ──► planning-with-files
(decompose)   (interview + CONTEXT/ADR)  (synthesize)   (task_plan.md substrate)
```

- **grilling** is the engine: one question at a time, a recommended answer for each, facts from the environment, decisions to the user.
- **grill-me-with-docs** = grilling + `domain-modeling` (the glossary + ADR capture), fused.
- **wayfinder** charts an effort too big for one session as a local-markdown map of decision tickets, then works them one at a time until the route is clear.

## Commands

| command | what it does |
|---|---|
| `/grill-me [topic]` | kick off a plain grilling interview (no artifacts) |
| `/grill-me-with-docs [topic]` | **flagship** — grilling + writes `CONTEXT.md` glossary + ADRs inline; publishes the coordination seam |
| `/grill-done [--seed-plan]` | end the grill; `--seed-plan` reads `CONTEXT.md` + writes a `task_plan.md` seed (handoff to planning-with-files) |
| `/domain-modeling` | kick off the glossary + ADR discipline directly |
| `/wayfinder [destination]` | chart a new map under `.planning/<effort>/`; (no args) work the next frontier ticket |
| `/wayfinder-status [effort]` | show the frontier + open/closed/claimed/fog counts |

## Coordination with planning-with-files

Both extensions are loaded in the same pi process. wayfind publishes `globalThis.__piWayfindActive = () => boolean`; planning-with-files reads it (via `isExternalDriverActive()`, alongside its existing `/goal` check) and **yields** its plan injection + auto-continue while a grill or wayfinder session is active — so the two never double-drive. The status bar shows `… — /goal or /grill driving, injection yielded`. Graceful: if either side is absent, the seam is a no-op.

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
