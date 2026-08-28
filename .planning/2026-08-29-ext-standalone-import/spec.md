# Spec — ext-standalone-import

Effort: `2026-08-29-ext-standalone-import` · Status: approved design (brainstorm 2026-08-29)

## Problem Statement

The s2-agent-sh deploy ships 15 extension bundles (`ext/<name>/ext.cjs`)
whose logic (devops git/PR/CI recipes, file2md OCR pipeline, …) is exactly
what an external automation script — typically a claude-code session —
wants to reuse. But no script outside the repo can load them: the bundles
mark their host modules `--external`, and the dist ships no `node_modules`,
so the first `require("@earendil-works/pi-ai")` fails. Today the only
consumers are the running agent itself and the repo's own deploy-e2e probes
(which cheat by resolving host modules from the build machine's workspace).
Every reuse attempt today means re-deriving the deploy's build or
hand-rolling the tool logic from scratch.

## Solution

The deploy gains ONE additional artifact: `ext/ext-standalone.cjs` — a
self-contained, side-effect-free loader ("the shim"). Any bun script, in any
directory, on any machine with the dist, does:

```js
const { loadExt, listExts } = require("<dist>/ext/ext-standalone.cjs");
const devops = loadExt("devops");
const result = await devops.tool("sync_default_branch").execute({ mode: "dryRun" });
```

and gets the real shipped tool executing — same bundle bytes the running
agent uses, evaluated with the same loader semantics
(`extRequire` + `evaluateExtModule`, `#pi/ext-dir`, vendored fallback).
The deploy also writes an `AGENTS.md` at the dist outRoot so any agent that
discovers the dist learns the mechanism without our repo. A post-deploy E2E
probe proves the whole path on every deploy, from a `/tmp` scratch dir with
no repo present.

**Relationship to `ext/<name>/ext.cjs` (not a duplicate):** the shim is a
thin layer OVER the existing per-extension bundles. It contains (a) the
8-module host registry, inlined — the irreducible cost of a standalone
process having no host to inject them — and (b) the loader logic (a few KB).
`loadExt(name)` reads `ext/<name>/ext.cjs` from disk and evaluates THAT
file; no extension code is copied, re-bundled, or rebuilt, and the 15
existing bundles are untouched by this effort.

## User Stories

1. As a claude-code session, I want to `require()` the deployed shim and
   call a devops tool with parameters, so that I get the same throw-free
   JSON outcome the in-agent tool produces, without reimplementing git/PR
   logic.
2. As a claude-code session, I want `listExts()` to enumerate the shipped
   extensions and their registered tool names, so that I can discover what
   is reusable without reading source.
3. As an automation script author on a machine with only the dist, I want
   the shim to work with zero repo checkout, zero `bun install`, and zero
   network, so that offline boxes can reuse the shipped logic.
4. As the deploy owner, I want the shim built and gated automatically on
   every deploy (foreign-specifier, foreign-path, offline containment), so
   that a broken shim cannot ship silently.
5. As the deploy owner, I want a post-deploy E2E probe that exercises the
   shim exactly the way an external consumer would (scratch dir, no repo),
   so that "standalone import works" is a deploy-time proof, not a claim.
6. As any agent that finds the dist folder, I want an `AGENTS.md` at the
   outRoot explaining the import mechanism with a working example, so that
   I can use it without reading the s2-agent repo.
7. As an extension author, I want my extension's existing
   `ext.cjs` (built by the unchanged per-ext pipeline) to be standalone-
   loadable for free, so that I do not add exports or config per extension.
8. As a consumer calling a tool, I want loud, named errors (unknown ext,
   no callable default, tool not registered, evaluation failure), so that
   integration failures are diagnosable from the error alone.

## Implementation Decisions

- **Artifact**: `<dist>/ext/ext-standalone.cjs`, built by
  `bun build --target=bun --format=cjs --minify` from a NEW side-effect-free
  entry in the s2-agent core (`src/sh/standalone.ts`). The entry re-exports
  the REAL `extRequire` / `evaluateExtModule` from `src/sh/ext-loader.ts`
  and the REAL host registry from `src/sh/host-modules.ts` — semantics
  cannot drift because there is no second implementation. It must not
  import anything on `cli-sh.ts`'s boot path.
- **Placement at `ext/` root is safe**: the runtime loader iterates `ext/`
  entries and only descends directories carrying `ext.json`; a file is
  ignored, and the `--ext-list` dual-state gate is unaffected.
- **Host registry inlined in full** (all 8 modules): measured union over the
  15 deployed manifests equals the whole registry, so no subset selection
  logic exists to drift. Size cost ~6MB/version dir (pin by measurement).
- **API contract**:
  - `loadExt(name: string, opts?: { distRoot?: string })` →
    `{ name, manifest, tools(): Array<{name, execute}>, tool(name)` (throws
    if not registered) `}`; evaluates `ext/<name>/ext.cjs`, asserts a
    callable `default`, drives the factory with a minimal registrar to
    collect registered tools (same shape deploy-e2e's `executeExtTool`
    uses).
  - `listExts(opts?)` → manifests of all shipped extensions.
  - Errors throw with the ext name and reason in the message (consumers are
    scripts, not the agent boot — fail loud, no skip semantics).
- **dist-root resolution**: default `dirname(module.filename)` — the cjs
  wrapper's `module` parameter carries the consumer-facing real path
  (bun's cjs output folds in-code `__dirname` literals, which is why the
  entry avoids them); `opts.distRoot` overrides. Proven by the E2E probe's
  foreign-path assertion.
- **Caching**: the build step follows the `.cores` content-addressed
  pattern — hash the shim's source closure (standalone.ts + ext-loader.ts +
  host-modules.ts + their src deps), the resolved pi-coding-agent version,
  Bun.version, and flags; reuse `<outRoot>/.cores`-style entries; hardlink
  into the version dir; freeze deploys chmod read-only.
- **Gates**: Gate 1 (no foreign bare specifier — with everything inlined
  the allow-list is builtins only), Gate 4 (`scanForeignPaths`; if pi
  package inlining folds `import.meta.url` asset paths, apply the existing
  `rewriteAssetImportMetaFolds` machinery), and offline Gate 5 containment
  scanning extended to cover the shim file. `deploy.json` records
  `standaloneShim: { bytes, cached }`.
- **`AGENTS.md` at the outRoot** (not per version dir): written/refreshed
  idempotently by every deploy, version-agnostic — it references the
  `current` symlink, gives the `loadExt` quickstart, lists context-free
  vs session/model-dependent tools, and states the offline contract. It
  travels with a copied dist tree and survives version rotation.
- **E2E probe `standalone-import`** (runs with the automatic post-deploy
  E2E): write a ~10-line consumer script into an empty temp dir OUTSIDE the
  repo and dist; it requires the deployed shim, `loadExt("devops")`, and
  executes `sync_default_branch` in dry-run against a throwaway fixture git
  repo (git-only, offline); assert the structured JSON outcome. Cross-check
  `file2md` through the shim with the existing OCR fixture (proves
  `#pi/ext-dir` + asset semantics pass through). Assert the shim contains
  no build-machine absolute paths.

## Testing Decisions

- **Unit (s2-agent pkg)**: `standalone.ts` contract against a fixture ext
  dir (fake ext.cjs built with the same `bun build --format=cjs` shape):
  tools registered, `#pi/ext-dir` served, unknown-ext / no-default /
  unknown-tool errors carry names, `distRoot` override works. External
  behavior (the exported API), not internals.
- **Unit (s2-agent-ext-devops pkg)**: the shim build step — cache hit
  reuses, miss builds; gate triggers fire on a poisoned fixture (foreign
  specifier / baked path).
- **E2E (deploy-e2e recipe)**: the `standalone-import` probe above — the
  highest existing seam (a real consumer process, real dist bytes), prior
  art: the file2md-ocr probe's `executeExtTool` pattern.
- Canonical gates: `bun run check && bun run typecheck && bun test` for
  `s2-agent-ext-devops`; `s2-agent`'s canonical `bun run test`.

## Out of Scope

- Named lib exports per extension (recipes as importable functions) — the
  Tools interface covers the consumption need; per-ext exports would touch
  all 15 entries.
- Per-extension standalone certificates (all 15 proven every deploy);
  devops + file2md are the guaranteed pair, the mechanism serves the rest
  by construction.
- Full agent-runtime semantics: tools needing a live session, UI, or model
  endpoints may not work standalone — the contract is "evaluate + execute
  one tool", identical to the deploy-e2e probe layer.
- Windows-specific verification of the shim (crossos lanes cover dist
  health; standalone-import probe runs on the deploy host).
- Shrinking the shim by splitting the registry per ext demand.

## Further Notes

- The shim's host-module instances are distinct from any RUNNING agent's —
  irrelevant for a standalone process (no host to share identity with), and
  consistent within the consuming process.
- deploy-e2e's existing `evaluateExtBundle`/`executeExtTool` stay
  workspace-resolved (they are build-time probes); the shim is their
  runtime-sibling, not their replacement.
- Effort map: `map.md` (D1–D7 decisions, execution order 01 → 02 →
  (03 ∥ 04) → 05).
