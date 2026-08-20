# Fact-Freshness Guard for `/wayfind`

- **Date:** 2026-07-21
- **Status:** Approved design (brainstorm complete) — awaiting spec review → implementation plan
- **Effort:** `wayfind-fact-freshness-guard`
- **Branch:** `feat/wayfind-fact-freshness-guard` (off `origin/main`, independent of PR #734)

## Problem

A wayfinder map's factual premise can be silently wrong when the working branch
is behind the line of development (`origin/<default>`). The grilling discipline says
*"facts come from the environment (filesystem, tools, code)"*, but it never
specifies **which** environment — the working tree reflects the *current branch*,
which may lag behind `main`. Facts gathered via `grep` are then treated as ground
truth, baked into tickets, and only discovered stale at commit time — wasting a
full chart → resolve cycle.

### Incident (2026-07-21)

Charted a code-vs-docs consistency map on a working branch **32 commits behind
`origin/main`**. The map's core premise ("plan coordinator designed, not built")
was true at `HEAD` but **false on `main`**. It was caught only at commit time
(when checking branch divergence), after a complete map + 3 tickets had been
authored. Three commits had to be discarded and re-applied on a `main`-based
branch (PR #734).

### Root cause (systematic debugging)

- **Data flow:** grilling rule ("facts from environment") → agent `grep`s the
  working tree → working tree reflects the *current branch* (may be behind
  `main`) → facts treated as ground truth → encoded into tickets → when the work
  targets `main`, the facts may be stale → premise inverted.
- **The rule has an unstated assumption** — that the working tree *is* the source
  of truth — and there is **no divergence check at the fact-gathering boundary**.
- **The only divergence detection in this repo** (`scripts/pr-finish.sh` "BEHIND"
  disambiguation, commit `cb114cf7`) lives at **merge time**, far downstream of
  where the premise was baked in.

## Goal

A guard that catches — at `/wayfind` start — when the working branch is behind
the line of development, **before** facts get baked into a map/ticket. The guard
**warns; it never blocks** (the human may legitimately chart on a diverged
branch). It is **hybrid**: code produces the divergence *fact* deterministically;
prose documents the response *discipline*.

## Non-goals (YAGNI)

- **Not a hard gate.** No blocking — warn only.
- **No auto `git fetch`.** Respects the offline / graceful-fallback principle;
  the warning notes *"per your last fetch"* so a stale local ref is visible and
  the human can fetch if unsure.
- **Not applied to** `status` / `spec` / `tickets` / `seed` / `sync` — those read
  the map or `CONTEXT.md`; they carry no premise-staleness risk.
- **Not a general cross-cutting "environment freshness" framework.** Scoped to
  `/wayfind` chart + work-the-map only.

## Design

### Architecture

Hybrid, mirroring the repo's existing "prose-skill + code-orchestrator" split
(`coordination.ts` is the precedent for code-with-graceful-fallback):

- **Code** — `/wayfind` deterministically produces the divergence fact at start
  and surfaces it as a warning.
- **Prose** — the `wayfinder` and `grilling` skills document what to *do* with
  that signal (warn the human, prefer rebase, record the caveat), and cover the
  manual-skill-load path the command doesn't reach.

### Code component — `src/freshness.ts` (new)

```ts
export interface FactFreshness {
  /** Commits HEAD is behind the base (e.g. origin/<default>). 0 == current. */
  behind: number;
  /** The base ref compared against, e.g. "origin/<default>". */
  base: string;
}

/**
 * How far HEAD is behind the line of development (origin/<default>).
 *
 * No network: compares against the LOCAL origin/<default> ref. The caller
 * surfaces the ref's provenance so a stale ref is visible (human can fetch).
 *
 * Graceful: returns null when this is not a git repo, origin/<default> is
 * absent, or git is unavailable — offline / non-git cwd never blocks wayfind.
 */
export function checkFactFreshness(cwd: string): FactFreshness | null;

/**
 * Pure: turn the check into a human/agent warning string, or null when current.
 * Extracted as a pure function so the message text is unit-testable without a
 * pi ExtensionCommandContext.
 */
export function buildFreshnessWarning(f: FactFreshness | null): string | null;
```

- **Base resolution:** `git symbolic-ref --short refs/remotes/origin/HEAD` →
  e.g. `origin/<default>`; if unset, fall back to `origin/main`; if that ref does not
  exist → `null` (graceful).
- **Behind count:** `git rev-list --count HEAD..<base>` via `Bun.spawnSync`
  (with a timeout). Any non-zero exit or parse failure → `null`.
- **No `git fetch`** (offline-safe). The warning text notes *"per your last
  fetch"*.
- **Ahead + behind:** only `behind` is reported (the premise-dangerous
  direction); being ahead of base is fine.

### Wiring — `handleWayfinderChart` (`src/commands.ts`)

At the **very top** of `handleWayfinderChart` — before the `if (!destination)`
split, so it covers **both** the chart path and the work-the-map path — call
`checkFactFreshness(ctx.cwd)` once and compute
`warn = buildFreshnessWarning(f)`. If `warn` is non-null:

- `ctx.ui.notify(warn, "warning")` (a visible banner), **and**
- append `warn` to **both** `pi.sendUserMessage` steer payloads so the agent
  reads it as part of its priming.

One call site, two injection points. `status` / `spec` / `tickets` / `seed` /
`sync` are untouched.

### Prose component — two skills

**`skills/wayfinder/SKILL.md`**

- **Notes** block: add a "Fact freshness" line — the working tree reflects the
  current branch, which may lag `main`; a map built on a stale premise is wasted
  work; the `/wayfind` command reports divergence at start; if reached without
  the command, run `git rev-list --count HEAD..origin/<default>` yourself.
- **Chart-the-map**, before step 1: confirm branch is current; if the command
  reported behind, warn the human and prefer rebasing before charting.
- **Work-through-the-map**, step 1 (load the map): note any fact-freshness
  warning the command emitted; flag staleness before resolving a ticket.

**`skills/grilling/SKILL.md`**

- Sharpen the "facts come from the environment" rule with a caveat: the
  environment reflects the *current branch*, which may be behind the line of
  development; before treating gathered facts as ground truth for a decision,
  confirm the branch is current (the `/wayfind` command checks this; otherwise
  `git rev-list --count HEAD..origin/<default>`).

### Data flow

```
/wayfind <dest>  ─►  handleWayfinderChart
   └─► checkFactFreshness(cwd)  ─►  { behind, base } | null
         └─► behind > 0  ─►  ctx.ui.notify(⚠️)  +  inject into both steer messages
               └─►  agent loads wayfinder skill, reads the warning,
                     warns the human / prefers rebase
                     └─►  (prose) if skill loaded without the command,
                           agent runs the git check itself
```

### Edge cases / error handling

| Situation | Behavior |
|---|---|
| Not a git repo | `null` (graceful; wayfind still works) |
| No `origin` remote / no `origin/<default>` ref | `null` (graceful) |
| `git` binary missing | `null` (graceful; `spawnSync` fails) |
| Detached HEAD / no upstream | Works — compares `HEAD` to `origin/<default>` directly |
| `behind == 0` | No warning |
| Local ref stale (main moved, not fetched) | Warning notes *"per your last fetch"*; no auto-fetch |
| HEAD both ahead and behind | Reports `behind` only (the dangerous direction) |

### Testing

- **`tests/freshness.test.ts`** (new): real temp-git fixtures (init a repo, add
  an `origin/main` ref, create divergence) covering `behind > 0`, `behind == 0`,
  not-a-repo, no-origin → `null`. Plus pure-function tests for
  `buildFreshnessWarning` (`null → null`; `behind > 0 →` string containing the
  count and the base).
- **`tests/skills.test.ts`**: this suite is **structural** (frontmatter
  `name`/`description`/H1, ≤1024-char frontmatter) and asserts no prose content, so
  the skill edits need **no new assertion here** — they must simply keep the
  frontmatter valid and the top-level H1 present. (A grep-based "mentions fact
  freshness" assertion would be inconsistent with the suite's structural-only
  design; intentionally not added.)
- **Manual smoke:** on a branch behind `origin/main`, `/wayfind smoke` → expect
  a ⚠️ notify + steer warning; on a current branch → no warning.
- **Wiring note:** the `handleWayfinderChart` injection is hard to unit-test
  (depends on a live pi `ExtensionCommandContext`); cover it via the
  `freshness.test.ts` unit tests + the pure `buildFreshnessWarning`, and rely on
  the manual smoke for the integration.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Locus | `wayfind` (not `superpowers`) | Earliest catch = highest leverage; prevents the wasted cycle |
| Baseline | `origin/<default>` (`origin/main`) | Matches the incident (PR to main); always available if fetched; graceful null otherwise |
| Trigger | `/wayfind` start, once | Covers the two premise-bearing paths (chart + work-the-map); low noise |
| Stance | Warn, don't block | Human may legitimately chart on a diverged branch |
| Form | Hybrid (code fact + prose discipline) | Code fixes the missing *fact*; prose fixes the missing *discipline* (root cause is both) |
| Network | No `git fetch` | Respects offline / graceful-fallback principle |

## Location

- **Code:** `src/freshness.ts` (new); wiring in `src/commands.ts`
  (`handleWayfinderChart`).
- **Prose:** `skills/wayfinder/SKILL.md`, `skills/grilling/SKILL.md`.
- **Tests:** `tests/freshness.test.ts` (new), `tests/skills.test.ts` (assertion).
- **Doc:** this file (`docs/specs/`).

## Open questions (defer to implementation plan)

- **ADR-0004?** Optional — record the *"wayfind checks branch freshness before
  charting"* decision as an ADR. The decision is reversible-ish (it's a behavior,
  not an architecture), so a spec may suffice; decide during implementation.
