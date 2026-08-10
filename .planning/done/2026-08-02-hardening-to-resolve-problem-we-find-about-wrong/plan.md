# Superpowers artifact-path hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make superpowers never write any artifact to `docs/superpowers/` or `.superpowers/` — with or without an active effort — and guard the rule with a test + a repo lint.

**Architecture:** All divergence lives at the injection layer (`piBoundaryOverrides()` in `src/superpowers.ts`), never in the pinned `skills/*/SKILL.md` (ADR-0004). The boundary text's "when an effort is active" conditional becomes unconditional, with an auto-dated `.planning/<YYYY-MM-DD>-<slug>/` default for the no-effort case (ticket 01). A unit test locks the text; a repo lint catches actual file leakage (ticket 02). ADR-0006 records the decision (ticket 03).

**Tech Stack:** TypeScript (Bun ESM), `biome` lint, `bun test`. No Python, no shell scripts of the package's own.

## Global Constraints

- **ADR-0004 (skill fidelity):** never edit `skills/*/SKILL.md` bodies. `git diff` after the change must show zero changes under `skills/`. All divergence at `src/superpowers.ts`.
- **Routing-section length invariant:** `bootstrap.test.ts` asserts the "## Pipeline routing" section is `< 2000` and `> 800` chars. Any text edit must keep it in range.
- **Conventional commits:** `feat`/`fix`/`docs`/`test`/`chore` prefixes, English.
- **Run tests from repo root** (no top-level `cd` — `no-cd-drift.sh`): use `bun test --cwd bun-apps/pi-agent-ext-superpowers <file>`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` | Modify (`piBoundaryOverrides()`, ~line 265) | Make the no-upstream-path rule unconditional + add the auto-dated no-effort default |
| `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts` | Modify (existing "carries the Pipeline routing" test) | Lock the unconditional rule + the no-effort default |
| `bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts` | Create | Repo lint: fail if any file beyond the baseline lands under `docs/superpowers/` or `.superpowers/` |
| `bun-apps/pi-agent-ext-superpowers/docs/adr/0006-unconditional-artifact-home.md` | Create | Record the decision (supersedes ADR-0005's effort-gated clause) |
| `.planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/map.md` | Modify | Link ADR-0006 from Decisions-so-far |

---

## Task 1: Record the decision — ADR-0006

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/docs/adr/0006-unconditional-artifact-home.md`
- Modify: `bun-apps/pi-agent-ext-superpowers/docs/adr/0005-parallel-coexistence-boundary.md` (add a pointer line)

**Interfaces:** none (documentation). Produces the decision record Tasks 2–3 implement.

- [ ] **Step 1: Write ADR-0006**

Create `docs/adr/0006-unconditional-artifact-home.md`:

```markdown
# ADR-0006: Unconditional artifact home — never write to upstream paths

Date: 2026-08-02
Status: accepted
See: [ADR-0005](./0005-parallel-coexistence-boundary.md) (supersedes its "when an
effort is active" clause; 0005's wayfind↔superpowers disjoint-subpath layout
stands), [map](../../../../.planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/map.md)

## Context

ADR-0005 framed the no-upstream-path rule as conditional: "Never write to the
upstream paths **when an effort is active**." An ad-hoc brainstorm with no active
`/wayfind` effort therefore fell back to the pinned skill's literal
`docs/superpowers/specs/` default (ADR-0004 pins skills byte-identical to
upstream, so that prose was never corrected) — leaking an artifact outside the
`.planning/<effort>/` convention.

The bootstrap injection is unconditional (`session_start`/`session_compact`),
so the gap is the text's conditional language, not delivery.

## Decision

The no-upstream-path rule is **unconditional**: superpowers never writes any
artifact (spec, plan, SDD workspace, brainstorm mockup) to `docs/superpowers/`
or `.superpowers/`, with or without an active effort.

- `PI_PLANNING_EFFORT` set → resolve under `.planning/<effort>/` (unchanged).
- `PI_PLANNING_EFFORT` unset (ad-hoc) → the model derives a dated effort dir
  `.planning/<YYYY-MM-DD>-<slug>/` (`<slug>` = short kebab of the topic).

Guarded by (a) a unit test asserting the boundary text's rule is unconditional,
and (b) a repo lint failing on any file beyond the baseline under the upstream
paths.

## Consequences

- Ad-hoc artifacts persist as dated `.planning/` dirs instead of silently
  dropping under `docs/superpowers/` — a real, accepted trade-off (isolation +
  discoverability over nonchalance).
- A future `/wayfind seed` may adopt a spec-only (no `map.md`/`tickets/`) dir;
  that interaction is an implementation detail, not a decision (see map
  Not yet specified).
- Pinned `skills/*/SKILL.md` stay untouched (ADR-0004).

## Alternatives considered

- **Fixed default dir** (`.planning/adhoc/`): conflates unrelated ad-hoc
  artifacts; not adoptable by `/wayfind seed`. Rejected (ticket 01).
- **Require an effort** (error if unset): breaks lightweight ad-hoc
  brainstorming — the exact case that surfaced the bug. Rejected (ticket 01).
- **Amend ADR-0005 in place:** erodes the decision-record history. A new ADR
  with a pointer preserves the trail. Chosen (ticket 03).
```

- [ ] **Step 2: Add the pointer to ADR-0005**

In `docs/adr/0005-parallel-coexistence-boundary.md`, append to the final
paragraph:

```
**Superseded clause:** the "when an effort is active" qualifier on the
no-upstream-path rule is removed by [ADR-0006](./0006-unconditional-artifact-home.md);
this ADR's disjoint-subpath layout is unchanged.
```

- [ ] **Step 3: Link ADR-0006 from the map**

In `.planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/map.md`,
append to the ticket-03 Decisions-so-far line: `(ADR-0006:
docs/adr/0006-unconditional-artifact-home.md)`.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/docs/adr/0006-unconditional-artifact-home.md \
        bun-apps/pi-agent-ext-superpowers/docs/adr/0005-parallel-coexistence-boundary.md \
        .planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/map.md
git commit -m "docs(superpowers): ADR-0006 — unconditional artifact home (supersede 0005 clause)"
```

---

## Task 2: Harden the boundary text (the core fix)

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts` (existing test)
- Modify: `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts:~265` (`piBoundaryOverrides()`)

**Interfaces:**
- Consumes: `getBootstrapContent()` (exported from `src/superpowers.ts`) — already
  imported in `bootstrap.test.ts`.
- Produces: an unconditional no-upstream-path rule + the auto-dated-dir default
  inside the bootstrap payload.

- [ ] **Step 1: Write the failing test**

In `bootstrap.test.ts`, inside the existing `it("carries the Pipeline routing …",
() => { … })` block, add (before its closing `});`):

```ts
    // ADR-0006: the no-upstream-path rule is UNCONDITIONAL, not effort-gated
    expect(payload).not.toContain("when an effort is active");
    expect(payload).toContain("with or without an active effort");
    // no-effort default: the model derives a dated effort dir (ticket 01)
    expect(payload).toContain(".planning/<YYYY-MM-DD>-<slug>/");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --cwd bun-apps/pi-agent-ext-superpowers tests/bootstrap.test.ts`
Expected: FAIL — the current text says "when an effort is active" and lacks the
two new phrases. (`not.toContain("when an effort is active")` fails first.)

- [ ] **Step 3: Edit the boundary text**

In `src/superpowers.ts`, inside `piBoundaryOverrides()`, replace this exact
substring:

```
The pinned skills' upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are overridden at runtime by `PI_PLANNING_EFFORT`. Never write to the upstream paths when an effort is active.
```

with:

```
The pinned skills' upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are **never** written to, with or without an active effort. `PI_PLANNING_EFFORT` set → resolve under `.planning/<effort>/`. Unset (ad-hoc) → derive a dated dir `.planning/<YYYY-MM-DD>-<slug>/` (`<slug>` = short kebab of the topic) and write there — e.g. an ad-hoc spec to `.planning/<YYYY-MM-DD>-<slug>/spec.md`.
```

- [ ] **Step 4: Run the routing tests to verify they pass (incl. the length invariant)**

Run: `bun test --cwd bun-apps/pi-agent-ext-superpowers tests/bootstrap.test.ts`
Expected: PASS, including `"routing section is meaningfully shorter than the old 3039 chars"`.
If the length test fails (> 2000), tighten the Step 3 wording (it adds ~+270 chars
net; the section was comfortably under 2000).

- [ ] **Step 5: Verify no pinned skill body changed (ADR-0004)**

Run: `git diff --name-only -- bun-apps/pi-agent-ext-superpowers/skills/ | wc -l`
Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/src/superpowers.ts \
        bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts
git commit -m "fix(superpowers): unconditional artifact home — never upstream paths (ADR-0006)"
```

---

## Task 3: Repo lint — fail on upstream-path leakage (defense in depth)

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts`

**Interfaces:**
- Produces: a `bun test` that runs in the existing `bun run test` matrix
  (`ci.yml:111`) — no CI-wiring change needed. Baselines the one allowed file
  under `docs/superpowers/`.

- [ ] **Step 1: Write the lint test**

Create `tests/artifact-leak.test.ts`:

```ts
/**
 * Repo lint (ADR-0006 defense-in-depth): no superpowers artifact may live under
 * the upstream paths `docs/superpowers/` or `.superpowers/`. Runs in the ext's
 * `bun run test` matrix (ci.yml:111) so leakage fails CI with zero wiring.
 */
import { test, expect } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tests/ → ext pkg → bun-apps → repo root (3 levels up)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Files grandfathered under the upstream paths (the ADR-0006 baseline). */
const ALLOWED = new Set([
  "docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md",
]);

function listFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) listFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

test("no superpowers artifacts leak to upstream paths (ADR-0006)", () => {
  const offenders: string[] = [];
  for (const root of ["docs/superpowers", ".superpowers"]) {
    for (const abs of listFiles(join(repoRoot, root))) {
      const rel = abs.slice(repoRoot.length + 1).replace(/\\/g, "/");
      if (!ALLOWED.has(rel)) offenders.push(rel);
    }
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it passes on the clean tree**

Run: `bun test --cwd bun-apps/pi-agent-ext-superpowers tests/artifact-leak.test.ts`
Expected: PASS (the only file under `docs/superpowers/` is the baseline audit
file; `.superpowers/` is absent).

- [ ] **Step 3: Verify it FAILS on a provoked leak (manual sanity)**

Temporarily create `docs/superpowers/specs/probe.md`, re-run the test, confirm
FAIL, then delete the probe file. (Do not commit the probe.)

```bash
mkdir -p docs/superpowers/specs && echo probe > docs/superpowers/specs/probe.md
bun test --cwd bun-apps/pi-agent-ext-superpowers tests/artifact-leak.test.ts   # expect FAIL
rm -rf docs/superpowers/specs
```

- [ ] **Step 4: Run the full ext suite + lint**

Run: `bun test --cwd bun-apps/pi-agent-ext-superpowers && bun run --cwd bun-apps/pi-agent-ext-superpowers lint`
Expected: all tests PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts
git commit -m "test(superpowers): repo lint — fail on upstream-path artifact leakage (ADR-0006)"
```

---

## Self-review

- **Spec coverage:** Destination (no upstream-path writes, ever) → Task 2. No-effort default (auto-dated dir) → Task 2 Step 3 text. Regression guard (text assertion) → Task 2 Step 1; (repo lint) → Task 3. ADR-0006 → Task 1. Acceptance criteria 1–2 → Task 2; 3 → Tasks 2+3; 4 → Task 2 Step 5; 5 → Task 1 Step 3. ✓
- **Placeholder scan:** none — every step has exact paths, code, and commands.
- **Type consistency:** `getBootstrapContent()` (used in Task 2) is the existing exported function; no new symbols introduced.
- **Length invariant:** Task 2 Step 4 explicitly runs the `< 2000` test; Step 3 wording is pre-sized (~+270 net).
