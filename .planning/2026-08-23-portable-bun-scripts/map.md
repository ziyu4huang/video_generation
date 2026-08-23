---
effort: 2026-08-23-portable-bun-scripts
created: 2026-08-23
last: 2026-08-23
status: designing
---
# portable-bun-scripts — bash → portable Bun for skill-facing scripts

## Destination

Every skill-facing bash script in `bun-apps/s2-agent-ext-*` — the skill-embedded tools
(`dedup.sh`, `smoke.sh`, `find-polluter.sh`, `hitl-loop.template.sh`, `smoke-e2e.sh`,
`update-superpowers.sh`) and the test-tier launchers (13× `run-test.sh`, `ci-local.sh`) — runs
as a portable Bun script (`bun <name>.ts`), with behavior **A/B-proven against the old bash
implementation** and pinned by committed golden-parity tests. Bash remains only by design:
the wizard template (human-run artifact), root bootstraps (Bun may not exist yet), the external
`dsh-plugin/sv-analyzer/build.sh` (cargo+zig), and the deferred s2-agent core (`run.sh` + e2e
runners + updater).

## Context (measured 2026-08-23 in worktree `video_generation__dsh` at `b69d3e3d`)

- **27 tracked `.sh` files** under `bun-apps/` (excl node_modules): 5 skill-embedded tools
  (dedup, smoke, find-polluter, hitl-loop, smoke-e2e) + 1 updater (`update-superpowers.sh`) +
  1 wizard template + 14 tier launchers (12 per-package `run-test.sh` + devops
  `scripts/run-test.sh` + `ci-local.sh` 449 L) + 6 s2-agent core.
- **`run-test.sh` tiers** (devops, ~250 L): quick/medium/smoke/full monotonic; `--list`;
  machine-readable `--list-siblings` consumed by `bun-apps/tests/ci-workflow-references.test.ts`
  (only executor); `step()` prints `✓ <name>  (Ns)`; per-run log `/tmp/s2-agent-runtest.log`;
  exit 0/1/2. `sibling` packages run via canonical `bun run test` (obsidian, knowledge-card, file2md).
- **Name is load-bearing**: `deploy-run.ts:34` probes `scripts/run-test.sh` (probe fails →
  deploy aborts); `verify-tool.ts` builds `./run-test.sh <tier>` argv and parses its summary;
  `doctor.ts:493` hint; `e2e-harness.ts:11` PI_AGENT_E2E contract; 7 SKILL.md docs name `.sh`
  paths (devops-workflow, pi-memory-bulk-dedup incl. frontmatter description, playwright-cli,
  systematic-debugging, librarian, s2-agent-model-catalog-update → external build.sh, wizard).
- **`dedup.sh`**: 299 L, destructive (DB rows + `.md` §-entries), `bash dedup.sh --help` is its
  skill's reference surface; flags `--target/--db/--commit/--prune-stubs/--keep-backups/--prefix-len/--stub-maxlen`.
- **Precedent, real**: `list-ext-skills.sh → list-ext-skills.ts` converted this same session —
  A/B diff parity on all modes + exit codes (0/1/2), old awk's first-line-only block-scalar
  truncation fixed by full continuation-join, `.sh` deleted, SKILL.md refs updated. That is the
  unit pattern for this effort.

## Tickets

Phase 0 — planning
- `tickets/01-tracer-dedup.md` — planned — hard-case tracer: dedup.sh → dedup.ts + goldens + SKILL.md
- `tickets/02-class-a-rest.md` — planned — smoke/find-polluter/hitl-loop/smoke-e2e/update-superpowers + doc sweep
- `tickets/03-class-b-launchers.md` — planned — 13× run-test.sh + ci-local.sh → .ts, rename-everywhere + integration A/B

(Statuses "planned" until writing-plans → to-tickets produce the files.)

## Decisions

- **D1 — Scope: A+B, s2-agent core deferred.** Skill-facing surface is where portable-Bun pays;
  `run.sh` is the product boot entry (own design + dist A/B needed). User-confirmed.
- **D2 — B-class: rename everywhere, never shim.** Clean end state; every name consumer
  call-site-updated; proven by deploy-probe E2E + verify tool tier run.
- **D3 — A/B = transient byte-diff + committed golden-parity tests** (normalized: ANSI, `(Ns)`,
  `/tmp/*.log`, inline package names). Durable verification per user ask; goldens pin future edits.
- **D4 — Conversion unit: same-dir `name.ts` twin, exact argv/stdout/exit contract** (colors
  included — consumers parse that shape).
- **D5 — `dedup.sh` may use `bun:sqlite` internally**; output stays the contract (golden pins it).
- **D6 — By-design bash stays**: `wizard/template.sh` (human-run, cross-platform, Bun not
  guaranteed on the partner machine), root bootstraps, external sv-analyzer build.sh.
- **D7 — s2-agent core** (`run.sh`, 4× run-*-e2e.sh incl. run-self-improve-loop.sh, `update-pi.sh`,
  root `s2-agent.sh`) deferred.
- **D8 — Artifacts**: effort folder; one ticket per wave; each wave = one PR via devops chain.

## Frontier

Ticket 01 — the `dedup.sh` tracer (hardest case first: destructive, SQL + `.md` editing, help
surface). It forces the golden-capture protocol (§5 of spec) to be good enough before the
mechanical 12× tier-launcher conversion; and its own SKILL.md touch proves the doc-sweep pattern
used by ticket 02.

## Frontier

**Closed 2026-08-23** — all 3 waves merged (#1857/#1858/#1861), 20 scripts converted, guard sealed.
Tracked follow-up: **#1862** — port the upstream bisection fix into `find-polluter.ts` (inert as documented:
`find . -path 'src/**/*.test.ts'` never matches; upstream obra/superpowers has the `./`-strip + `**/`-collapse fix).
Also open (deferred Minor, triaged): dedup.ts SQL-error-path divergence (uncatchd SQLiteError vs old `|| true`),
`docs/agents/learnings.md:38` stale dedup.sh mention, blank-line history-label relaxation in the seal guard.

## Fog of war

- **`local-ci-cli` vs `ci-local.sh` relationship** read from comments (`local-ci-cli.ts:7`
  "Not a second runner: scripts/ci-local.sh executes the workflow's matrix…") is ambiguous
  without reading the CLI body — the exact executor/refactor split gets resolved inside ticket 03.
- **`--list-siblings` consumers beyond the one known guard test** are unverified; the
  `ci-workflow-references.test.ts` shell-out is the only one found by grep today.
- **The uncommitted skill edit** (`.claude/skills/using-s2-agent-skills`: list-ext-skills.sh →
  .ts + SKILL.md additions) lives in this detached worktree unreferenced by any branch — it needs
  its own PR via the devops chain (its .planning design doc:
  `.planning/specs/2026-08-22-ext-skill-alignment-design.md`, which still cites `list-ext-skills.sh`).
- **Golden portability of `dedup.sh` fixtures**: DB-affecting runs must stay on copies and
  tmpdirs; the parity test must not touch `~/.pi/agent` state.
- **13× tier launchers are near-identical but not identical** (tier names, `--isolate`-style
  quirks per package — e.g. file2md needs `--isolate` per run-test.sh comment); the shared
  "one shape" claim is true structurally, not verbatim.

## Cross-effort links

- **Builds-on**: `.planning/specs/2026-08-22-ext-skill-alignment-design.md` — designed
  `using-s2-agent-skills` + `list-ext-skills.sh`; this effort's D3/D4 generalize that precedent.
- **Supersedes**: nothing (bash scripts stay until each wave's PR lands — no effort claims
  them today).
- **Absorbed-by**: nothing yet.
