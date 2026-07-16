# pi-agent-ext-planning-with-files

The ubiquitous language of pi-agent-ext-planning-with-files — a Layer-3 runtime that keeps an agent anchored to `task_plan.md` / `findings.md` / `progress.md` across long, multi-step goals (a Pi-native port of Manus-style "markdown = working memory"). It is the **substrate**; the 12 shipped skills are the **methodology** that runs on top.

## Language

### The foundational split

**Substrate**:
The file/orchestration layer — where plans live (the three files), the lifecycle hooks, the `/plan-*` commands. What the extension *is*.
_Avoid_: runtime, engine (the substrate is the file + hook layer specifically)

**Methodology**:
The 12 skills that run *on top of* the substrate — test-driven-development, brainstorming, writing-plans, executing-plans, verification-before-completion, systematic-debugging, writing-skills, etc. What you *do* with the substrate.
_Avoid_: features, plugins (methodology is the skill suite, deliberately complementary not duplicative of the substrate)

### The plan

**The three files**:
`task_plan.md` (the plan — injected into the model every turn), `progress.md` (phase tracking), `findings.md` (external/web content — the ONLY safe home for untrusted text, since the plan is an injection amplifier).
_Avoid_: docs, notes (they are the working-memory substrate with distinct injection rules)

**Phase**:
The plan unit in `task_plan.md`. Counted by the parser (`### Phase` headings) and tracked in `progress.md`.
_Avoid_: step, task (a *step* is a `todo`-tool item within a phase; a *phase* is the plan-level unit)

### Plan lifecycle

**`/plan-execute` gate**:
The approval gate — hooks stay **passive** until the user runs `/plan-execute`. A safety gate so an unapproved plan never auto-drives.
_Avoid_: start, run (it is an explicit approval that activates the hooks)

**`/plan-done` close-out**:
Closing a plan writes the `<!-- pwf: closed -->` marker and makes the hooks inert (no nag, no auto-continue). **Mandatory** — a finished-but-unclosed plan nags at every `agent_end`.
_Avoid_: finish, complete (it is an explicit close that silences the hooks)

**Auto-continue**:
An incomplete plan triggers a follow-up turn, limited to 3 per (session, plan).
_Avoid_: loop, retry (it is bounded auto-follow-up, not a loop)

### Injection

**Injection mode**:
How the plan reaches the model — `auto` (default: `parity` except DeepSeek → `cache-safe`), `parity` (full plan + progress block), `cache-safe` (stable one-line reminders, KV-cache friendly), `notify` (status-bar only). Choose from data via `/plan-status` token cost.
_Avoid_: prompt mode, setting (it is the injection strategy, picked per-model)

**Recitation**:
The plan head injected as `steer` before tracked tool calls (PreToolUse) — keeps the active phase in the model's attention without a full re-inject.
_Avoid_: reminder, preamble (it is a pre-tool-call steer)

**Cache-safety**:
Stable reminder strings in `cache-safe` mode so the injection doesn't bust the provider's KV-cache prefix.
_Avoid_: caching, memoization (it is KV-cache-friendly injection, not data caching)

### Integrity

**Attestation** (`/plan-attest`):
A SHA-256 lock over `task_plan.md` (pure-TS, `node:crypto`). Any later silent edit fails the hash → injection blocked with `[PLAN TAMPERED]`.
_Avoid_: lock, checksum (it is tamper-detection that gates injection)

**Dangerous-bash guard**:
A word-boundary regex guard (`rm -rf`, `sudo`, `git push --force`, fork-bombs …) on bash tool calls.
_Avoid_: linter, validator (it is a destructive-command guard)

### Multi-plan

**PLI v2** (Plan Lifecycle Intelligence):
The multi-plan commands — `/plan-list` (all plans + status), `/plan-lint [--all]` (diagnose: missing headers, unparseable tokens, tamper), `/plan-switch <id>` (pin the active plan).
_Avoid_: plan manager, organizer (it is the multi-plan intelligence layer)

### Coordination

**Three-layer model**:
How `/goal`, planning-with-files, and the `todo` tool compose — **Objective** (`/goal`, session JSONL), **Plan** (planning-with-files, files on disk, cross-session), **Steps** (`todo`, in-phase, in-session). Three time-scales, not competing plans.
_Avoid_: hierarchy, levels (they are composable time-scales)

**Yield**:
When an external driver is active, planning-with-files skips its own injection + auto-continue so the two don't double-drive. The status bar shows `… — /goal or /grill driving, injection yielded`.
_Avoid_: pause, disable (it is a conditional deferral to the active driver)

**External driver** (`isExternalDriverActive()`):
What planning yields to — an active `/goal` OR an active wayfind grill/wayfinder session (read via `globalThis.__piGoalActive` / `globalThis.__piWayfindActive`). Graceful: absent → false → no yield.
_Avoid_: controller, owner (it is the peer that owns the turn)
