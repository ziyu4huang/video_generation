# Spec — Harden superpowers artifact paths against upstream-path leakage

Effort: `.planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/`
Date: 2026-08-02
Status: design approved (wayfinder tickets 00–03 closed); ready for planning
Build ticket: [04 — Implement no-leak + guard](tickets/04-implement-no-leak-and-guard.md)

## Problem

An ad-hoc brainstorm (no active `/wayfind` effort) fell back to the superpowers
skill's pinned default `docs/superpowers/specs/` instead of the repo's
`.planning/<effort>/` convention. RCA (ticket 00):

- The superpowers skills are **pinned byte-identical to upstream** (ADR-0004:
  unregister ≠ edit), so their prose still says `docs/superpowers/specs/`. That
  is a stale upstream default, not the real convention.
- The real redirect lives at the injection layer — `piBoundaryOverrides()` in
  `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts`, injected into every
  session's bootstrap unconditionally (`getBootstrapContent`).
- But the redirect text says "Never write to the upstream paths **when an effort
  is active**." With no effort active, the redirect doesn't apply, and the model
  follows the pinned skill's literal default → writes to `docs/superpowers/`.

## Destination

Superpowers never writes any artifact — spec, plan, SDD workspace, or
brainstorm mockup — to `docs/superpowers/` or `.superpowers/`, **whether or not
an effort is active**. The no-effort case resolves to a defined `.planning/`
home. A regression test guards against future leakage. Skills stay pinned
(ADR-0004); all divergence lives at the injection layer.

## Design (resolved decisions)

### 1. No-effort default — auto-create a dated effort dir (ticket 01)

When `PI_PLANNING_EFFORT` is unset, artifacts resolve to
`.planning/<YYYY-MM-DD>-<slug>/` where `<slug>` is a short kebab-case of the
topic (the model derives it). The effort-active case is unchanged (redirect to
`.planning/<effort>/`). A spec/plan written ad-hoc lands at
`.planning/<YYYY-MM-DD>-<slug>/{spec,plan}.md` — a valid "naked" effort (cf.
`.planning/2026-07-19-goal-todo-handoff-stopgap/`).

### 2. Regression guard — text assertion + repo lint (ticket 02)

- **(a) Unit test** asserting `piBoundaryOverrides()` output contains an
  **unconditional** "never write to `docs/superpowers/`" rule (no "when an
  effort is active" conditioning on the avoidance). Catches the root cause:
  the text regressing to effort-gated language.
- **(b) Repo lint** that fails if any **new** tracked file lands under
  `docs/superpowers/` or `.superpowers/sdd/`. Baselines the allowed set
  (currently `docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md`)
  and fails on anything beyond it. Catches actual leakage — the failure mode
  that bit us.

Defense in depth: the leak we hit is the lint's job; its root cause is the
assertion's job.

### 3. ADR-0006 supersedes ADR-0005's effort-gated clause (ticket 03)

A new ADR supersedes the "when an effort is active" clause on the
no-upstream-path rule, leaving ADR-0005 intact (the wayfind↔superpowers
disjoint-subpath layout stands) with a pointer 0005 → 0006. All three
domain-modeling criteria hold (hard-to-reverse, surprising-without-context,
real trade-off).

## Architecture / components

Two artifact families with **asymmetric** enforcement (ticket 00, R2):

| Family | Kinds | Path decided by | Enforcement lever |
|---|---|---|---|
| **Prose-only** | spec (brainstorming), plan (writing-plans) | model following SKILL.md prose + injected boundary text | injected text + test/lint guard — **no script to override** |
| **Script-backed** | SDD workspace, brainstorm visual companion | `scripts/sdd-workspace`, `scripts/start-server.sh` | already honor `PI_PLANNING_EFFORT`; add a sane no-effort fallback per design §1 |

So the text fix (unconditional rule + auto-dated default) covers the prose
family; the scripts already redirect and just need the no-effort fallback
confirmed.

**Touch points:**
- `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` → `piBoundaryOverrides()`
  text (the unconditional rule + auto-dated-dir instruction).
- `bun-apps/pi-agent-ext-superpowers/docs/adr/0006-*.md` → new ADR.
- A unit test (superpowers ext) for (a).
- A repo lint (location TBD in plan: superpowers tests vs repo-root CI) for (b).

## Acceptance criteria (from ticket 04)

1. `piBoundaryOverrides()` output no longer conditions the no-upstream-path rule
   on an active effort — the avoidance is unconditional; the effort only chooses
   *which* `.planning/<effort>/` subdir.
2. The no-effort case resolves to flat `.planning/specs/<YYYY-MM-DD>-<topic>-design.md` (specs) and `.planning/plans/<YYYY-MM-DD>-<topic>.md` (plans) — the layout `docs/superpowers/{specs,plans}` symlink to — never to `docs/superpowers/`.
3. The dual guard passes in CI; manually provoking an upstream-path write fails
   the lint.
4. Pinned `skills/*/SKILL.md` bodies are **untouched** (ADR-0004) — `git diff`
   shows no changes under `skills/`.
5. ADR-0006 is written and linked from `map.md` + `tickets/03`.

## Out of scope

- Editing pinned skill bodies (ADR-0004 forbids; divergence belongs at the
  injection layer).
- wayfind (grep-confirmed leak-free).
- The semantic/embedding intent-matcher redesign (separate, twice-rejected).
- tool-gate savings-claim drift (paused sibling effort).

## References

- [map.md](map.md) — the wayfinder map (destination, decisions, fog).
- ADR-0004 (skill fidelity positive pin), ADR-0005 (parallel coexistence
  boundary) in `bun-apps/pi-agent-ext-superpowers/docs/adr/`.
- Tickets 00–04 under `tickets/`.
