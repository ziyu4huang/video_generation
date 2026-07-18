# IMPLEMENTED (2026-07-18): truly single-file `--compile-embed` binary

Status: **implemented** — the plan from this doc has been built and verified.
Key content folded into [`deploy-single-binary.md`](deploy-single-binary.md)
(see § --compile-embed mode). This file is kept as a historical reference.

## Problem

The `--compile` binary shipped in the previous change (see
[`deploy-single-binary.md`](deploy-single-binary.md)) is not actually a
single file to *deploy*: `scripts/build.ts`'s `stageCopyAssets()` also
copies 7 companion directories next to the exe —

```
dist/pi-agent/
├── pi-agent                              # the exe itself
├── theme/                                # pi's built-in theme (11 files)
├── export-html/                          # pi's HTML export templates (17 files)
├── assets/                               # pi's interactive-mode assets (1 file)
├── pi-agent-ext-hermes-memory/skills/    # 1 file
├── pi-agent-ext-superpowers/skills/      # 48 files
├── pi-agent-ext-wayfind/skills/          # 9 files
└── pi-agent-ext-web-access/skills/       # 1 file
```

Copy just `pi-agent` somewhere else and it still boots (per `doctor --json`
in the previous change's verification), but `theme`/`export-html`/`assets`
resolution and all 4 `--skill` paths silently fail to find their files —
the binary degrades rather than errors, which is worse than an obvious
failure for a "single file" distribution story.

This plan adds a **second, additional** build mode that embeds all of the
above directly into the executable, so a single `dist/pi-agent/pi-agent`
file is genuinely sufficient to copy and run anywhere. The existing
`--compile` mode (companion dirs) stays unchanged — this is additive, not a
replacement, since the companion-dir mode is simpler and already
CI-verified.

## Feasibility — confirmed empirically before writing this plan

Two things had to be verified before this was worth designing in detail;
both were tested in a throwaway scratch script, not assumed:

1. **Bun can embed arbitrary non-JS files into a `--compile` binary.**
   `import x from "./file.txt" with { type: "file" }` gives back a
   `$bunfs`-scheme virtual path string. Confirmed: deleting the source file
   and running the compiled exe from an unrelated cwd still resolves it —
   `Bun.file(x)` and, critically, **plain `node:fs`'s `readFileSync`/
   `existsSync` also work transparently on that virtual path** (Bun patches
   its `fs` shim to understand `$bunfs`). This matters because pi's skill
   loader (`@earendil-works/pi-coding-agent`'s `dist/core/skills.js`) uses
   only `node:fs` calls, not `Bun.file()`.

2. **`getPackageDir()` (and the theme/export-html/assets getters built on
   it) already supports an env-var override, even in binary mode.** Read
   directly from the vendored SDK
   (`@earendil-works/pi-coding-agent/dist/config.js`):
   ```js
   export function getPackageDir() {
     const envDir = process.env.PI_PACKAGE_DIR;
     if (envDir) return normalizePath(envDir);
     if (isBunBinary) return dirname(process.execPath);
     // ...
   }
   ```
   `pi-agent`'s existing `src/patches/set-package-dir.ts` already uses this
   exact mechanism — but its `shouldSetPackageDir()` gate deliberately
   **excludes binary mode** today ("not the binary (assets alongside) — no
   override"), because the current binary mode relies on the sibling-copy
   approach instead. This plan only needs to **extend that existing gate**,
   not invent a new redirection mechanism or monkey-patch the vendored SDK.

**One real constraint found:** embedding via `type: "file"` **flattens**
directory structure — each embedded file lands at a random hashed name
directly under `/$bunfs/root/` (`Bun.embeddedFiles` confirms this: `.name`
is `SKILL-9g2myaqz.md`, not the original relative path). Since pi's skill
loader does `readdirSync` on a directory expecting real subdirectories per
skill, embedded files must be **extracted to a real directory at runtime**
before `--skill <path>` can point at them — there's no way to skip this
step and hand the loader raw embedded blobs directly.

## Design

### 1. Build-time codegen — `scripts/generate-embedded-assets.ts` (new)

Walks the same source directories `stageCopyAssets()` already copies today
(`theme/`, `export-html/`, `assets/` from the resolved
`@earendil-works/pi-coding-agent` package dir, plus each dir listed in
`manifest.json`'s `binarySkills`) and writes
`src/generated/embedded-assets.ts` (gitignored, same convention as
`pi-pkg-dir.ts`/`run-dir-base.ts`):

```ts
// AUTO-GENERATED — do not edit or commit
import a0 from "<abs-path-to-file-0>" with { type: "file" };
import a1 from "<abs-path-to-file-1>" with { type: "file" };
// ... one import per file (~88 files, ~1.6 MB total today)

export const EMBEDDED_ASSETS: Array<{ relPath: string; blobPath: string }> = [
  { relPath: "theme/xyz.json", blobPath: a0 },
  { relPath: "pi-agent-ext-superpowers/skills/brainstorming/SKILL.md", blobPath: a1 },
  // ...
];
```

`relPath` mirrors exactly the destination layout `stageCopyAssets()` already
produces (`theme/…`, `export-html/…`, `assets/…`,
`<ext-name>/skills/…`) — reusing that layout means the extraction step and
`resolve.ts`'s existing binary-mode path-joining logic don't need new
naming conventions, just a different base directory.

### 2. New build flag — `scripts/build.ts --compile-embed`

Additive to the existing `--compile`/`--all` flags:

```bash
bun scripts/build.ts --compile-embed   # bundle + compile, assets EMBEDDED (no companion dirs)
```

Pipeline: run the new codegen stage before `stageBundle()` (so the
generated file's imports are picked up by the normal bundle pass — Bun's
`--compile` step embeds `type: "file"` imports automatically, no extra CLI
flags needed), then compile as usual, then **skip** `stageCopyAssets()`
entirely for this flag (that's the whole point — nothing should need to
exist next to the exe).

Import `embedded-assets.ts` from a new module,
`src/patches/extract-embedded-assets.ts` (see below), NOT from `cli.ts`
directly — keeps the classic `--compile` path's bundle untouched when this
patch is a no-op there (see detection below).

### 3. Runtime extraction — `src/patches/extract-embedded-assets.ts` (new patch)

Registered in `src/patches/index.ts` like every other patch. Logic:

```ts
if (mode === "binary" && Bun.embeddedFiles?.length) {
  // ↑ Auto-detects "am I the --compile-embed variant?" — the classic
  // --compile binary never embeds type:"file" assets, so this array is
  // empty there and the whole patch is a safe no-op. No separate build-time
  // flag needs to be threaded through to runtime.
  const cacheDir = resolveCacheDir();       // see below
  if (!isAlreadyExtracted(cacheDir)) {
    extractAll(EMBEDDED_ASSETS, cacheDir);  // Bun.write(join(cacheDir, relPath), Bun.file(blobPath))
    markExtracted(cacheDir);
  }
  process.env.PI_PACKAGE_DIR ??= cacheDir;  // theme/export-html/assets resolve via the EXISTING env-var support
}
```

- **Cache dir**: `~/.pi/agent/embedded-assets/<contentHash>/` — under the
  same `~/.pi/agent` root the README already documents as "all per-user
  state" (session/auth/model data, hermes-memory's sqlite DB). This is
  vendor-asset cache, not user data, but it's the one location this repo's
  convention already guarantees is writable and machine-local, avoiding a
  new env-var contract. `<contentHash>` is a hash of the embedded manifest
  (file count + total size + `Bun.version`, mirroring the precedent in
  `build-extensions.ts`'s warm-deploy hash cache) — a rebuilt binary with
  changed assets gets a fresh cache dir automatically; stale ones are never
  cleaned up automatically (acceptable: ~1.6 MB each, worth a follow-up if
  it matters).
- **Idempotency**: a marker file (`.extracted`) inside `cacheDir`, written
  last after all files succeed, so a killed/partial extraction is detected
  as incomplete and retried rather than silently used half-populated.
- Extend `set-package-dir.ts`'s `shouldSetPackageDir()` — OR, cleaner, just
  let this new patch set `process.env.PI_PACKAGE_DIR` directly (as sketched
  above) and leave `set-package-dir.ts` untouched, since its own gate is
  specifically about the *bundle* case and this is a different code path
  with a different source of truth for the dir. Patch ordering matters:
  this must run in `src/patches/index.ts` **before** `main()` is called
  (same constraint every other patch already has), and specifically before
  anything reads `getThemesDir()`/`getAssetsDir()` — verify patch execution
  order doesn't already read these first (`pre-load-providers-patch.ts`
  touches `ModelRegistry`, unrelated; should be safe, confirm at
  implementation time).

### 4. `run-dir/resolve.ts` — binary-mode `--skill` paths

Currently: `join(dirname(process.execPath), rel)` for each
`manifest.binarySkills` entry. Extend the same `Bun.embeddedFiles?.length`
detection: when true, join against the extraction cache dir instead (same
one `extract-embedded-assets.ts` computed — expose it via a small shared
helper, e.g. `src/patches/extract-embedded-assets.ts` exports
`resolveCacheDir()` and both modules import it, so there's one source of
truth for "where did we extract to").

### 5. Verification plan

```bash
bun scripts/build.ts --compile-embed
# Move JUST the exe to an empty, unrelated directory — proves no companion
# files are required, unlike the classic --compile mode:
mkdir -p /tmp/single-exe-test && cp dist/pi-agent/pi-agent /tmp/single-exe-test/
cd /tmp/single-exe-test
./pi-agent --version
./pi-agent doctor --json                     # ok:true
BUN_PI_DEBUG_RUN_DIR=1 ./pi-agent --help      # 4 --skill paths, now under ~/.pi/agent/embedded-assets/<hash>/
ls ~/.pi/agent/embedded-assets/*/theme        # confirm extraction landed
./pi-agent --version                          # second run: confirm no re-extraction (fast, marker honored)
```

Also confirm the classic `--compile` (non-embed) build is completely
unaffected — `extract-embedded-assets.ts` must be a true no-op there
(`Bun.embeddedFiles` empty), so the existing `compile-verify` CI job's
assertions should all still hold unchanged.

### 6. CI

Propose a new job, `compile-embed-verify`, mirroring `compile-verify` but
building with `--compile-embed` and running the "copy just the exe to an
empty dir" test above as the core assertion (that's the one thing that
actually proves this mode's value over the existing one). Left for a
follow-up decision — not blocking the initial implementation.

## Open items to confirm during implementation (not blocking this plan)

- Exact point in `src/patches/index.ts`'s ordering where
  `extract-embedded-assets.ts` must run relative to other patches — verify
  nothing upstream of it touches `getThemesDir()`/`getAssetsDir()` first.
- Total embedded size (~1.6 MB today) is trivial next to the ~73 MB binary
  — no compression/size concern expected, but confirm final binary size
  delta after implementation.
- Decide whether stale `~/.pi/agent/embedded-assets/<old-hash>/` dirs from
  previous binary versions should be pruned (e.g. keep only the N most
  recent) — not implementing this in v1, flagged for a follow-up if it
  becomes a real disk-usage complaint.
- Windows path handling for the cache dir (`~/.pi/agent` resolution) —
  this repo is Apple Silicon-only per `CLAUDE.md`, so likely out of scope,
  confirm no Windows CI job would exercise this mode.
