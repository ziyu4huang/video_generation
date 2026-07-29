# Wayfinder map: 2026-07-30-self-reflection-post-watchdog

## Destination

A prioritized set of **decisions** for the next improvement round of the
`pi-agent-ext-subagent` / `superpowers` / `hermes-memory` core — each candidate
either **adopted** (with a one-PR-granularity decision: scope, seam, mechanism)
or **ruled out of scope** — informed by (a) what the **07-29 round shipped**
(watchdog + config-parity guard are now in `main`), (b) the **new recurring-pain
signal** that emerged since, and (c) freshly-re-read patterns in the reference
codebases. **Planning only — this map decides, it does not build.** Ends when
every candidate ticket is closed (adopt-spec or out-of-scope) and the frontier
is empty.

Reference codebases (read-only, outside the repo):

- `/Users/huangziyu/proj/pi-subagents` — `nicobailon/pi-subagents` v0.37.2 (2026-07-28).
- `/Users/huangziyu/proj/pi-subagents-lite` — `pi-subagents-lite` v1.5.1 (2026-07-26).

## What the 07-29 round shipped (now in `origin/main` — do not re-litigate)

- **Watchdog** (#937 + #941) — two-layer edit-gated adversarial review; SDD
  implementer dispatches now pass `watchdog:{l2:true}` by default (advisory).
- **Config-field parity guard** (#928) — static source guard in regression gates;
  caught + fixed 4 silently-dropped hermes config fields.
- **task_plan.md demotion** (ticket 06) — preview-only; coordinator reads
  `plans/*.md`, prompt fixed.

## Settled axes prior maps CLOSED (do not re-litigate)

- **Tool-schema / token-cost suppression** → `2026-07-23-the-tool-schema-...` (tool-gate exhausted).
- **SDD fix-loop mechanics** → `2026-07-26-adopt-upstream-sdd-reworks` (re-pinned v6.2.0).
- **wayfind↔superpowers `__pi*` seams** → `2026-07-27-perfect-...coexistence` (CI guards shipped).
- **learning→skill export bridge** → ACTIVE effort `2026-07-28-continue-...` (Task B: writing-skills candidate-seed spec landed `b5e35e83`/`0a4a93ec`). Do not duplicate.
- **Constrained tool sampling** (07-29 T5) → REJECT (no SDK strict json_schema knob).
- **Builtin persona set** (07-29 T4) → REJECT (in-process + skill-prompt-driven).
- **Lifecycle artifact v3 / process-terminal / FleetView / provider catalogs** → out of scope (detached-process axis, not ours).

## The new signal — test hermeticity / isolation instability (cross-package, recurring)

Since 07-29, `main` absorbed a cluster of test-stability fixes — the same axis
that **just bit the watchdog PR** (non-hermetic `~/.pi/workflows/model-tiers.json`
read + ungated `git` spawn → CI red, fixed via injection seams in #937):

- `b3424058` hermes: defensively clear residual `.lock` dirs in lock-test setup
- `3bb183d0` hermes: `config.test.ts` hermetic to `PI_HERMES_CONSOLIDATING`
- `35e655f3` hermes: standardize on `bun:test` to stop runner-state flake
- `f33222ed` archify: `mock.module` → DI to stop cross-file test leak (#935)
- `922a9967` archify: SVG export locks to current theme (#931)
- `c38e1eee` hermes: `loadConfig` resolves default path lazily (test isolation) (#917)

This is a **recurring, cross-package, CI-red-causing** failure class. The existing
`test-portability-audit.sh` guards the *host-binary spawn* + *machine-path*
sub-axis (P1/P2). It does **not** guard the **non-hermetic real-config / real-env
read** sub-axis — exactly what sank the watchdog tests. The natural successor to
the config-parity guard (#928) is a guard for **this** axis.

## Candidate tickets

- [01 — Test-hermeticity guard](tickets/01-test-hermeticity-guard.md) — **ADOPT
  (proposed).** Static source-analysis guard (precedent: config-parity #928 +
  test-portability audit) that flags test files reading **machine-coupled
  config/env** (`~/.pi/workflows/model-tiers.json`, `~/.pi/subagents/`,
  `os.homedir()`-derived paths, bare `loadModelTierConfig()`/`loadConfig()` in
  tests) WITHOUT an injection seam or env guard. Hard CI fail under `--strict`.
  Direct strike on the failure class that sank the watchdog tests + the hermes/
  archify cluster above. **HITL grilling target (the #1).**
- [02 — `extensionTools` child-seam verification](tickets/02-extensiontools-seam.md) —
  **CLOSED by research (not a bug).** `pi-subagents-lite` 1.5.1 fixed
  `createAgentSession({tools})` silently dropping extension tools. Our `agent.ts`
  **already has the seam**: `extensionTools?: ToolDefinition[]` (L213) with an
  explicit comment (L209-211) that child sessions reload extensions from disk
  and would miss programmatic ExtensionFactory tools. We solved the same gap
  differently (explicit pass-through), not via allowlist expansion. No action.
- [03 — Child context-file staleness](tickets/03-child-context-files.md) —
  **DEMOTE (low signal).** `pi-subagents` 0.37.2 added `--no-context-files` for
  children that disable inherited project context. Our `spawnSubagent` has no
  explicit context-file handling (children inherit the SDK default). No evidence
  of a stale-context failure in our memory or recent commits. Park unless a
  symptom appears.
- [04 — Planner read-only](tickets/04-planner-readonly.md) — **EVAL.**
  `pi-subagents` 0.37.1 marked its bundled planner read-only (no repo write tools)
  so planning-only runs cannot modify project files. Our wayfind planning runs
  inside the interactive session (not a detached planning agent), so the threat
  model differs — but a `commitScope:[]`-equivalent default for pure-research
  dispatches is worth evaluating. Medium signal.
- [05 — Watchdog `gateOn` (advisory → optional hard-gate)](tickets/05-watchdog-gateon.md) —
  **EVAL.** The watchdog shipped ADVISORY (07-29 brainstorm deliberately chose
  soft-gate). `pi-subagents` 0.36.0 `agentContract:{version:1}` + `gateOn` chain
  controls make review findings *actionable* (block on high-severity). Natural
  evolution: an opt-in `watchdog:{l2:true, gate:"blocker"}` that fails the run
  on `severity:blocker` L2 findings. Bigger design question; revisit after
  dogfooding the advisory watchdog produces signal on whether a hard gate is
  wanted. Medium signal.
- [06 — Handoff manifests for parallel runs](tickets/06-handoff-manifests.md) —
  **EVAL / likely out-of-scope.** `pi-subagents` 0.36.0 versioned aggregate
  handoff manifests for worktree-isolated parallel runs (per-child status +
  output refs + patch metadata). Our parallel path is the `workflow` tool's
  `parallel()` (in-process, not worktree-isolated). The `run record` persistence
  already covers per-child status. Likely out-of-scope unless we add worktree
  isolation. Low signal.

## Decisions so far

- [02 extensionTools seam] — **CLOSED by research (not a bug).** We already pass
  extension tools explicitly via `extensionTools?` (agent.ts:213); the 1.5.1
  allowlist-expansion fix is a different solution to the same gap.
- [03 context-files] — **DEMOTE.** No symptom; park.

## Not yet specified

- [01] hermeticity guard — mechanism (extend test-portability audit vs new guard),
  scope (subagent-only vs repo-wide), enforcement (strict vs warn-only): **open,
  HITL grilling target.**
- [04], [05], [06] — pending the [01] decision + available session budget.

## Skills every session should consult

`grilling` + `domain-modeling` (each adoption ticket is a HITL decision);
`verification-before-completion` if any ticket transitions to build.

## Standing preferences

Conversation in 繁體中文; all written artifacts in English. **Plan-don't-do**
unless a ticket transitions to build (only after an adopt decision + a separate
build session). One HITL adoption ticket per session (research tickets exempt).

## Fact freshness

Charted on `planning/2026-07-30-self-reflection-post-watchdog` @ `origin/main`
(`0a4a93ec`, 2026-07-30).
