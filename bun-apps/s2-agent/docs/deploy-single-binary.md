# s2-agent as a compiled binary

`bun build --compile` builds s2-agent as a standalone executable with no `bun`
runtime required on the target machine. This doc is the deep "why" + "how to
change it" reference for what that compilation implies: why extensions cannot
load the run-dir way inside a binary, how the STATIC extension set works
instead, why some files carry `// @ts-nocheck`, and how assets get embedded.

**Scope note.** The `--exe` flag this was written for is gone — `scripts/deploy.ts`
and its four modes were retired in #1740. What survives is the compilation
itself: the sh deploy's core is a `bun build --compile` binary, so everything
below about binary-mode constraints still holds for it. What does NOT apply is
the static extension set: an sh deploy loads its extensions from `ext/` at
runtime through the host-module contract, and only a bare compiled binary with
no `deploy.json` beside it falls back to the static set.

See [`deploy.md`](./deploy.md) for the deploy that actually ships.

## Why the binary can't just load every extension

`s2-agent`'s normal extension loading (`run-dir/manifest.json` + `-e <path>.ts`
CLI flags, resolved by `run-dir/resolve.ts`) goes through **jiti** — pi's
vendored `main()` transpiles each `.ts` extension at runtime. Under
`bun build --compile`, jiti feeds each extension as a
`data:text/javascript;base64,…` URL, and Bun's compiled-binary module
resolver rejects it with `NameTooLong` (`ENAMETOOLONG`). This is a
bun-compile + jiti interaction, not fixable from s2-agent's side — so
`resolve.ts` detects binary mode and never emits `-e` at all. Historically
this meant the compiled binary shipped with **zero extensions**.

## The fix: a static extension subset (two groups)

`src/static-extensions.ts` statically imports 13 extensions, in two groups
added at different times:

```
Group A — original "general productivity" set:
  s2-agent-ext-task, s2-agent-ext-prompt-history, s2-agent-ext-hermes-memory,
  s2-agent-ext-superpowers, s2-agent-ext-wayfind, s2-agent-ext-web-access
Group B — migrated from dynamic `-e` (tool-providing):
  s2-agent-ext-obsidian, s2-agent-ext-btw, s2-agent-ext-file2md,
  s2-agent-ext-subagent, s2-agent-ext-ultracode, s2-agent-ext-knowledge-card,
  s2-agent-ext-power-tool
```

Group B extensions used to be in `manifest.json`'s dynamic `extensions`
array (jiti `-e` paths) — which works in source/bundle mode but not in
`--exe` mode (binary mode emits zero `-e` flags; the `.ts` paths don't exist
in the compiled `$bunfs` virtual FS). Migrating them to static imports makes
the single-exe build bundle them by default, same as Group A.

A native ESM `import` never goes through jiti — Bun's bundler resolves and
inlines it like any other module, so it survives `--compile`. The factories
are passed into pi via `@earendil-works/pi-coding-agent`'s public API for
exactly this purpose:

```ts
await main(process.argv.slice(2), { extensionFactories: STATIC_EXTENSION_FACTORIES });
```

This registration happens in **every** mode (source/bundle/binary), not just
binary — so all 4 modes exercise identical code for these 13, and they are
deliberately **removed** from `manifest.json`'s dynamic `extensions` array
(keeping both would double-register: a jiti-loaded module and a natively
imported module aren't guaranteed to be the same module identity).

Everything else in `manifest.json` (movie-director, flux2, research-tool,
…) is unaffected and still loads normally in source/bundle mode — it's
simply unavailable in the compiled binary.

### Why relative imports, not `@repo/pkg/...` specifiers

`static-extensions.ts` imports each extension by relative path
(`../../s2-agent-ext-task/extensions/task.ts`), not a
package specifier. Two of Group A's original five (`s2-agent-ext-superpowers`,
`s2-agent-ext-wayfind`) declare a package.json `exports` map that only
exposes the root `.` entry, pointing at a `dist/index.js` build output that
doesn't exist in this checkout (no build step has run for them) — a
`@repo/s2-agent-ext-superpowers/extensions/index.ts` subpath specifier
can't resolve through that map at all. Relative imports bypass `exports`
resolution entirely, so the same pattern works uniformly across all 13
regardless of each package's own `exports` map.

### Why NOT `require()`

An earlier attempt used `require("literal/path.ts")` instead of `import`,
specifically to dodge a TypeScript problem (next section). It does dodge
that problem — `require`'s type is a plain `any`-returning function, so `tsc`
never opens the target file — but Bun's bundler does **not** inline
`require()` calls with `bun build --compile` the way it inlines `import`.
The resulting binary crashed at runtime: `Cannot find module
'../../s2-agent-ext-task/...' from '/$bunfs/root/s2-agent'`. Confirmed
empirically (grep the bundle output for the target module's source — with
`require()` it's a single unresolved literal string; with `import` it's
fully inlined, ~3 MB heavier). **The import must be a literal ESM `import`.**

## The `// @ts-nocheck` files — why they exist

Making these extensions reachable via a literal `import` has an
unavoidable side effect: TypeScript's checker now traverses and type-checks
their **full internals**, not just their exported shape. `s2-agent-ext-hermes-memory`
and `s2-agent-ext-web-access` had never been reached by any static
type-checker before (they were always jiti-loaded, which bypasses `tsc`
entirely) — so this surfaced ~35 pre-existing, unrelated type errors. Per
explicit decision (not a default), those files carry a `// @ts-nocheck` with
a comment explaining why, rather than being deep-fixed:

- `s2-agent-ext-hermes-memory/src/tools/grill-decision-tool.ts`
- `s2-agent-ext-hermes-memory/src/tools/memory-tool.ts`
- `s2-agent-ext-web-access/index.ts`
- `s2-agent-ext-web-access/curator-server.ts`
- `s2-agent-ext-web-access/extract.ts`
- `s2-agent-ext-web-access/gemini-web.ts`
- `s2-agent-ext-web-access/openai-search.ts`
- `s2-agent-ext-web-access/summary-review.ts`

This is silent-at-runtime (Bun doesn't enforce types either way) but means
`s2-agent`'s `bun run typecheck` no longer catches regressions in those
specific files. If you add another extension to the static set and its own
`tsc --noEmit` was never clean, expect the same cascade and the same
mitigation.

## hermes-memory's obsidian/knowledge-card integration (historical, now removed)

Earlier, `s2-agent-ext-hermes-memory/src/store/vault-converge.ts` optionally
integrated with `pi-obsidian` + `pi-knowledge-card` via two dynamic imports,
wrapped in try/catch so the feature degraded gracefully when they were
absent (both were listed only in hermes-memory's own
`devDependencies`/`peerDependenciesMeta.optional`, never `dependencies`).
Once hermes-memory became a static import reachable from `cli.ts`'s
entrypoint, that dynamic-import pattern needed two independent workarounds
(computed, not literal, specifiers; and `external` entries in
`scripts/deploy.ts`) to keep obsidian/knowledge-card's own module graphs out
of the binary and out of TypeScript's traversal.

That file (`vault-converge.ts`) no longer exists, and hermes-memory imports
neither `s2-agent-ext-obsidian` nor `s2-agent-ext-knowledge-card` today.
Both packages are now **Group B static extensions** in their own right (see
above) — statically imported directly in `src/static-extensions.ts` and
bundled into every build. `s2-agent-ext-knowledge-card` itself imports
`s2-agent-ext-obsidian` via the bare specifier
`@repo/s2-agent-ext-obsidian/extensions/obsidian.ts` (now a genuine static
import, not an optional one). Consequently `scripts/deploy.ts`'s
`OPTIONAL_EXTERNALS` list is now **empty** — marking these packages
`external` would make the compiled binary crash at runtime (`Cannot find
module ... from '/$bunfs/root/s2-agent'`), since `$bunfs` has no
`node_modules` to resolve a bare specifier against. Every `@repo/*` sibling
now resolves at build time and is inlined.

The CI `compile-verify` job's smoke check reflects this: it asserts obsidian's
module body IS inlined into the binary, not absent:

```bash
strings dist/s2-agent/s2-agent | grep -c "obsidian_list"   # expect > 0 (was: expect 0, pre-Group-B)
```

## Skills in binary mode

Some static extensions ship a `skills/` directory (markdown, no code):
Group A's `hermes-memory`, `superpowers`, `wayfind`, and `web-access` (which
has `skills/librarian/`, wired in alongside this work), plus Group B's
`obsidian` (`skills/using-obsidian-vault/`) and `knowledge-card`
(`skills/using-knowledge-cards/`). Only the first 4 are actually shipped in
binary mode — `manifest.json`'s `binarySkills` is a curated subset, not
"every static extension with a skills dir" (see below); obsidian's and
knowledge-card's skills dirs exist and are git-tracked but are deliberately
excluded. Pi's skill loader reads `--skill <path>` using only `node:fs` — no
jiti, no dynamic code execution — so skills are compile-safe by nature; the
only gap was that `resolve.ts` used to blanket-suppress `--skill` emission in
binary mode along with `-e`.

`run-dir/manifest.json`'s `binarySkills` array is the single source of truth,
read by both:

- `scripts/deploy.ts`'s bundle mode copies each dir to
  `dist/s2-agent/<ext-name>/skills/`, alongside the exe (same pattern as
  `theme/`/`assets/`/`export-html/`).
- `run-dir/resolve.ts`'s binary-mode branch — emits
  `--skill <dirname(process.execPath)>/<ext-name>/skills` for each entry.

Keep these two in lockstep by construction (both read `manifest.binarySkills`)
— don't hardcode the list independently in either file.

## `manifest.json` fields relevant to the binary

| Field | Read by | Purpose |
|---|---|---|
| `extensions` | `resolve.ts` (source/bundle), `build-extensions.ts` | Dynamic jiti-loaded set. The static extensions are **absent** here. |
| `binarySkills` | `deploy.ts`, `resolve.ts` | Skill dirs shipped + `--skill`'d in binary mode: a curated 4-of-6 subset (Group A's hermes-memory/superpowers/wayfind + web-access). Group B's obsidian and knowledge-card also ship `skills/` dirs but are intentionally NOT in this list, so their skills aren't `--skill`'d in binary mode even though their extension code is statically bundled. |
| `staticExtensions` | `deploy.ts` (`--snapshot` mode) | Package **directory names** (not paths) of the static extensions. Needed so `--snapshot`'s self-contained `packages/` tree includes them — even though their code is inlined into `s2-agent.js`, `s2-agent`'s own `package.json` now `workspace:*`-depends on them, and other copied packages (e.g. `s2-agent-ext-wayfind` importing `s2-agent-ext-task`'s shared status-widget module) reference them as real workspace siblings that `bun install` must resolve. |

## Adding / removing a statically-bundled extension

1. Add or remove the `import` + factory entry in `src/static-extensions.ts`.
2. Keep `manifest.json`'s `extensions` array and the static set **mutually
   exclusive** — an extension is either dynamic (`-e`-loaded, works in
   source/bundle, never in binary) or static (works everywhere, inlined into
   the binary), never both.
3. If it has a `skills/` dir you want shipped in binary mode, add it to
   `manifest.json`'s `binarySkills`.
4. Add its package to `manifest.json`'s `staticExtensions` (for `--snapshot`
   mode) and to `bun-apps/s2-agent/package.json`'s `dependencies` as
   `workspace:*`.
5. Run `bunx tsc --noEmit` — if it drags in pre-existing type errors from
   the new extension's own source (see the `@ts-nocheck` section above),
   decide then whether to silence or fix them.
6. Rebuild (`bun run deploy:exe`) and re-run the verification commands from
   the TL;DR above. `bun test` (`extension-contract.test.ts`) and
   `bun src/cli.ts ext doctor --json` both need to show it registering with
   0 conflicts.

## How `--exe` ships a truly single-file binary

An earlier iteration of `--compile` shipped 7 companion directories next to
the exe (`theme/`, `export-html/`, `assets/`, 4 skill dirs) — copy just the
exe to another machine and it booted, but theme/template resolution and
`--skill` paths silently degraded. `--exe` closes that gap: it embeds all of
those files directly into the binary via `type: "file"` import, so the
resulting `dist/s2-agent/s2-agent` can be copied to an **empty** directory
and run — no companion files needed (verified in
[README.md § Build / Deploy modes](../README.md#build--deploy-modes)'s CI job).

### How it works

1. **Build-time codegen** (`scripts/generate-embedded-assets.ts`): walks the
   same 7 directories `stageCopyAssets()` copies today, writes
   `src/generated/embedded-assets.ts` with 71 `import … with { type: "file" }`
   statements — one per file (~1.4 MB of theme JSON, export HTML templates,
   assets PNG, and skill markdown files). `.js/.ts` module files are skipped
   to avoid conflicts with pi`s own module imports.

2. **Single-pass compilation** (`stageCompileEmbed()`): compiles directly
   from `src/cli.ts` (`bun build --compile`), not via the intermediate
   bundle — preserves `` virtual paths so `Bun.file()` can read
   embedded blobs at runtime.

3. **Runtime extraction** (`src/patches/extract-embedded-assets.ts`): on
   first launch in binary mode, detects embedded assets and extracts them
   to `~/.pi/agent/embedded-assets/<manifest-hash>/`. An `.extracted` marker
   prevents re-extraction (second launch: ~170ms). Sets `PI_PACKAGE_DIR` so
   pi`s `getThemesDir()`, `getAssetsDir()`, and `getExportTemplateDir()`
   resolve from the extracted cache.

4. **Skill path resolution** (`run-dir/resolve.ts`): when
   `BUN_PI_EMBEDDED_EXTRACT_DIR` is set, binary-mode `--skill` paths resolve
   from the extraction cache instead of `dirname(process.execPath)`.

### Verification

```bash
mkdir -p /tmp/single-test && cp dist/s2-agent/s2-agent /tmp/single-test/
cd /tmp/single-test
./s2-agent --version                # works
./s2-agent doctor --json            # ok:true
ls ~/.pi/agent/embedded-assets/*/theme  # 3 JSONs extracted
ls ~/.pi/agent/embedded-assets/*/s2-agent-ext-*/skills  # 4 skill dirs
./s2-agent --version                # second run: fast, no re-extraction
```

### Design decisions

- **JS/TS files excluded** — `export-html/` contains JS modules
  (`tool-renderer.js`, `ansi-to-html.js`) that pi imports natively.
  Embedding them via `type: "file"` confuses the bundler. They are excluded
  from the manifest, which means the HTML export feature has reduced
  interactivity (no client-side JS in exported pages) in the embed binary.
- **Cache dir under `~/.pi/agent/`** — same root the README documents as
  "all per-user state". No new env-var contract.
- **`.extracted` marker** — a killed/partial extraction retries on next
  launch.

### Adding files to the embed set

Edit `scripts/generate-embedded-assets.ts` if you need to embed additional
asset directories. The codegen walks the same source dirs as
`stageCopyAssets()` — keep them in sync.


## Known limitation

The compiled binary only ever carries the static extension set (`run-dir/manifest.json` → `staticExtensions`, mirrored by `src/static-extensions.ts`). There is no
config flag to select a different subset at build time — the set is
hardcoded in `src/static-extensions.ts` by design (curated, not automatic),
so growing it is a source change + rebuild, not a runtime option.
