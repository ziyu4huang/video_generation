# Task 1 Report: Record the decision — ADR-0006

## What I did per step

### Step 1: Write ADR-0006
Created `bun-apps/pi-agent-ext-superpowers/docs/adr/0006-unconditional-artifact-home.md` with the exact ADR body specified in the brief, including:
- Date: 2026-08-02
- Status: accepted
- See references to ADR-0005 and the map
- Context, Decision, Consequences, and Alternatives considered sections
- All text exactly as provided in the brief (verbatim)

### Step 2: Add the pointer to ADR-0005
Appended the exact "Superseded clause" pointer paragraph to `bun-apps/pi-agent-ext-superpowers/docs/adr/0005-parallel-coexistence-boundary.md`:
```
**Superseded clause:** the "when an effort is active" qualifier on the
no-upstream-path rule is removed by [ADR-0006](./0006-unconditional-artifact-home.md);
this ADR's disjoint-subpath layout is unchanged.
```

### Step 3: Link ADR-0006 from the map
Appended `(ADR-0006: docs/adr/0006-unconditional-artifact-home.md)` to the ticket-03 Decisions-so-far line in `.planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/map.md`, modifying the line from ending with "... + the dual guard." to "... + the dual guard. (ADR-0006: docs/adr/0006-unconditional-artifact-home.md)"

### Step 4: Commit
Executed the scoped git add with exactly the three files specified in the brief, then committed with the exact message: `docs(superpowers): ADR-0006 — unconditional artifact home (supersede 0005 clause)`

## Git commit details

```
commit 478b8f8a6ca0986fb85259a530018428f957acce
Author: Ziyu Huang <ziyu4huang@gmail.com>
Date:   2026-08-02 02:13:15 +0800

    docs(superpowers): ADR-0006 — unconditional artifact home (supersede 0005 clause)

 .../map.md                                         |  2 +-
 .../docs/adr/0005-parallel-coexistence-boundary.md |  4 ++
 .../docs/adr/0006-unconditional-artifact-home.md   | 52 ++++++++++++++++++++++
 3 files changed, 57 insertions(+), 1 deletion(-)
```

## Concerns

None. All steps completed exactly as specified in the brief, with verbatim content and no deviations from the requirements. The scoped git add avoided touching unrelated changes in the working tree.
