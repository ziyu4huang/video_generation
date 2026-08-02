# Revision report — Task 2 correction (route no-effort specs to flat `.planning/specs/`)

**Status:** ✅ DONE — all 3 changes applied, bootstrap test PASS (incl. `< 2000`-char
invariant, after an authorized clause-tighten), full ext suite green (129/129),
ADR-0004 honored (`skills/` untouched), scoped commit landed (exactly 3 files).

**Commit:** `238846c468f5fb322a40ebc9ecf7867bd6aa22d7`
**Brief applied:** `task-2-revision-brief.md`

---

## Premise recap

`docs/superpowers/{specs,plans}` are git-tracked symlinks →
`../../.planning/{specs,plans}` (verified on disk):

```
docs/superpowers/plans -> ../../.planning/plans
docs/superpowers/specs -> ../../.planning/specs
```

So Task 2's original instruction to push no-effort specs to *per-effort*
`.planning/<YYYY-MM-DD>-<slug>/` dirs would have fragmented standalone specs away
from the flat `.planning/specs/` layout the symlinks alias. Revised per user
direction: route no-effort specs/plans to the **flat** `.planning/specs/` and
`.planning/plans/`, keep the unconditional no-upstream-path rule, keep the Task-3
lint.

---

## Change 1 — `src/superpowers.ts` `piBoundaryOverrides()`

**Old sentence** (replaced):

> Upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are **never** written
> to, with or without an active effort. `PI_PLANNING_EFFORT` set →
> `.planning/<effort>/`; unset → derive `.planning/<YYYY-MM-DD>-<slug>/`.

**New sentence** (verbatim per brief, template-literal backtick-escaping
preserved):

> Specs → `.planning/specs/<YYYY-MM-DD>-<topic>-design.md`, plans →
> `.planning/plans/<YYYY-MM-DD>-<topic>.md` (`docs/superpowers/{specs,plans}`
> symlink there — prefer the `.planning/` path). Other upstream paths
> (`docs/superpowers/`, `.superpowers/sdd/`) are never written.
> `PI_PLANNING_EFFORT` set → `.planning/<effort>/`.

**Invariant check** (rendered payload): contains `.planning/specs/`,
`.planning/plans/`, `symlink`; does NOT contain `when an effort is active`. ✅

**< 2000-char invariant — authorized clause tighten.** The brief-prescribed
sentence added ~60 chars and pushed the routing section from ~2031 → 2091,
failing the `< 2000` assertion. Per the brief's authorization ("If the routing
section exceeds 2000 chars, tighten wording — drop a clause"), I tightened two
**non-brief, non-assertion-required** clauses in the pre-existing rule-1 prose
(the brief's Change 1 text was left verbatim):

- `…resolves the plan's dir (deriving \`<plan-basename>\` from the plan filename)
  and honors \`PI_PLANNING_EFFORT\`; the brainstorm \`start-server.sh\` honors it
  too.`
  → `…resolves the plan's dir and honors \`PI_PLANNING_EFFORT\`.`
- `…When in doubt, DECIDE first — it's cheap insurance against building on a foggy
  route.`
  → `…When in doubt, DECIDE first.`

Result: routing section now ~1934 chars (PASS `< 2000`, still `> 800`). All
surviving assertions remain satisfied (`sdd-workspace PLAN_FILE`,
`PI_PLANNING_EFFORT`, the table's stage names, etc.).

---

## Change 2 — `tests/bootstrap.test.ts`

Replaced the 3 assertions Task 2 added inside `it("carries the Pipeline routing
…")`:

**Old:**
```ts
    // ADR-0006: the no-upstream-path rule is UNCONDITIONAL, not effort-gated
    expect(payload).not.toContain("when an effort is active");
    expect(payload).toContain("with or without an active effort");
    // no-effort default: the model derives a dated effort dir (ticket 01)
    expect(payload).toContain(".planning/<YYYY-MM-DD>-<slug>/");
```

**New** (verbatim per brief):
```ts
    // ADR-0006 (revised): no-effort specs route to the flat .planning/specs/
    // (docs/superpowers/{specs,plans} symlink there); other upstream paths forbidden
    expect(payload).toContain(".planning/specs/");
    expect(payload).toContain("symlink");
    expect(payload).not.toContain("when an effort is active");
```

This correctly drops the now-stale `with or without an active effort` and the
`.planning/<YYYY-MM-DD>-<slug>/` expectations (neither survives in the revised
boundary text).

---

## Change 3 — `docs/adr/0006-unconditional-artifact-home.md`

**Decision bullet** (replaced, verbatim per brief):

> - `PI_PLANNING_EFFORT` unset (ad-hoc) → specs land at
>   `.planning/specs/<YYYY-MM-DD>-<topic>-design.md` and plans at
>   `.planning/plans/<YYYY-MM-DD>-<topic>.md` — the flat layout
>   `docs/superpowers/{specs,plans}` symlink to. (Per-effort
>   `.planning/<effort>/` is for multi-ticket wayfind efforts, set via
>   `PI_PLANNING_EFFORT`.)

**Context note** (appended as a new paragraph, verbatim per brief):

> Note (2026-08-02 amendment): `docs/superpowers/{specs,plans}` are git-tracked
> symlinks to `.planning/{specs,plans}`, so the flat layout was already the
> de-facto home for standalone specs; this ADR makes the boundary text say so
> explicitly rather than pushing them to per-effort dirs.

---

## Verify

### Bootstrap test — all PASS (incl. `< 2000`-char invariant)

```
bun test --cwd bun-apps/pi-agent-ext-superpowers tests/bootstrap.test.ts
tests/bootstrap.test.ts:
(pass) superpowers extension wiring > registers exactly the upstream event hooks
(pass) superpowers extension wiring > resources_discover returns the real package skills/ dir
(pass) context bootstrap injection > injects the bootstrap when inject is active and it is absent
(pass) context bootstrap injection > does NOT inject when the bootstrap is already present in messages
(pass) context bootstrap injection > goes inert after agent_end (no further injection until session_start/compact)
(pass) context bootstrap injection > session_compact also re-arms injection
(pass) context bootstrap injection > inserts AFTER leading compactionSummary messages, not before them
(pass) bootstrap payload assembly > getBootstrapContent returns non-null with marker + real skill body + Pi tool mapping
(pass) bootstrap payload assembly > Pi tool mapping names the subagent ext's 'subagent' tool + its documented params
(pass) bootstrap payload assembly > carries the Pipeline routing (2-rule boundary convergence, ADR-0004-safe)
(pass) bootstrap payload assembly > routing section is meaningfully shorter than the old 3039 chars
11 pass
0 fail
64 expect() calls
Ran 11 tests across 1 file. [26.00ms]
```

### Full ext suite — green

```
bun test --cwd bun-apps/pi-agent-ext-superpowers
129 pass
0 fail
228 expect() calls
Ran 129 tests across 7 files. [159.00ms]
```

### ADR-0004 — `skills/` untouched

```
git diff --name-only -- bun-apps/pi-agent-ext-superpowers/skills/ | wc -l   → 0
git diff --name-only -- skills/ (top-level)                                  → 0
```

### Scoped commit — exactly the 3 files

Staged set before commit (no `git add -A`):

```
bun-apps/pi-agent-ext-superpowers/docs/adr/0006-unconditional-artifact-home.md
bun-apps/pi-agent-ext-superpowers/src/superpowers.ts
bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts
```

The unrelated working-tree noise (`.agents/memory/MEMORY.md`,
`.planning/…/map.md`, `.planning/…/sdd/`, `bun-apps/pi-agent-ext-tool-gate/PRD.md`)
was left unstaged and did not enter the commit.

---

## `git show --stat HEAD`

```
commit 238846c468f5fb322a40ebc9ecf7867bd6aa22d7
Author: Ziyu Huang <ziyu4huang@gmail.com>
Date:   2026-08-02 02:40:49 +0800

    fix(superpowers): route no-effort specs to flat .planning/specs/ (ADR-0006 amendment)

 .../docs/adr/0006-unconditional-artifact-home.md             | 12 ++++++++++--
 bun-apps/pi-agent-ext-superpowers/src/superpowers.ts         |  4 ++--
 bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts    |  8 ++++----
 3 files changed, 16 insertions(+), 8 deletions(-)
```

---

## Concerns

- **Clause-tighten was exercised (authorized).** The brief's verbatim Change 1
  sentence pushed the routing section to 2091 chars (> 2000). I tightened two
  pre-existing, non-assertion-required clauses (the `deriving <plan-basename>`
  parenthetical + `start-server.sh honors it too`; the
  `it's cheap insurance…` tail) to land at ~1934 chars. All surviving
  `carries the Pipeline routing` assertions remain green. This is the only
  deviation from a pure 3-sentence swap and is explicitly authorized by the
  brief.
- **Mild wording redundancy now present in rule 1.** Rule 1 reads
  `specs → .planning/<effort>/spec.md` (effort case) then
  `Specs → .planning/specs/…` (no-effort case) in the same paragraph. Both are
  correct (different `PI_PLANNING_EFFORT` states) but the juxtaposition is
  slightly dense; flagged for a future prose pass, not a correctness issue.
- No other concerns. ADR-0004 intact; commit scoped to exactly the 3 files.
