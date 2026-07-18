# Deploying pi-agent as a single binary

`bun build --compile` turns `pi-agent` into one standalone executable
(`dist/pi-agent/pi-agent`, ~73 MB) with no `bun` runtime required on the
target machine. This doc is the key knowledge for building, re-building, and
maintaining that binary — see [README.md § Build modes](../README.md#build-modes)
for the user-facing quick reference; this is the deeper "why" + "how to
change it" doc.

## TL;DR — build and verify

```bash
bun run build:exe                          # bun-apps/pi-agent/ → dist/pi-agent/pi-agent
dist/pi-agent/pi-agent --version
dist/pi-agent/pi-agent doctor --json       # expect ok:true, mode:"binary"
bun src/cli.ts ext doctor --json           # source-mode check that the 5 static extensions register
```

Re-running is the same command — `build.ts` cleans and rebuilds `dist/pi-agent/`
from scratch every time (no incremental cache), so there's no separate
"redeploy" step distinct from "build again". CI (`compile-verify` job in
`.github/workflows/ci.yml`) runs exactly this sequence on every PR that
touches `bun-apps/pi-agent/`.

## Why the binary can't just load every extension

`pi-agent`'s normal extension loading (`run-dir/manifest.json` + `-e <path>.ts`
CLI flags, resolved by `run-dir/resolve.ts`) goes through **jiti** — pi's
vendored `main()` transpiles each `.ts` extension at runtime. Under
`bun build --compile`, jiti feeds each extension as a
`data:text/javascript;base64,…` URL, and Bun's compiled-binary module
resolver rejects it with `NameTooLong` (`ENAMETOOLONG`). This is a
bun-compile + jiti interaction, not fixable from pi-agent's side — so
`resolve.ts` detects binary mode and never emits `-e` at all. Historically
this meant the compiled binary shipped with **zero extensions**.

## The fix: a static "general productivity" subset

`src/static-extensions.ts` statically imports 5 extensions:

```
pi-agent-ext-goal-todo, pi-agent-ext-hermes-memory, pi-agent-ext-superpowers,
pi-agent-ext-wayfind, pi-agent-ext-web-access
```

A native ESM `import` never goes through jiti — Bun's bundler resolves and
inlines it like any other module, so it survives `--compile`. The factories
are passed into pi via `@earendil-works/pi-coding-agent`'s public API for
exactly this purpose:

```ts
await main(process.argv.slice(2), { extensionFactories: STATIC_EXTENSION_FACTORIES });
```

This registration happens in **every** mode (source/bundle/binary), not just
binary — so all 3 modes exercise identical code for these 5, and they are
deliberately **removed** from `manifest.json`'s dynamic `extensions` array
(keeping both would double-register: a jiti-loaded module and a natively
imported module aren't guaranteed to be the same module identity).

Everything else in `manifest.json` (movie-director, flux2, obsidian,
file2md, …) is unaffected and still loads normally in source/bundle mode —
it's simply unavailable in the compiled binary.

### Why relative imports, not `@repo/pkg/...` specifiers

`static-extensions.ts` imports each extension by relative path
(`../../pi-agent-ext-goal-todo/extensions/pi-goal-todo-ask.ts`), not a
package specifier. Two of the five (`pi-agent-ext-superpowers`,
`pi-agent-ext-wayfind`) declare a package.json `exports` map that only
exposes the root `.` entry, pointing at a `dist/index.js` build output that
doesn't exist in this checkout (no build step has run for them) — a
`@repo/pi-agent-ext-superpowers/extensions/index.ts` subpath specifier
can't resolve through that map at all. Relative imports bypass `exports`
resolution entirely, so the same pattern works uniformly across all 5
regardless of each package's own `exports` map.

### Why NOT `require()`

An earlier attempt used `require("literal/path.ts")` instead of `import`,
specifically to dodge a TypeScript problem (next section). It does dodge
that problem — `require`'s type is a plain `any`-returning function, so `tsc`
never opens the target file — but Bun's bundler does **not** inline
`require()` calls with `bun build --compile` the way it inlines `import`.
The resulting binary crashed at runtime: `Cannot find module
'../../pi-agent-ext-goal-todo/...' from '/$bunfs/root/pi-agent'`. Confirmed
empirically (grep the bundle output for the target module's source — with
`require()` it's a single unresolved literal string; with `import` it's
fully inlined, ~3 MB heavier). **The import must be a literal ESM `import`.**

## The `// @ts-nocheck` files — why they exist

Making these 5 extensions reachable via a literal `import` has an
unavoidable side effect: TypeScript's checker now traverses and type-checks
their **full internals**, not just their exported shape. `pi-agent-ext-hermes-memory`
and `pi-agent-ext-web-access` had never been reached by any static
type-checker before (they were always jiti-loaded, which bypasses `tsc`
entirely) — so this surfaced ~35 pre-existing, unrelated type errors. Per
explicit decision (not a default), those files carry a `// @ts-nocheck` with
a comment explaining why, rather than being deep-fixed:

- `pi-agent-ext-hermes-memory/src/store/vault-converge.ts`
- `pi-agent-ext-hermes-memory/src/tools/grill-decision-tool.ts`
- `pi-agent-ext-hermes-memory/src/tools/memory-tool.ts`
- `pi-agent-ext-web-access/index.ts`
- `pi-agent-ext-web-access/curator-server.ts`
- `pi-agent-ext-web-access/extract.ts`
- `pi-agent-ext-web-access/gemini-web.ts`
- `pi-agent-ext-web-access/openai-search.ts`
- `pi-agent-ext-web-access/summary-review.ts`

This is silent-at-runtime (Bun doesn't enforce types either way) but means
`pi-agent`'s `bun run typecheck` no longer catches regressions in those
specific files. If you add a 6th extension to the static set and its own
`tsc --noEmit` was never clean, expect the same cascade and the same
mitigation.

## hermes-memory's optional obsidian/knowledge-card peers

`pi-agent-ext-hermes-memory/src/store/vault-converge.ts` optionally
integrates with `pi-obsidian` + `pi-knowledge-card` (both listed only in
hermes-memory's own `devDependencies`/`peerDependenciesMeta.optional`, never
`dependencies`) via two dynamic imports, wrapped in try/catch so the feature
degrades gracefully when they're absent. Once hermes-memory became a static
import reachable from `cli.ts`'s entrypoint, this needed two independent
fixes to stay scoped to exactly 5 extensions:

1. **Computed, not literal, specifiers** — `vault-converge.ts` builds the
   two import paths via `["@repo/pi-agent-ext-obsidian", "extensions/obsidian.ts"].join("/")`
   rather than a literal string. Bun's bundler can't statically resolve a
   computed specifier, so it stays a genuine runtime `import()` (same
   pattern `pi-agent-ext-web-access`'s `findGlimpseMjs()` already used, and
   already known to survive `--compile`). This also happens to keep
   TypeScript from traversing obsidian/knowledge-card's own module graphs.
2. **`external` in `scripts/build.ts`** — defense in depth: both
   `stageBundle()`'s `Bun.build()` call and `stageCompile()`'s
   `bun build --compile` CLI invocation list
   `@repo/pi-agent-ext-obsidian`, `@repo/pi-agent-ext-obsidian/*`,
   `@repo/pi-agent-ext-knowledge-card`, `@repo/pi-agent-ext-knowledge-card/*`
   as `external`.

Verify this hasn't regressed with a string that only exists in obsidian's
own implementation (not a generic property name like `resolveVault`, which
`vault-converge.ts` legitimately references once regardless):

```bash
strings dist/pi-agent/pi-agent | grep -c "obsidian_list"   # expect 0
```

## Skills in binary mode

3 of the 5 static extensions ship a `skills/` directory (markdown, no code):
`hermes-memory`, `superpowers`, `wayfind`. `pi-agent-ext-web-access` has one
too (`skills/librarian/`) that was newly wired in alongside this work. Pi's
skill loader reads `--skill <path>` using only `node:fs` — no jiti, no
dynamic code execution — so skills are compile-safe by nature; the only gap
was that `resolve.ts` used to blanket-suppress `--skill` emission in binary
mode along with `-e`.

`run-dir/manifest.json`'s `binarySkills` array is the single source of truth,
read by both:

- `scripts/build.ts`'s `stageCopyAssets()` — copies each dir to
  `dist/pi-agent/<ext-name>/skills/`, alongside the exe (same pattern as
  `theme/`/`assets/`/`export-html/`).
- `run-dir/resolve.ts`'s binary-mode branch — emits
  `--skill <dirname(process.execPath)>/<ext-name>/skills` for each entry.

Keep these two in lockstep by construction (both read `manifest.binarySkills`)
— don't hardcode the list independently in either file.

## `manifest.json` fields relevant to the binary

| Field | Read by | Purpose |
|---|---|---|
| `extensions` | `resolve.ts` (source/bundle), `build-extensions.ts` | Dynamic jiti-loaded set. The 5 static extensions are **absent** here. |
| `binarySkills` | `build.ts`, `resolve.ts` | Skill dirs shipped + `--skill`'d in binary mode (subset: only the 4 skill-bearing static extensions). |
| `staticExtensions` | `deploy.ts` (`--release` mode) | Package **directory names** (not paths) of the 5 static extensions. Needed so `--release`'s self-contained `packages/` tree includes them — even though their code is inlined into `pi-agent.js`, `pi-agent`'s own `package.json` now `workspace:*`-depends on them, and other copied packages (e.g. `pi-agent-ext-wayfind` importing `pi-agent-ext-goal-todo`'s shared status-widget module) reference them as real workspace siblings that `bun install` must resolve. |

## Adding / removing a statically-bundled extension

1. Add or remove the `import` + factory entry in `src/static-extensions.ts`.
2. Keep `manifest.json`'s `extensions` array and the static set **mutually
   exclusive** — an extension is either dynamic (`-e`-loaded, works in
   source/bundle, never in binary) or static (works everywhere, inlined into
   the binary), never both.
3. If it has a `skills/` dir you want shipped in binary mode, add it to
   `manifest.json`'s `binarySkills`.
4. Add its package to `manifest.json`'s `staticExtensions` (for `--release`
   mode) and to `bun-apps/pi-agent/package.json`'s `dependencies` as
   `workspace:*`.
5. Run `bunx tsc --noEmit` — if it drags in pre-existing type errors from
   the new extension's own source (see the `@ts-nocheck` section above),
   decide then whether to silence or fix them.
6. Rebuild (`bun run build:exe`) and re-run the verification commands from
   the TL;DR above. `bun test` (`extension-contract.test.ts`) and
   `bun src/cli.ts ext doctor --json` both need to show it registering with
   0 conflicts.

## Known limitation

The compiled binary only ever carries these 5 extensions. There is no
config flag to select a different subset at build time — the set is
hardcoded in `src/static-extensions.ts` by design (curated, not automatic),
so growing it is a source change + rebuild, not a runtime option.
