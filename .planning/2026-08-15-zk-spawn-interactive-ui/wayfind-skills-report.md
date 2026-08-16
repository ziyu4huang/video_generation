# Wayfind skill definitions — extraction report (task: zk-spawn)

> STATUS: budget exhausted mid-extraction. All 22 SKILL.md files were read and are
> reported below. The `/wayfind` slash-command layer (`src/commands.ts`,
> `src/wayfinder.ts`, `src/effort-query.ts`, `src/chain.ts`) was NOT yet read —
> the exact semantics of `purify` / `unify` / `search` / `continue` / `status`
> subcommands live there. Extracted knowledge about them is marked [INFERRED].
> Next agent: read those four files (~1.4k lines total) to finish.
> CLOSE-OUT 2026-08-16: wayfind purify complete — all 16 wayfind efforts archived DONE; 3 stale wayfind/* branches verified LANDED and swept; the follow-up reading list below remains valid only if this effort still needs skill-extraction data.

## Locations

- Skills root: `bun-apps/pi-agent-ext-wayfind/skills/` — 22 skills, each `<name>/SKILL.md`
- No `skills/wayfind/SKILL.md` exists; the "wayfind" flow is the extension itself:
  entry `extensions/wayfind.ts` → `src/index.ts`, logic in `src/*.ts`
  (wayfinder.ts, commands.ts, chain.ts, lifecycle.ts, effort-query.ts,
  effort-tool.ts, grill.ts, map.ts, coordination.ts, overlay.ts, procedures.ts, state.ts…)
- `.pi/skills/` at repo root holds only `devops-workflow` + `pre-plan-runtime-validation` (not wayfind).

## CLI entry points

- Registered as a Pi extension (`package.json` `pi.extensions: ["./extensions/wayfind.ts"]`,
  `pi.skills: ["./skills"]`). Slash commands: `/wayfind`, `/grill`, `/triage` (from commands.ts).
- Referenced invocations seen in skills: `/wayfind spec`, `/wayfind tickets`,
  `/wayfind seed <effort>`, `/wayfind sync`, `/grill docs [topic]`, `/grill me`, `/grill done [--seed-plan]`,
  `/goal <line>` (TUI-only, agent cannot set it).
- package.json scripts (test gates per repo rules): `test` = `bun run check && bun run test:unit`
  (check = biome, NOT tsc); `typecheck` = `tsc --noEmit`; run BOTH `check && typecheck && test` for this package.

## Artifact conventions (shared across skills)

- Effort home: `.planning/<effort>/` — contains `map.md` (wayfinder), `spec.md` (to-spec),
  `tickets/` (to-tickets, one file per ticket `<NN>-<slug>.md`), `questionnaire.md`
  (to-questionnaire), `findings.md` or `research/` (research skill).
- Ticket status convention (to-tickets template frontmatter): `---\ntype: task\nblocking: 02, 05\nstatus: open\n---`
  — `status:` field in frontmatter (`open` / done presumably flips it; [INFERRED] `/wayfind sync`
  "closes the originating ticket" when a task_plan phase completes).
- Decision trail / ADRs: `docs/adr/` per-context, numbered `ADR-<context>-NNNN`; glossary `CONTEXT.md`
  (root = pure glossary; per-package may add one `_Source_:` `file#symbol` anchor per term,
  which must be verified live).
- Prototype artifacts: throwaway branch `prototype/<name>` out of main, pointer left on the
  originating ticket.

## The main flow (ask-matt router skill — the map over the family)

idea → ship:
1. `grill-me-with-docs` (interview + paper trail; stateful) — or `grill-me` if no working dir.
2. Branch — question needs a runnable answer? → `handoff` out → fresh session → `prototype` → `handoff` back.
3. Branch — multi-session build?
   - Yes → `to-spec` → `to-tickets` (tracer-bullet tickets under `.planning/<effort>/tickets/`) →
     `executing-plans` (superpowers ext) per ticket, fresh session between tickets; executing-plans
     drives `test-driven-development` internally, closes with `code-review`.
   - No → `executing-plans` in-session.
- Context hygiene: steps 1–3 in ONE unbroken session (don't hand off before to-tickets);
  smart zone ~150k tokens; at the boundary use `handoff` + fresh session.
On-ramps: `triage` (incoming issues/PRs → agent briefs); `systematic-debugging` (superpowers)
  → `diagnosing-bugs` when building the loop is the wall → post-mortem hands to
  `improve-codebase-architecture`; wayfinder for huge foggy efforts (see below).
Codebase health: `improve-codebase-architecture` (surfaces deepening opportunities) →
  picked idea enters main flow at grill-me-with-docs; `codebase-design` is the vocabulary bench.
Vocabulary layer: `domain-modeling` (glossary/ADR discipline), `codebase-design` (deep-module vocab).

## Wayfinder [PARTIALLY INFERRED — src/wayfinder.ts unread]

- Trigger: "a huge, foggy effort — greenfield project or huge feature build, too big for one
  session" where the way to the destination isn't visible. NOT for well-scoped features.
- Process (from ask-matt): charts a **shared map** of **decision tickets** under
  `.planning/<effort>/` (map.md per planning-artifact rule: `map.md` + `tickets/`), resolves them
  one at a time — producing **decisions, not deliverables** — until the way is clear.
  Driven by the **`/wayfind`** command; procedure text at `src/procedures/` (referenced as
  `procedures/wayfinder.md`).
- Handoff: "it hands off, it doesn't build" — when the map clears, merge to main flow at
  `to-spec` (collapses the map's linked decisions into a buildable plan) → `to-tickets`.
  Going straight to executing-plans skips the collapse — only when effort turned out small.
- `purify` / `unify` / `search` / `continue` / `status` subcommands: semantics NOT yet extracted.
  Hints from read material: `/wayfind seed <effort>` flattens the ticket frontier into a
  `task_plan.md` (one phase per ticket, topo-sorted by `blocking:`); `/wayfind sync` (or any
  `/wayfind*` touchpoint) closes originating tickets as phases complete; `/wayfind` checks
  branch freshness vs origin. Searching/listing all efforts: likely via `src/effort-query.ts`
  — [INFERRED] scans `.planning/*/` and ticket frontmatter `status:`; exact command unknown.

## Per-skill summaries (verbatim key points)

### ask-matt
Router over the wayfind family (above). disable-model-invocation. Refs PHASE-BOUNDARIES.md:
at a phase boundary — Continue / Fresh / handoff (only for switching harnesses, new dir,
colleague, mid-phase fork) / Subagent / handoff+fresh (the default at tree bottom).

### code-review
Two deliberately-separate axes: **Standards** (documented repo conventions) and
**Spec** (matches originating issue/ticket) — never merged or cross-ranked; every finding
cites its source. Steps: (1) pin fixed point (`git diff <fixed>...HEAD`, subshell-only git;
fail fast on bad ref/empty diff/uncommitted work) (2) find spec source (issue refs →
`.planning/specs|plans` → user path → "no spec available") (3) standards sources
(CLAUDE.md, AGENTS.md, nearest CONTEXT.md, docs/adr; + 12 Fowler smells as judgement-call
floor; repo docs override; skip what tooling enforces) (4) review both axes (Spec failure
shapes: Missing/Partial/Scope creep/Implemented wrongly) (5) aggregate two blocks, one
worst line per axis. "Do not delegate this review or spawn agents — perform it directly."

### codebase-design
Deep-module vocabulary: module/interface/implementation/depth/seam/adapter/leverage/locality.
Principles: deletion test; interface is the test surface; one adapter = hypothetical seam.
Refs DEEPENING.md, DESIGN-IT-TWICE.md (parallel subagents design interface 2+ ways).

### diagnosing-bugs
6 phases; Phase 1 IS the skill — build a tight, red-capable feedback loop (10 construction
tactics, tighten, raise repro rate on flaky bugs; HITL template last resort). Completion
criterion: name ONE command already run, red-capable + deterministic + fast + agent-runnable.
Phase 2 reproduce+minimise; Phase 3 3–5 ranked falsifiable hypotheses shown to user;
Phase 4 instrument (tag logs `[DEBUG-xxxx]`, change one variable); Phase 5 regression test
BEFORE fix (only if correct seam; "no correct seam" is itself the finding); Phase 6 cleanup +
post-mortem → hand to improve-codebase-architecture if architectural.

### domain-modeling
Active discipline of changing the model: challenge terms against glossary, sharpen fuzzy
language, stress-test scenarios, cross-reference code, update CONTEXT.md inline as terms
resolve (never batch). ADR only when hard-to-reverse + surprising-without-context + real
trade-off (all three). `_Source_:` anchors must be verified live (python one-liner included
in skill). Formats: CONTEXT-FORMAT.md, ADR-FORMAT.md.

### grill-me-with-docs
`/grill docs [topic]`. grilling + domain-modeling fused: writes terms to CONTEXT.md as they
resolve, ADRs rarely, ends `/grill done` or `/grill done --seed-plan` (seeds task_plan.md).
Chain: brainstorm → grill-me-with-docs → (to-spec → to-tickets)? → execute plan → close.

### grill-me
`/grill me` — plain stateless grilling session; loads `grilling` skill. No paper trail
(use /grill docs for that).

### grilling (the primitive)
Interview until shared understanding; map a **design tree**; work in **rounds**; the
**frontier** = decisions whose prerequisites are settled; ask whole frontier per round,
numbered, each with recommended answer (`❓ **Q1** … ➡️ recommended`). Facts are the agent's
job (dispatch subagent; don't block — downstream questions wait, ask the rest now); decisions
are the user's. Verify branch freshness before trusting gathered facts
(`git rev-list --count HEAD..origin/<default>`). Done when frontier empty; don't act until
user confirms shared understanding.

### handoff
Session ending → compact conversation into a handoff doc in **OS temp dir** (not workspace),
with "Suggested skills" section, referencing (not duplicating) existing artifacts, secrets
redacted.

### improve-codebase-architecture
[body partially read] Scan that scopes to where work happens (named direction or git hot
spots), spawns a subagent to walk code for friction, synthesizes deepening candidates in
codebase-design vocabulary using the deletion test, presents as committed Markdown+Mermaid
report renderable to offline HTML, grills the picked candidate. Never auto-fires.

### prototype
Throwaway program answering ONE design question; lives in own directory; keep on
`prototype/<name>` branch out of main; pointer on originating ticket under
`.planning/<effort>/tickets/`; verdict captured in decision trail. Refs LOGIC.md, UI.md.

### research
Background subagent investigates a question against PRIMARY sources only (official docs,
source, specs — a blog paraphrase is a lead not a citation); writes one cited Markdown file
saved per repo convention, else `.planning/<effort>/findings.md` or `research/`. Facts not
decisions — decisions go to grill-me-with-docs. Scope the dispatch per
subagent-dispatch-discipline.

### resolving-merge-conflicts
(1) see merge/rebase state (2) primary sources for each conflict (commits/PRs/issues)
(3) resolve hunk by intent, preserve both intents, never invent behavior, never `--abort`
(4) discover + run automated checks (typecheck, tests, format) (5) finish the merge/rebase.

### subagent-dispatch-discipline
Pre-dispatch checklist (every dispatch): (1) always set `tokenBudget`+`spendBudget`
(30–60k read-only; 80–150k SDD slice; 150–300k synthesis) (2) always set `commitScope` =
exact paths ([] for read-only); never let subagent `git add` selectively (3) tool-fit —
never delegate a task needing a tool the child lacks (4) bound the task; split if over tier
(5) right tool: `subagents` plural = read-only fan-out; `subagent` singular = one focused
side-effectful task; trivial write = do it yourself (6) tag tier small/medium/big.
Anti-patterns: no budget, `git add -A` in subagent, impossible tool-fit, detached-HEAD
re-verify, one giant task.

### teach
Stateful teaching workspace in cwd: MISSION.md, RESOURCES.md, `learning-records/*.md`
(numbered `0001-<slug>.md`), `lessons/*.html` (one self-contained lesson, Tufte-beautiful,
zone of proximal development), `reference/*.html`, `assets/*` reusable components,
NOTES.md. Fluency vs storage strength; retrieval practice/spacing/interleaving.

### to-questionnaire
When the blocker is knowledge someone else holds. "Grill the send, not the subject":
(1) who is it going to (role/expertise) (2) what do you need back (decisions/facts)
(3) write `.planning/<effort>/questionnaire.md` using the template (discovery
questionnaire, most-important-first, one idea per question, answer stub `>`, "why this
matters" only where misreadable).

### to-spec
ONLY after a Wayfind decide-phase (grilling/wayfinder) settled decisions; no interview —
synthesize. `/wayfind spec` invokes it. (1) explore repo (2) sketch test **seams**
(prefer existing, highest possible, ideal count = 1; check with user) (3) write
`.planning/<effort>/spec.md` using template: Problem Statement / Solution / User Stories
(LONG numbered list) / Implementation Decisions (no file paths or code; exception:
prototype-derived snippets that encode a decision) / Testing Decisions / Out of Scope /
Further Notes. Never `docs/specs/` — home is `.planning/<effort>/spec.md` only.

### to-tickets
`/wayfind tickets`. Break plan/spec/conversation into tracer-bullet tickets under
`.planning/<effort>/tickets/<NN>-<slug>.md` numbered from `01` dependency order.
Vertical-slice rules: narrow but COMPLETE path through every layer; demoable alone; fits one
fresh context window; prefactoring first. Each ticket declares **blocking edges**
(frontmatter `blocking: 02, 05`). Wide refactors are the exception: expand–contract
sequencing, batches each blocked by expand, optional shared integration branch.
Step 4: quiz the user (granularity / edges / merge-split) until approved. Template:
`---\ntype: task\nblocking: ...\nstatus: open\n---` + `# <NN> — title` + `## Question` +
`## What to build` + `## Acceptance` (- [ ] checkboxes). Work the **frontier** (blockers
all done), one ticket at a time, clearing context between. Seed the plan with
**`/wayfind seed <effort>`** (flattens frontier into task_plan.md, one phase per ticket,
topo-sorted, acceptance carried through); execute plan to activate hooks; on phase
completion `/wayfind sync` closes the originating ticket. Then prompt the user to run
`/goal <one-line destination>` (agent cannot set /goal itself; seed todos + call
`goal_complete` during execution per ADR-0003).

### triage
`/triage`. State machine over issue tracker (also external PRs = "an issue with attached
code"). Roles: categories `bug`/`enhancement`; states `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`; exactly one of each per issue; label↔role
mapping in `docs/agents/issue-tracker.md`. Every posted comment starts with
`> *This was generated by AI during triage.*` Flow: show attention buckets (unlabeled /
needs-triage / needs-info-with-reporter-activity, oldest first) → per-issue: gather context
(redundancy check + prior rejection in `.out-of-scope/*.md`) → recommend → verify claim
(reproduce bug / run PR's tests) → grill if needed (grilling + domain-modeling) → apply
outcome (ready-for-agent = AGENT-BRIEF.md comment; wontfix-rejected-enhancement writes
`.out-of-scope/`; needs-info = triage-notes template). Quick override on maintainer say-so.
Refs AGENT-BRIEF.md, OUT-OF-SCOPE.md.

### wait-what
Message didn't land → stop, re-pitch from scratch in ASD-STE100 Simplified Technical
English using CONTEXT.md ubiquitous language; say what you were doing / where you are /
what's next — nothing else. Then wait.

### wizard
Manual human-in-loop procedure → bash wizard from `template.sh` (library above STAGES
marker is sacred). Steps: (1) scope (read repo: .env*, README, workflows secrets/vars;
confirm ordered stages + captured values with user) (2) map each stage's exact journey
(never invent UI steps) (3) author (stage/say/open_url/ask_secret/write_env/set_secret/
confirm; TOTAL_STAGES) (4) verify (`bash -n`, shellcheck, chmod +x, static trace) and hand
off. Ephemeral by default — commit only if user wants a repeatable setup path.

### writing-for-agents
Craft reference for docs agents consume: context pointers (front-load leading word, one
trigger per branch), two loads (context vs cognitive), information hierarchy (in-file step →
in-file reference → disclosed reference), progressive disclosure, co-location, steps ending
on completion criteria (clarity + demand), when to split, leading words (reuse pretrained
tokens; avoid negation — prompt the positive), pruning (single source of truth; environment
as source of truth — don't cache one-command lookups; hunt no-ops sentence by sentence).
Refs SKILL-MECHANICS.md.

## NOT yet extracted (for the next agent)

1. `src/commands.ts` (490 lines) — exact `/wayfind` subcommand list + help text
   (purify/unify/search/continue/status/route/decide semantics).
2. `src/wayfinder.ts` (340) — the wayfinder procedure proper.
3. `src/effort-query.ts` (354) — how efforts are searched/listed and status computed.
4. `src/chain.ts` (231), `src/lifecycle.ts` (86), `src/procedures.ts`, `src/map.ts`,
   `src/state.ts` — map lifecycle, ticket status transitions.
5. `src/index.ts` (114) — registered slash commands.
6. Possibly `procedures/wayfinder.md` under the package (referenced by ask-matt).
7. Full text of `improve-codebase-architecture/SKILL.md` (truncated in the log file at
   /var/folders/r0/f18dr3wn6czf35q1xmktsjhm0000gn/T/pi-bash-e16abf618af58cca.log,
   lines ~683-786 hold improve-codebase-architecture + prototype bodies).
