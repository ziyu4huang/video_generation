type: task
blocked by: 02-webui-pilot

## Question

Migrate `pi-agent-ext-superpowers` and `pi-agent-ext-wayfind` to src package roots using the
pilot recipe from ticket 02, carrying the publish decision from ticket 01.

Package-specific extras:

- **superpowers**: entry is already a 1-line shim to `../src/index.js`; only root fields move.
- **wayfind**:
  - Fix the dangling `pi.extensions: ["./extensions/index.ts"]` (no such file — should be
    `wayfind.ts` or dropped per the one-canonical-entry rule).
  - `build` is `bun run architecture:vendor && bunx tsc` — determine whether the vendored
    `vendor/mermaid.min.js` (gitignored, 3.4 MiB) is consumed from `src/` at dev time. If yes,
    the vendor script must survive independent of tsc (e.g. `"pretest"`/`postinstall` or
    document in README); if dist-only, it can go with the build.
  - Vendor step has a user-facing failure mode if `scripts/vendor-mermaid.ts` needs network —
    keep it offline-safe or lazy.

## Resolution

**Done.** Both packages flipped with the ticket-02 recipe: root fields → `./src/index.ts`,
`publishConfig`/`files`/`prepublishOnly`/`build` deleted, `test` = `check && test:unit`,
`outDir: dist` removed from both tsconfigs, superpowers README dev-commands block updated.
Both were already `private: true`; `pi.extensions` on wayfind was already `wayfind.ts` on
main (the explorer report that flagged `index.ts` was stale).

**Fog resolved** — mermaid vendor: `src/architecture-render.ts:311-315` reads
`vendor/mermaid.min.js` at RENDER time relative to src, with a graceful
`/* mermaid not vendored */` fallback. The vendor script is an offline copy from
`node_modules/mermaid` (mermaid is a dependency), so it survives the build's deletion as
`"pretest": "bun run architecture:vendor"` — every canonical test re-vendors; fresh
checkouts get it on first `bun run test`.

Verification (2026-08-15):

- superpowers canonical `bun run test`: **132 pass / 0 fail**; wayfind: **546 pass / 1
  skip / 0 fail** (with pretest vendor).
- Both package typechecks exit 0; pi-agent cross-package typecheck exit 0.
- After `rm -rf dist/` (both packages): superpowers 132 pass; wayfind 500 pass across 27
  files — the 2 files / 47 tests that vanished were STALE COMPILED `.test.js` copies inside
  the old dist (tsc had been compiling test files); src suite is complete at 27 files.
- `./pi-agent.sh -p` boots clean: `BOOT3OK`, zero stale warnings.
- CI matrix rows for both packages are the generic `bun run test` — automatically correct
  after the chain change.

Ticket closed 2026-08-15.
