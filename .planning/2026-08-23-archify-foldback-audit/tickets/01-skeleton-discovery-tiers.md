---
ticket: 01-skeleton-discovery-tiers
effort: archify-foldback-audit
type: task
status: done
created: 2026-08-23
last: 2026-08-23
blocked-by: []
---
# 01 — Skeleton discovery tiers: injectable `shippedDir` + `$ARCHIFY_TEMPLATES`

> Spec **D1**. The fold-back item (a) + (b): give `discoverDeckSkeletons` the same tier seam the
> layout registry already has (`shippedDir` override + `$ARCHIFY_TEMPLATES` user tier).

## Problem (measured 2026-08-23)

`discoverDeckSkeletons(root)` (`src/deck-lint-tool.ts:119-140`) builds its dirs as
`[<root>/templates/decks, <pkgRoot()>/templates/decks]`, first-hit-wins, shadowed names dropped. It
reads `env` nowhere and takes no `shippedDir`. `loadRegistry` (`src/layout-registry.ts:96-194`)
already does both. The layout catalog is tier-aware; the skeleton catalog is not.

## Change

1. Replace `discoverDeckSkeletons(root: string)` with `discoverDeckSkeletons(opts)` where
   `opts: { root?: string; env?: NodeJS.ProcessEnv; shippedDir?: string }` (default `{}`). Search
   order mirrors `loadRegistry`:
   - user tier: each `$ARCHIFY_TEMPLATES` dir `<dir>/decks` (in env order), then `<root>/templates/decks`
   - shipped tier: `<shippedDir>/decks` or `<pkgRoot()>/templates/decks`
   - first hit wins by `name`; shadowed names dropped; skip non-existent dirs.
   Wall-clock: absolute-path resolution (`isAbsolute`/`resolve`) exactly as `loadRegistry:@101-107`.
2. Update the single call site (`src/deck-lint-tool.ts:154`) to
   `discoverDeckSkeletons({ root, env: ctx.env })`.
3. Keep the exported `DeckSkeleton` shape (`name`, `description` from the first H1 after frontmatter,
   `source`) byte-identical — the consumer at `:154-164` depends on it.
4. Update `tests/deck-lint-tool.test.ts` (and/or a focused `tests/deck-skeletons.test.ts` block):
   - a different-root shipped tree: `discoverDeckSkeletons({ root, shippedDir })` where `shippedDir`
     points at a scratch dir with `decks/x.outline.md` → finds `x`, and does NOT pick up the real
     shipped tree.
   - a user-tier env dir: `discoverDeckSkeletons({ root, env: { ARCHIFY_TEMPLATES: dir } })` with
     `dir/decks/user.outline.md` → finds `user`; and `user` shadows a same-named shipped skeleton.
   - end-to-end: `archifyDeckLint({}, { cwd: PKG_ROOT, env: { ARCHIFY_TEMPLATES: dir } })` lists the
     user deck skeleton in `details.decks` and the catalog text.
   - the no-args catalog test keeps returning exactly the four shipped skeletons (regression guard for
     D1's default-path behavior).

## Done when

- [ ] `discoverDeckSkeletons` takes `{ root, env, shippedDir }`; the one internal caller updated.
- [ ] `bun test` green; new tests prove different-root shipped tier, `$ARCHIFY_TEMPLATES` user tier,
      shadowing, and the end-to-end catalog listing.
- [ ] `bun run typecheck` clean.
- [ ] `deck-lint-tool.test.ts`'s "four shipped skeletons" catalog assertion still passes unchanged.
