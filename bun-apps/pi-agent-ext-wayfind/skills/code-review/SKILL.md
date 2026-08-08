---
name: code-review
description: Use when reviewing a diff, branch, PR, or work-in-progress changes. Reviews along two deliberately-separate axes kept that way on purpose — Standards (does it follow this repo's documented conventions?) and Spec (does it match the originating issue/ticket?) — never merging or re-ranking them. Every finding cites its source (a repo doc, a code smell + quoted hunk, or a spec line).
---

# Code Review

Review a diff along two **deliberately-separate axes**, kept separate on purpose and never merged or re-ranked:

- **Standards** — does the code follow this repo's *documented* conventions? (Are we building the thing right?)
- **Spec** — does the code faithfully implement the originating issue / ticket / spec? (Are we building the *right* thing?)

A change can sail through one axis and fail the other: clean code that implements the wrong requirement, or correct behavior that breaks every repo convention. Reporting them side by side stops one from masking the other — which is exactly what a single merged verdict would do.

**Every finding cites its source.** A Standards finding cites the repo doc + rule it breaches, or names a code smell and quotes the offending hunk. A Spec finding quotes the spec/issue line it contradicts. An uncited finding is a hunch — leave it out.

## Process

### 1. Pin the fixed point

A review is only meaningful against a fixed comparison point. Get one from the user — a commit SHA, branch name, tag, `main`, `HEAD~5`, or a merge-base — or ask if none was given.

Identify the diff under review using **subshell-only** git (never top-level `cd` — shell discipline in `CLAUDE.md` / `~/.pi/agent/AGENTS.md`):

```bash
( git rev-parse <fixed> )                      # confirm the ref resolves
( git diff <fixed>...HEAD )                    # three-dot: diff vs the merge-base
( git log <fixed>..HEAD --oneline )            # the commits in scope
```

Three-dot (`...`) is deliberate: it compares `HEAD` against the merge-base, so the review covers *what this line of work changed* regardless of how the base branch moved.

Two fail-fast checks **before** reviewing:

- **Commit uncommitted work first.** A diff between two refs is blind to uncommitted edits — either review them invisibly or commit them so they're in scope. Surface this to the user; don't silently review half the work.
- **Empty or bad diff stops here.** A ref that won't `rev-parse`, or a diff with zero changes, fails the review *now* — not after you've spent effort finding smells against nothing.

### 2. Identify the spec source

Find what this work was supposed to deliver, in this order:

1. **Issue refs in the commit messages** — `#123`, `Closes #45`, `fixes #67`. Fetch the issue via `gh` (workflow in repo `docs/agents/issue-tracker.md`).
2. **A spec or plan under `.planning/`** matching the branch or feature — e.g. `.planning/specs/<date>-<feature>.md` or `.planning/plans/<date>-<feature>.md`.
3. **A path the user named** when they asked for the review.
4. **Ask the user** where the spec is. If they say there isn't one, that's fine — the Spec axis reports **"no spec available."** That is a valid outcome, not a failure.

### 3. Identify the standards sources

Standards come from two layers — **repo docs first, then the smell baseline as a floor:**

- **Repo docs (primary):** `CLAUDE.md` (repo root), `~/.pi/agent/AGENTS.md` (global), the per-package `CONTEXT.md` nearest the changed code, and `docs/adr/` (architecture decision records). These are the single source of truth for how *this* repo writes code — **do not re-inline** the MLX / SDD / bun invariants here; they live in those docs and you read them at review time.
- **The 12-smell baseline (universal floor):** the Fowler smells below apply even when a repo documents nothing. They are the always-on floor; repo docs sit on top.

Three rules bind how the two layers combine:

- **Repo docs override the baseline.** Where a repo standard endorses something the baseline would flag, suppress the smell — the repo wins.
- **Smells are always judgement calls.** A smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. A documented-standard breach *can* be hard; a baseline smell cannot.
- **Skip what tooling already enforces.** If Biome / `tsc` / a lint rule / CI already catches it, don't report it — the review is for things tooling doesn't.

### 4. Review both axes

Hold the two axes in the same review, but keep their findings separate.

**Standards** — walk the diff and, per file/hunk where relevant:

- For every place the diff violates a documented repo standard, cite the standard: the doc + the rule. Flag it **hard** (a documented rule was broken).
- For every baseline smell you spot, **name the smell and quote the hunk**, and mark it a **judgement call** (never hard). Remember repo-docs can override it.

**Spec** — walk the spec/issue and report four failure shapes, quoting the spec line for each:

- **Missing** — a requirement the spec asked for, absent from the diff.
- **Partial** — a requirement present but incomplete.
- **Scope creep** — behaviour in the diff the spec never asked for.
- **Implemented wrongly** — a requirement that looks done but whose implementation contradicts the spec.

If the spec source is "no spec available," the Spec axis is just that one line.

### 5. Aggregate

Emit two blocks, never blended:

```
## Standards
<findings, each with its citation>

## Spec
<findings, each quoting the spec line>   or   "no spec available."
```

Lightly clean the findings; do **not** merge them into one list, and do **not** rank a Standards finding against a Spec one — that reranking is exactly what the separation exists to prevent.

End with **one line per axis**: the total count and the single worst issue *within that axis* (if any). Never crown a cross-axis winner. The output is two honest reports side by side; what the user does with them is the user's call.

## The 12 Fowler smells (what → how to fix)

A fixed baseline from Fowler, _Refactoring_ (ch.3), applied as judgement calls. Match each against the diff; **name the smell and quote the hunk** when you find it.

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other. A single merged grade would let a clean Spec hide broken Standards, or tidy Standards hide a missing requirement — the two failures the review exists to catch.

## Process hygiene

- **Review from a fresh session.** Don't review against your own authoring context — you can't see the smells in code you just wrote. A clean read of the diff alone is the point.
- **Cite everything.** No finding ships without its source: a repo doc + rule, a named smell + quoted hunk, or a quoted spec line. An uncited finding is noise.
- **Findings are leads to act on, not a loop to converge.** The review reports what it sees; it doesn't iterate the code toward passing. Done is two cited blocks and a per-axis worst line — not "all clear."
- **Fail fast, before reviewing.** A bad ref, an empty diff, or invisible uncommitted work stops the review at step 1, not after the analysis.

Do not delegate this review or spawn agents — perform it directly.
