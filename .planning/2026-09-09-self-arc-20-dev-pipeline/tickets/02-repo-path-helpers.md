# Ticket 02 — repo/runpy path helpers → core-runtime

## Goal

Move `resolveRepoRoot`, `resolveRunPyPaths`, `defaultBinaryPath` (currently
exported by `s2-agent-ext-ltx`) into `bun-apps/s2-agent-core-runtime` (near
`home.ts`), have ltx re-export them for back-compat, and switch
`s2-agent-ext-movie-director` to import them from core-runtime.

## Why

These are environment/path helpers (where is the repo root, which python,
which binary) with nothing LTX-specific about them; movie-director imports
ltx in ≥5 files ONLY for these helpers. Per effort D1 they belong in the
shared runtime package.

## Constraints

- core-runtime must not import from any ext package (verify before adding).
- ltx keeps exporting the names (re-export from core-runtime) — its own
  consumers and tests must not break.
- movie-director: switch all path-helper imports to
  `@repo/s2-agent-core-runtime`. If AFTER this no ltx import remains in
  movie-director production src (map first — runFlux2/runKrea2 edges are
  flux2/krea2, not ltx; check for any other ltx use), drop its
  `@repo/s2-agent-ext-ltx` runtime dep; otherwise leave the dep and note it.
- movie-director already depends on core-runtime; ltx does NOT depend on
  core-runtime yet — add `"@repo/s2-agent-core-runtime": "workspace:*"` to
  ltx's package.json deps, then run `( cd bun-apps && bun install )` ONCE at
  the end (you are the only ticket that installs).
- Repo conventions: explicit `.ts` extensions on relative imports; NO git
  mutations.

## Steps

1. Map: grep the three helper names + `from "@repo/s2-agent-ext-ltx"` across
   `bun-apps/s2-agent-ext-movie-director/src` and everywhere else repo-wide
   (other packages may import them from ltx — switch them too if trivial,
   else they ride the ltx re-export; report which).
2. Read `bun-apps/s2-agent-core-runtime/src/home.ts` + `index.ts` for style;
   add `src/repo-paths.ts` (move the implementation verbatim; keep behavior
   identical, including any MLX_MODELS_DIR / --models-dir handling).
3. Export from core-runtime `index.ts`; ltx re-exports from its old site.
4. Switch movie-director imports (all files).
5. Tests: `bun test` green in core-runtime, ltx, movie-director (+ any other
   package you switched).

## Acceptance

- No production file outside ltx imports the helpers from `@repo/s2-agent-ext-ltx`.
- `bun test` green in touched packages; `cd bun-apps && bun test tests/dep-guard.test.ts` green.
- Report: files changed, whether movie-director's ltx dep was dropped, dep edges installed.
