---
name: improve-codebase-architecture
description: Use when you want to surface where this codebase's architecture shallows out and decide what to deepen — a command-style scan that scopes to where work actually happens (a direction you name or recent git hot spots), spawns a subagent to walk the code for friction raw, then synthesizes deepening candidates in the shared codebase-design vocabulary (module / interface / seam / depth / leverage / locality) using the deletion test, presents them as a committed Markdown + Mermaid report you can render to a self-contained offline HTML, and grills the candidate you pick. Never auto-fires.
disable-model-invocation: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. This command is informed by the project's domain model and built on the shared `codebase-design` vocabulary. The domain language in each per-package `CONTEXT.md` names good seams; `docs/adr/` records decisions this command should not re-litigate. Use the architecture terms from `codebase-design` — module, interface, depth, seam, adapter, leverage, locality — in every suggestion, never drifting into component, service, unit (for module), API, signature (for interface), or boundary (for seam).

## Process

### 1. Explore — scope before you scan

**Scope before scanning — YAGNI.** Deepening a module pays off by making future changes to it easier, so put extra weight on the parts of the codebase that have recently changed. Decide *where* to look before you look:

- If the user named a direction — a module, a subsystem, a pain point, or a package — take it, and skip the inference below.
- Otherwise, walk back a good stretch of the commit history (`git log --oneline`) to find the codebase's hot spots — the files and areas that keep coming up — and let those paths pull your attention first. If the changes are scattered with no clear hot spot, widen the net.
- For this repo's distinct clusters, you may optionally target a specific package: `bun-apps/pi-agent-ext-*`, `python/mlx-movie-director`, `bun-apps/gui-movie-director`, or any other directory the user names.

Read the relevant per-package `CONTEXT.md` and any `docs/adr/` records in the area you're touching **first** — before scanning — so the subsequent walk is informed by the domain model and past architecture decisions.

Then **spawn a subagent** (pi `subagent` or `workflow`) to walk the codebase for friction **raw**. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

**Process hygiene** (adapted from `code-review`):

- **Pin the scan base** — state the commit, ref, or "working tree" up front so the scan is reproducible.
- **Every candidate cites its friction + the `codebase-design` principle it invokes.** No uncited finding.
- **Fail-fast on a bad ref or empty scope** — before spawning the subagent.
- **The scan is delegated to a subagent; the vocabulary synthesis + ranking are NOT** — perform those yourself directly after the subagent returns raw notes. Do not let the subagent pick the candidates.
- **Keep the Present step separate from the Grill step** — present candidates, let the user pick, then grill.

### 2. Present — a committed Markdown report

Write a durable Markdown report to `.planning/<effort>/architecture-review-<date>.md`. This is **committed** to the repo (per the planning-artifacts standing rule) — never write to the OS temp dir. The HTML render (below) is the optional offline view; the Markdown is the source of truth.

For each candidate, render a card in the report with these fields:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change (do NOT propose interfaces yet)
- **Wins** — ≤ 6-word bullets in `codebase-design` glossary terms (e.g. *"locality: bugs concentrate in one module"*, *"leverage: one interface, N call sites"*, *"interface shrinks; implementation absorbs the wrappers"*)
- **Strength badge** — one of `Strong`, `Worth exploring`, `Speculative`
- **Before / After diagram** — use a Mermaid `flowchart` or `sequence` diagram where the relationships are graph-shaped (dependencies, call flows, sequences); use an ASCII `<pre>` block where editorial (mass diagrams, cross-sections, layered shallowness)

**ADR conflicts**: only surface a candidate that contradicts an existing ADR when the friction is real enough to warrant reopening it. Mark it clearly, citing the ADR by its full ID: *"contradicts `ADR-orders-0007` — but worth reopening because…"*. Don't list every theoretical refactor an ADR forbids.

End the report with a **Top recommendation** section — which candidate you'd tackle first and why.

Use `CONTEXT.md` vocabulary for the domain, `codebase-design` vocabulary for the architecture.

After writing the report, **optionally render** it to a self-contained offline HTML via the package command:

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun run architecture:render ../../.planning/<effort>/architecture-review-<date>.md [out.html] )
```

Default output path is `$TMPDIR/architecture-review.html`. Tell the user the absolute path.

Finally, ask: **"Which of these would you like to explore?"** — and wait for the user's pick. Do not propose interfaces yet.

### 3. Grill — walk the decision tree

Once the user picks a candidate, **delegate to `grilling`** — a relentless one-question-at-a-time interview, each with a recommended answer. Walk the decision tree: constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive. Facts are looked up; decisions are put to the user.

Side effects happen **inline** as decisions crystallize, via **`domain-modeling`**:

- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md`. Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term during the conversation?** Update `CONTEXT.md` right there.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR — only when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing (skip ephemeral and self-evident reasons).

For **alternative interfaces** of the deepened module, use **`codebase-design`'s design-it-twice pattern**: spin up parallel subagents to design the interface several radically different ways, then compare on depth, locality, and seam placement.

---

**Anti-delegation guard**: Delegate the raw code walk to a subagent, but perform the vocabulary synthesis and the Top-recommendation ranking yourself — do not let the subagent pick the candidates.
