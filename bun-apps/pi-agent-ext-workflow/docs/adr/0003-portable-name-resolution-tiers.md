**ID:** `ADR-workflow-0003` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# Portable name-resolution tiers: cwd/bin rank ABOVE the repo tiers

**Status:** accepted (landed in PR #661, `feat(workflow-pack): portable name-resolution tiers (cwd/bin) for repo-less binary`; this ADR backfills the decision record the code comment already cited)

`resolveWorkflowScript(name)` — the single source of truth mapping a `<name>` (or path) to runnable script text — resolves in five tiers, first hit wins; per location a pack directory (`<name>/manifest.json`) beats a same-name `.js`:

1. `<name>` as a literal path (file, or a pack directory via its manifest).
2. `<cwd>/workflows/<name>` — portable tier; no repo root needed.
3. `<binDir>/workflows/<name>` — packs shipped next to the compiled binary (`binDir` defaults to `dirname(process.execPath)`; injectable for tests).
4. `.pi/workflows/<name>` — project packs, under the repo-root walk-up.
5. `bun-apps/<pkg>/workflows/<name>` — package-local packs.

## Decision

The portable tiers (2–3) rank **above** the repo tiers (4–5): "most local wins". A same-named pack in `<cwd>/workflows/` deliberately shadows the `.pi/workflows/` one.

## Rationale

- The compiled, repo-less binary (`bun --compile`) has no repo root at all — tiers 4–5 simply don't exist for it. Tiers 2–3 are its only discovery surface, so they must come first for behavior to be consistent between in-repo and repo-less invocations.
- "Most local wins" matches user intent: dropping a pack into the directory you run from is the most explicit non-path gesture available.

## Consequences

- A stray `<cwd>/workflows/<name>` can shadow a project pack of the same name. Accepted: the resolver's `source` field (`cwd-workflows` vs `.pi/workflows`) makes the winning tier observable.
- CONTEXT.md's resolver section must list all five tiers (it is the ubiquitous-language source of truth for this seam).
