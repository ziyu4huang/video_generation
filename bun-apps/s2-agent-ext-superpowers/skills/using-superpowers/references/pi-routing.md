# Pi Pipeline Routing (this repo)

The full routing detail behind the bootstrap's terse "Pipeline routing" section
(ADR-superpowers-0010 token diet: the bootstrap carries the essentials + this
pointer; the detail loads on demand via `read`).

Superpowers and Wayfind share the `.planning/<effort>/` layout. Two rules:

**1. One canonical home.** Every artifact lives under `.planning/<effort>/`:
specs → `.planning/<effort>/spec.md`, plans → `.planning/<effort>/plan.md`,
the SDD workspace → `.planning/<effort>/sdd/<plan-basename>/`
(briefs/reports/reviews + recovery ledger at
`.planning/<effort>/sdd/<plan-basename>/progress.md`), brainstorm mockups →
`.planning/<effort>/brainstorm/`. `scripts/sdd-workspace PLAN_FILE` resolves
the plan's dir and honors `PI_PLANNING_EFFORT`. No-effort specs/plans land in
`.planning/specs/` / `.planning/plans/`; `.planning/` is the sole artifact
home — no artifact is ever written outside it (no-effort SDD → flat,
gitignored `.planning/sdd/`).

**2. Pick the pipeline by stage — check what's on disk first.**

| Stage | Trigger (check disk) | Pipeline |
|---|---|---|
| DECIDE | no spec, decisions open / route foggy | Wayfind — grilling (or /wayfind) |
| SYNTHESIZE | grill just settled; spec needed | Wayfind — to-spec (synthesize only) |
| DESIGN | requirement clear, zero open decisions | Superpowers — brainstorming |
| PLAN | spec exists, no plan | Superpowers — writing-plans |
| EXECUTE | plan exists | Superpowers — executing-plans / SDD |

Four of five stages are a disk check; only DECIDE-vs-DESIGN needs judgment.
When in doubt, DECIDE first.
