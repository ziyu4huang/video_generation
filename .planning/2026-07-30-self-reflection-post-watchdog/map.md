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

- [01 — Test-hermeticity guard](tickets/01-test-hermeticity-guard.md) — **ADOPT,
  BUILT + MERGED (resolved 2026-07-30, #946 `fa0f7c98`).** Extended
  `scripts/test-portability-audit.sh` with a **P5** class. **Refined from the
  spec**: the build triage found `loadConfig(`/`os.homedir(` too noisy on current
  main (name collision with workflow's local `loadConfig` helper + benign
  path-construction in hermes tests) — P5 was NARROWED to the exact failure class
  (`loadModelTierConfig(`/`getModelTierConfigPath(` only), CALL-based, with a
  P5-specific hermeticity guard regex (tmpdir/mkdtemp/cfgPath seam) that does NOT
  touch the shared P1-P4 `GUARD_RE`. **Strict from start; shipped clean**: 11
  GUARDED / 0 UNGATED; canary-proven (a bare loader call blocks under `--strict`).
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
- [04 — Planner read-only](tickets/04-planner-readonly.md) — **DEMOTE
  (resolved 2026-07-30).** The superpowers dispatch directive already covers the
  read-only mode advisory (`commitScope:[]` for read-only subagents; `tools`
  param accepts `['read','grep','find','ls']`). `commitScope` is detection-only
  (flags, never blocks) — the real read-only protection is the tool set, which
  is already available. **No observed symptom** of a research dispatch modifying
  files (the recurring `git add -A` sweep pain is implementer-side). Low marginal
  value over the existing advisory. Park unless a symptom appears.
- [05 — Watchdog `gateOn` (advisory → optional hard-gate)](tickets/05-watchdog-gateon.md) —
  **DEMOTE (resolved 2026-07-30; premature).** Grilling surfaced a prerequisite
  gap: the advisory watchdog is **not reachable from in-session dispatches** —
  the agent-facing `subagent` tool schema omits `watchdog` (defaults off), even
  though the runtime schema (`subagent-tool.ts:115`) + the #941 enablement
  directive include it. The code is correct (no harness-side override; recent
  build), so this is most likely a **stale-session / schema-cache** issue, not a
  code gap — a fresh session should expose it. Either way there is **zero
  dogfooding signal**, so designing a hard-gate (`gateOn`) now is putting the
  cart before the horse. **Revisit after**: (a) confirm the advisory watchdog is
  reachable in a fresh session, (b) accumulate dogfooding signal on whether an
  advisory gate is even wanted before making it block. (See tool-quirk memory:
  `watchdog` param gap.)
- [06 — Handoff manifests for parallel runs](tickets/06-handoff-manifests.md) —
  **CLOSE / out-of-scope (resolved 2026-07-30).** Our parallel path is the
  `workflow` tool's `parallel()` (in-process, not worktree-isolated); the run
  record persistence already covers per-child status. `pi-subagents` 0.36.0's
  versioned aggregate manifests solve a **worktree-isolation** problem our
  architecture does not have — different model, not our gap. Revisit only if we
  adopt worktree-isolated parallel runs.

## Decisions so far

- [01 test-hermeticity guard] — **ADOPT → BUILT + MERGED** (#946 `fa0f7c98`).
  P5 class shipped; spec refined (loadConfig/os.homedir excluded as too noisy).
- [02 extensionTools seam] — **CLOSED by research (not a bug).** We already pass
  extension tools explicitly via `extensionTools?` (agent.ts:213); the 1.5.1
  allowlist-expansion fix is a different solution to the same gap.
- [03 context-files] — **DEMOTE.** No symptom; park.
- [04 planner read-only] — **DEMOTE.** Advisory (directive + tools param)
  already covers read-only; no symptom of research-dispatch file modification.
- [05 watchdog gateOn] — **DEMOTE (premature).** Advisory watchdog not yet
  reachable in-session (stale-schema, not a code gap) → zero dogfooding signal.
  Revisit after reachability confirmed + signal accumulated.
- [06 handoff manifests] — **CLOSE / out-of-scope.** In-process parallel +
  run-record coverage; manifests solve a worktree-isolation problem we lack.

**All six candidate tickets resolved — frontier empty.** No adoption this round
(04/05/06 all DEMOTE/CLOSE; 01 was the round's single adoption, already built).

## Not yet specified

None. Every candidate ticket is closed (adopt-spec or out-of-scope). The
frontier is empty; this map is complete.

## Skills every session should consult

`grilling` + `domain-modeling` (each adoption ticket is a HITL decision);
`verification-before-completion` if any ticket transitions to build.

## Standing preferences

Conversation in 繁體中文; all written artifacts in English. **Plan-don't-do**
unless a ticket transitions to build (only after an adopt decision + a separate
build session). One HITL adoption ticket per session (research tickets exempt).

## Fact freshness

Charted on `planning/2026-07-30-self-reflection-post-watchdog` @ `origin/main`
(`0a4a93ec`, 2026-07-30). 04/05/06 grilled + resolved 2026-07-30 (post-#946
merge, `fa0f7c98`). Watchdog-reachability fact (ticket 05) verified against
`subagent-tool.ts:115` + `extensions/subagent.ts:50` (no harness-side override;
recent dist build) — points to stale-session schema cache, not a code gap.
