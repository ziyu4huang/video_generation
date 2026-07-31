# scene-assets → workflow-pack conversion (pilot)

**Date:** 2026-07-22
**Status:** approved, not yet implemented

## Why

`pi-agent-ext-movie-director`'s four saved workflows (`/produce-video`,
`/scene-assets`, `/research-first`, `/review-cut`) are all single-file `.js`
scripts under `workflows/*.js`. `pi-agent-ext-workflow` also supports a richer
**workflow-pack** format (a folder with `manifest.json` + an entry script +
optional `agents/`), which movie-director has never used. This is a pilot to
trial the pack format on the smallest, most independent of the four workflows
— `scene-assets` — and fix whatever breaks in the process, before deciding
whether to convert the other three.

## Scope

- Convert only `scene-assets` (not `produce-video`, `research-first`,
  `review-cut` — those stay single-file `.js` for now).
- Structural verification only (parse, resolve, dry-run, existing test
  suite). No real GPU/model e2e run — that was already deferred as a known
  gap in the 2026-07-12 `workflow-redesign` receipt and is out of scope here.

## Design

### File changes

- **Add** `workflows/scene-assets/manifest.json`:
  ```json
  {
    "name": "scene-assets",
    "description": "Parallel per-scene asset generation: T2I still → I2V clip (chained for long scenes) → TTS narration. Deterministic via call(\"movie.*\").",
    "entry": "index.js",
    "kind": "workflow-pack",
    "engine": "pi-agent-ext-workflow"
  }
  ```
- **Add** `workflows/scene-assets/index.js` — byte-identical content to the
  current `workflows/scene-assets.js`. Confirmed (via Explore-agent
  investigation) that `parseWorkflowScript`/`runWorkflow` in
  `pi-agent-ext-workflow/src/workflow.ts` support the bare-top-level-statement
  style natively (the `export default async function(...)` shape used by the
  template is optional convenience, not a requirement) — this is exactly the
  style `pi-agent-cli`'s shipped `echo`/`args-demo`/`sample` packs use. No
  rewrite of the script body is needed.
- **Remove** `workflows/scene-assets.js` (the pack replaces it; no duplicate
  left behind).
- No `agents/` dir and no `inputs/outputs/intermediate/runs/` ephemeral dirs —
  confirmed real checked-in packs (`echo`, `args-demo`, `sample` under
  `pi-agent-cli/workflows/`) ship without them. Per
  `pi-agent-ext-workflow/CONTEXT.md`'s "Checked-in pack state redirect", a
  pack under a read-only package dir (`bun-apps/<pkg>/workflows/`)
  automatically redirects its runtime state to
  `.pi/workflows/.state/<pack-id>/` — no local state scaffolding required.

### Code changes (the actual bugs this pilot surfaces)

1. `extensions/movie-workflows.ts:26` — static import path
   `import sceneAssetsSrc from "../workflows/scene-assets.js" with { type: "text" }`
   must become `"../workflows/scene-assets/index.js"`. Everything downstream
   (the `WORKFLOWS` array, `registerCommand`, `loadSavedWorkflow`) is
   unaffected since the imported text is identical.
2. `extensions/movie-workflows.test.ts` — currently:
   ```ts
   const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".js") && !f.startsWith("_"));
   ```
   only scans flat `.js` files, so converting `scene-assets` to a pack
   directory would silently drop it from structural coverage (no failure —
   just quietly stops being tested). Fix: also discover subdirectories that
   contain a `manifest.json`, resolve their `entry` file, and run the same
   two checks (parses + all `call('movie.*')` refs resolve) against the
   pack's entry script content.

### Verification (structural only — no GPU/model)

- `bun test` in `pi-agent-ext-movie-director` — updated
  `movie-workflows.test.ts` covers the packed `scene-assets` the same as
  before (parse + host-fn ref resolution).
- A resolver check using `resolveWorkflowScript`/`resolveWorkflowPack` from
  `@repo/pi-agent-ext-workflow` confirms the new pack resolves with
  `source: "package-workflows"` and a populated `pack.manifest`.
- `runWorkflowScript({ name: <pack path>, dryRun: true })` confirms the pack
  parses/validates end-to-end without executing.
- Full package `bun test` suite passes with no regressions (baseline: 467
  pass / 0 fail / 8 skip per the 2026-07-12 workflow-redesign receipt).

### Out of scope

- Converting `produce-video`, `research-first`, `review-cut` to packs.
- Any real GPU/model end-to-end run of the converted workflow.
- Changing `registerMovieWorkflows`'s hardcoded `WfDef.desc` to read from the
  pack manifest — the command description is already known statically; no
  need to plumb the manifest through for this pilot.

## Testing

Covered above under Verification — no new test *strategy* beyond extending
the existing `movie-workflows.test.ts` to discover pack directories, plus one
resolver/dry-run smoke check (either as a new small test or an ad-hoc script
run and discarded).
