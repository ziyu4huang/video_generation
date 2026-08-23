# Planning-pipeline recon (read-only) — 2026-08-16 session

Factual snapshot for the wayfinder charting session on optimizing the planning pipeline
(wayfind / superpowers / subagents ecosystem). No recommendations — facts only.

## 1. bun-apps/ package inventory

31 entries total. `pi-agent-ext-*` packages (22), flagged:

- pi-agent-ext-archify
- pi-agent-ext-btw
- pi-agent-ext-devops
- pi-agent-ext-file2md
- pi-agent-ext-flux2
- pi-agent-ext-hermes-memory
- pi-agent-ext-knowledge-card
- pi-agent-ext-krea2
- pi-agent-ext-ltx
- pi-agent-ext-movie-director
- pi-agent-ext-obsidian
- pi-agent-ext-picker
- pi-agent-ext-power-tool
- pi-agent-ext-prompt-history
- pi-agent-ext-research-tool
- pi-agent-ext-response-language
- pi-agent-ext-subagent
- pi-agent-ext-superpowers
- pi-agent-ext-task
- pi-agent-ext-tool-gate
- pi-agent-ext-wayfind
- pi-agent-ext-web-access
- pi-agent-ext-webui
- pi-agent-ext-workflow
- pi-agent-ext-zai-mcp

Non-ext entries: `pi-agent`, `pi-agent-cli`, `pi-agent-core-interface`, `pi-agent-core-runtime`,
`gui-movie-director`, `perf-harness`, `docs`, `scripts`, `tests`, plus root `bun.lock`/`bunfig.toml`/
`package.json`/`KNOWLEDGE-LAYER.md`/`node_modules`.

## 2. Extension registration (run-dir/manifest.json + static-extensions.ts)

Dynamically registered (manifest `extensions[]`, jiti `-e` loaded):
- pi-agent-ext-tool-gate
- pi-agent-ext-devops
- pi-agent-ext-flux2
- pi-agent-ext-krea2
- pi-agent-ext-ltx
- pi-agent-ext-research-tool
- pi-agent-ext-zai-mcp
- pi-agent-ext-movie-director
- pi-agent-ext-archify

Statically registered (manifest `staticExtensions[]` AND `pi-agent/src/static-extensions.ts`
native imports; deliberately absent from `extensions[]` to avoid double registration — static
imports survive `bun build --compile`):
- Group A (original productivity 5 + 1): pi-agent-ext-task, pi-agent-ext-prompt-history,
  pi-agent-ext-hermes-memory, pi-agent-ext-superpowers, pi-agent-ext-wayfind,
  pi-agent-ext-web-access
- Group B (migrated from dynamic `-e` for single-exe builds): pi-agent-ext-obsidian,
  pi-agent-ext-btw, pi-agent-ext-file2md, pi-agent-ext-subagent (loads BEFORE workflow so
  workflow's /subagents viewer reads a populated registry), pi-agent-ext-workflow,
  pi-agent-ext-knowledge-card, pi-agent-ext-power-tool, pi-agent-ext-webui

Skills dirs in manifest: obsidian, research-tool, wayfind, hermes-memory, superpowers,
web-access, archify, devops. Binary skills: hermes-memory, superpowers, wayfind, web-access.
`npmExtensions: []`, `lazyExtensions: {}`.

## 3. pi-agent-ext-wayfind (CONTEXT.md / README.md skim)

- **Purpose**: Pi-native port of Matt Pocock's decision-chain skill suite (grilling + wayfinder
  family). The "Decide-phase" of the Superpowers methodology — turns a fuzzy plan/huge effort
  into settled decisions BEFORE code. Pure TypeScript, no python3/shell; the agent drives the
  interview, the extension provides commands + on-disk map store.
- **Skills (6)**: grilling, grill-me, grill-me-with-docs (flagship), domain-modeling, to-spec,
  to-tickets. Skills dir also holds ported Matt Pocock skills: ask-matt, code-review,
  codebase-design, diagnosing-bugs, domain-modeling, grill-me, grill-me-with-docs, grilling,
  handoff, improve-codebase-architecture, prototype, research, resolving-merge-conflicts,
  subagent-dispatch-discipline, teach, to-questionnaire, to-spec, to-tickets, triage, wait-what,
  wizard, writing-for-agents (22 dirs under `bun-apps/pi-agent-ext-wayfind/skills/`).
- **Slash commands**:
  - `/grill [me|docs|done|domain]` (`docs` = flagship; `done --seed-plan` writes task_plan.md seed)
  - `/wayfind [<destination>|status|spec|tickets|seed|sync|done|validate]`
    - `status` — frontier + open/closed/claimed/fog counts
    - `spec` — synthesize conversation + codebase into `.planning/<effort>/spec.md`
    - `tickets` — break spec/plan into tracer-bullet tickets under `.planning/<effort>/tickets/`
    - `seed` — route-aware flatten to `task_plan.md` (topo-sorted, `[ticket-id]` phase headers); refuses overwrite
    - `sync` — close wayfind tickets whose plan-coordinator phase reported completed
    - `done` — harvest map into `output/next-goal-<ts>.md` + surface next goal
    - `validate` — validate effort structure (tickets, frontmatter, blocking edges)
- **Map storage**: local-markdown map + decision tickets under `.planning/<effort>/` (map.md,
  tickets/, spec.md, CONTEXT.md glossary + docs/adr/ ADRs). No issue-tracker dependency.
- **Chain**: `/grill docs → /wayfind spec → /wayfind tickets → /wayfind seed → execute plan → /wayfind sync` (closed loop).
- **Seams (ADR-wayfind-0003)**: REVERSE seam only — wayfind READS plan coordinator's
  `globalThis.__piPlanPhases(cwd)` (4 globalThis keys total) to auto-close tickets whose Task
  reported `completed`; idempotent, graceful no-op when coordinator absent. **No forward seam
  published** — mutual exclusion between grill/wayfind and `/goal`//`/loop` is user-initiated
  ("run one driver at a time"). wayfind publishes `globalThis.__piWayfindGrill` (consumed by
  hermes-memory). Neither package (wayfind ↔ task coordinator) imports the other.
- **Boundary language**: "Parallel coexistence" — wayfind (Decide-phase) and Superpowers
  (Plan/execute-phase) are independent, non-connecting pipelines sharing only the
  `.planning/<effort>/` layout; divergence is expressed in using-superpowers bootstrap, never by
  patching upstream-verbatim skill bodies (ADR-0004/ADR-0005). "Plan-writability" is the router:
  can a plan be written now? yes → superpowers; no → wayfind/grilling (size secondary).
- **Tests**: 263 tests, 0 fail (README claim). Uses `spawnSubagent` from pi-agent-ext-subagent.
- **TODO/FIXME/XXX in src/**: grep surfaced no matching lines (0 printed matches; the count
  verification was cut off by session budget — treat as "none surfaced", not audited-certain).

## 4. pi-agent-ext-subagent (CONTEXT.md / README.md skim)

- **Purpose**: isolated single-subagent dispatch — `subagent` + `subagent_runs` LLM tools,
  `WorkflowAgent` runner (thin adapter over `createAgentSession()`, no HTTP/provider path),
  `spawnSubagent` programmatic API for peer-extension code (wayfind, superpowers, knowledge-card
  import it), `spawnSubagentSubprocess` (isolated-process analog), `/subagents` TUI viewer,
  process-wide singletons (in-flight registry — now in core-runtime; run-persistence
  `~/.pi/subagents/runs/<id>.json`, write-once, last-200 retention). Extracted from
  pi-agent-ext-workflow so subagent capability loads independently of the workflow DSL.
- **Config**: agent registry `.pi/agents/*.md` (name/tools/model/prompt/worktree-isolation);
  model tiers/capabilities from `~/.pi/workflows/model-tiers.json` (`{tiers, capabilities}`,
  editable via `/workflows-models`); resolution precedence explicit `model` > capability >
  tier > session mainModel. NO hardcoded model ids allowed anywhere (2026-07-26 audit clean).
- **Token budgets**: tier-calibrated hard ceilings small=500k / medium=1.2M / big=1.5M; env
  overrides `SUBAGENT_TOKEN_BUDGET_DISABLE/_SMALL/_MEDIUM/_BIG/_MULTIPLIER` (read at call time);
  budget crossing → one graceful wrap-up turn, second crossing aborts `status:"budget"`;
  `spendBudget` is a hard stop (money valve) and wins if both cross.
- **Failure model**: `SubagentFailure` discriminated union `failed|timedout|turns|budget`,
  absent on success; `aborted` NOT reachable from spawn result (parent turn owns it). Replaced
  old `{exitCode, stderr, timedOut, budget, turns}` vocabulary (ADR-subagent-0003).
- **Quirks / gotchas documented**:
  - Barrel facade rule: re-exports a fixed set of core-runtime symbols because pi-agent,
    obsidian, file2md, knowledge-card don't declare core-runtime; dep-guard rejects undeclared
    `@repo` edges; `barrel-surface.test.ts` enforces both directions. Barrel once carried 114
    names of which 21 were imported.
  - Singleton module-identity: package root maps to `./src/index.ts` (no dist), so any import
    path resolves to one module; earlier "import via src/ subpath" guidance was wrong and is
    retired; `rate-limiter-cross-pkg.test.ts` pins behaviorally.
  - `dispatchChild` is the single driver of one child run (per-child abort, parent-turn signal
    fan-in, actual-model capture, commit-scope audit) — exists because the two tools held
    drifting copies; policy differences stated at call sites.
  - Watchdog: opt-in two-layer (LSP + model) diff review, soft gate; two files are a selective
    port from nicobailon/pi-subagents with a pin doc for upstream sync.
  - Dual provenance: body extracted from workflow (#789), watchdog ported — sync carefully.

## 5. Superpowers skill set

Lives in `bun-apps/pi-agent-ext-superpowers/skills/` (registered in manifest skills + binarySkills;
extension statically imported). 14 skills:
- brainstorming
- dispatching-parallel-agents
- executing-plans
- finishing-a-development-branch
- receiving-code-review
- requesting-code-review
- subagent-driven-development
- systematic-debugging
- test-driven-development
- using-git-worktrees
- using-superpowers
- verification-before-completion
- writing-plans
- writing-skills

Repo `.pi/skills/` holds only: devops-workflow, pre-plan-runtime-validation (not superpowers).

## 6. .planning/ enumeration

Top level: 15 dated effort dirs + CONVENTIONS.md, debug-archify-test-failure, done/, knowledge/,
plans/, recon/, sdd/, specs/, UPSTREAM-SOURCES.md, REVIEW-2026-08-08.md,
REVIEW-2026-08-15-ext-four-packages.md, REVIEW-2026-08-15-pi-agent.md.

| effort dir | map.md | spec.md | tickets/ (md count) | other | style (inferred) |
|---|---|---|---|---|---|
| 2026-07-25-simplify-ext-prompt-weight | – | – | – (0) | sdd/ | superpowers-only (SDD) |
| 2026-07-31-let-s-continue-to-improve-base-on-known-upstream | yes | – | 14 | – | wayfind-style |
| 2026-08-08-knowledge-pipeline | yes | – | 21 | brainstorm/, sdd/, plans/ | hybrid (wayfind + sdd + brainstorm) |
| 2026-08-10-hermes-architecture-deepening | yes | – | 13 | – | wayfind-style |
| 2026-08-15-archify-webui-html | yes | yes | 8 | – | wayfind-style |
| 2026-08-15-subagent-dynamic-budgets | yes | – | 0 | – | wayfind-style (map, no tickets yet) |
| 2026-08-15-tool-gate-complete-redesign | yes | yes | 7 | – | wayfind-style |
| 2026-08-15-zk-spawn-interactive-ui | yes | – | – (0) | – | wayfind-style (map only) |
| **2026-08-16-optimize-planning-pipeline-aka-extension** | yes | – | 0 (dir exists) | – | wayfind-style; THE effort for this topic |
| 2026-08-16-power-tool-rearch | yes | yes | 2 | – | wayfind-style |
| 2026-08-16-tool-gate-qa-harness-generalization | yes | yes | 4 | – | wayfind-style |
| 2026-08-16-webui-event-cards | yes | yes | 6 | – | wayfind-style |
| 2026-08-16-webui-present-adoption | yes | yes | 4 | – | wayfind-style |
| 2026-08-16-webui-tui-parity | yes | yes | 2 | – | wayfind-style |
| 2026-08-16-webui-view-notifications | yes | yes | 8 | – | wayfind-style |

Ticket totals ≈ 89 ticket files across efforts. Dominant pattern: map.md-first (wayfind); only
the oldest effort (07-25) is sdd/only; knowledge-pipeline is the hybrid outlier (map + brainstorm
+ sdd + plans).

## 7. Prior art on planning-pipeline optimization

- **`.planning/2026-08-16-optimize-planning-pipeline-aka-extension/` EXISTS** — a Wayfinder map
  for exactly this session's topic. map.md header confirms: effort id + "optimize planning
  pipeline aka extension wayfind/superpowers/subagents". tickets/ dir present but contains
  0 .md files (map charted, tickets not yet broken out at recon time). Full map.md read was
  aborted by session budget — contents still to be read by the charting session.
- `grep pipeline` over dated map/spec hits mostly `2026-08-08-knowledge-pipeline` (a different
  "pipeline" — knowledge cards, though its map self-applies the pipeline to wayfinder's own
  `.planning/<effort>` CRUD/query/staleness) and `2026-08-10-hermes-architecture-deepening`
  (sequencing note coordinating with knowledge-pipeline Phase-2).
- `docs/superpowers/` exists with subdirs: audit/, plans/, specs/ (contents not yet enumerated —
  cut off by budget).
- `docs/agents/` contains: domain.md, issue-tracker.md, learnings.md, shared-state-index.md.
  No file named for wayfind↔superpowers handoff at this level (shared-state-index.md is the
  likeliest seam doc — unverified).

## 8. wayfind src TODO/FIXME audit

`grep -rn 'TODO\|FIXME\|XXX' bun-apps/pi-agent-ext-wayfind/src` printed zero matching lines
(the exit-code echo was inconclusive due to piping; no matches were shown). No open markers
surfaced.

## Open items the charting session should read next

1. `.planning/2026-08-16-optimize-planning-pipeline-aka-extension/map.md` (full contents — read aborted)
2. `.planning/done/`, `.planning/sdd/`, `.planning/specs/`, `.planning/plans/` listings (aborted)
3. `docs/superpowers/{audit,plans,specs}/` contents (aborted)
4. `docs/agents/shared-state-index.md` (seam doc, unverified)
5. `.planning/CONVENTIONS.md` (layout canon, unread)
