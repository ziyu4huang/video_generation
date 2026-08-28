---
effort: 2026-08-29-ext-standalone-import
created: 2026-08-29
last: 2026-08-29 (ticket 01 closed — shim entry + 12 tests green, D4 amended to ESM .mjs)
status: active
---

# Wayfinder map: 2026-08-29-ext-standalone-import

## Destination

Any external bun script — a claude-code session, a scratch `/tmp` probe, a
cron job on another machine — can `require()` the deployed
`<dist>/ext/ext-standalone.cjs` and drive the shipped extensions' tools
(`loadExt("devops").tool("sync_default_branch").execute(…)`), with zero repo
checkout, zero `bun install`, zero rebuild. The deploy produces the shim
automatically, gates it like every other dist artifact, proves it with a
post-deploy E2E probe, and ships an `AGENTS.md` at the dist outRoot so any
agent that finds the dist can use the mechanism without reading our source.

## Context

- Measured 2026-08-29 on this machine, dist `darwin-arm64/0.7.25+gefcd32f`:
  every `ext/<name>/ext.cjs` is a `bun build --format=cjs` bundle whose host
  modules are `--external`; the dist has NO `node_modules`, so a plain
  external `require()` of any `ext.cjs` fails at its first
  `require("@earendil-works/pi-ai")`. The runtime core injects host modules
  from its own embedded copies (`bun-apps/s2-agent/src/sh/host-modules.ts`,
  HOST_API 2, 8 registry entries).
- Measured 2026-08-29 (union over all 15 deployed `ext.json` manifests): the
  hostModules union is ALL 8 registry modules (`pi-coding-agent`, `pi-tui`,
  `typebox`, `typebox/value`, `core-runtime`, `core-interface`, `pi-ai`,
  `pi-ai/compat`) — no subset logic needed; the shim inlines the full
  registry. `devops` itself needs only `typebox`, `pi-ai`, `core-interface`.
- The repo already has the exact evaluation semantics we need:
  `evaluateExtBundle` / `executeExtTool` in
  `bun-apps/s2-agent-ext-devops/src/deploy/lib/ext-build.ts` evaluate a
  deployed `ext.cjs` "the way the runtime loader does" (`extRequire` +
  `evaluateExtModule`, `#pi/ext-dir`, vendored fallback) — but they resolve
  host modules from the BUILD MACHINE's workspace, so they cannot run
  outside the repo. The shim is the same logic re-packaged self-contained.
- `ext.cjs` exports only `default` (the pi extension factory) + a few
  `*_PROBES` constants; tools are registered through the factory at
  evaluation time. (deploy-e2e's `executeExtTool` already drives tools this
  way for the file2md OCR probe.)
- Core bundle `s2-agent.js` runs module-scope side effects (loads all exts,
  calls `main()`) — requiring it for host modules is NOT viable; a separate
  side-effect-free entry is required.
- Deploys are frozen (`dr-xr-xr-x`), content-addressed-cached for cores
  (`<outRoot>/.cores/`), retention keep-5; adding ~6MB/version dir is the
  measured-order size cost of the shim (to be pinned by measurement in t02).

## Tickets

**Execution order:** 01 → 02 → (03 ∥ 04) → 05 — 01→02→{03,04} forced by
`blocking:` edges; 03 and 04 are parallelizable after 02 (03 chosen first:
the AGENTS.md documents what 04's probe then proves end-to-end); 05 closes.
Confirmed 2026-08-29.

| Ticket | Status | Summary |
|---|---|---|
| `tickets/01-shim-entry.md` | closed | `standalone.ts` + 12 contract tests green; s2-agent full suite 989 pass/0 fail; D4 amended (ESM `.mjs`, `import.meta.dir` self-location) |
| `tickets/02-deploy-build-step.md` | open | Deploy builds `<dist>/ext/ext-standalone.cjs` (full-registry inline, content-addressed cache, Gates 1/4/5, deploy.json record) |
| `tickets/03-dist-agents-md.md` | open | Deploy writes `<outRoot>/AGENTS.md` — agent-facing usage guide for the standalone import mechanism |
| `tickets/04-e2e-standalone-import.md` | open | Post-deploy E2E probe `standalone-import`: /tmp consumer script, devops dry-run on a fixture git repo, file2md cross-check, foreign-path assert |
| `tickets/05-ship-and-close.md` | open | Fresh deploy on this machine with E2E green, repo docs touch-up, effort close-out |

## Decisions

- D1 (2026-08-29, brainstorm — user): consumption interface = **Tools
  介面** — `loadExt(name) → { tool(name), tools(), manifest }`; no named
  lib exports per extension (that would touch all 15 ext entries).
- D2 (2026-08-29, brainstorm — user): scope = **universal mechanism,
  devops primary** — the shim serves every ext by construction; E2E
  guarantees devops + file2md cross-check only, not per-ext certificates.
- D3 (2026-08-29, brainstorm — user): host-module supply = **self-contained
  shim bundle** at `ext/ext-standalone.cjs` (8 host modules inlined),
  over the alternatives: vendored `node_modules` tree (bigger, closure
  computation, offline-gate re-verification) or a second core entry at the
  version-dir root (same construct, two-entry drift risk).
- D4 (2026-08-29, design; amended same day during t01): the shim is an ESM
  bundle `ext/ext-standalone.mjs` (`bun build --target=bun`, like the core),
  NOT cjs — in an ESM bun bundle `import.meta.dir` is the bundle's REAL
  runtime path (the deployed core resolves its ext root the same way,
  `mode.ts deployRoot`), whereas bun's cjs output folds in-code
  `__dirname`/`__filename` to build-machine paths. Explicit `distRoot`
  option overrides; proven by t04's foreign-path assert.
- D5 (2026-08-29, user requirement): the deploy writes an **`AGENTS.md` at
  the dist outRoot** — version-agnostic (references `current`), so any
  agent discovering the dist learns the import mechanism without our repo.
- D6 (2026-08-29, design): caching follows the `.cores` content-addressed
  pattern (hash = shim source closure + pi pkg version + Bun.version +
  flags; hardlink; freeze chmod read-only).
- D7 (2026-08-29, confirm-gate — user): execution order above recorded.

## Frontier

`tickets/01-shim-entry.md` — everything else builds on the entry's export
shape; it has no blockers and its unit tests pin the contract the deploy
step and E2E probe consume.

## Fog of war

- Exact shim bundle size (est. ~6MB, core-order) — pinned by measurement in
  t02; if pi-coding-agent's inline pulls asset-dir folds, handle via the
  existing `rewriteAssetImportMetaFolds` machinery (charted, not yet hit).
- Which tools are context-free enough to work standalone (devops git/spawn
  tools: yes; model-backed tools: env-dependent) — t04 picks read-only
  probes; the general contract stays "evaluate + execute, same layer as
  deploy-e2e probes", not "full agent runtime".
- Offline Gate 5's scanner scope (currently `ext.cjs` files) — whether the
  shim needs explicit inclusion is verified in t02, not assumed.

## Cross-effort links

- Shares-decision-with: `2026-08-26-s2agent-crossos-deploy` — both shape
  the dist tree; the shim must stay relocatable under the same Gate 4
  no-build-machine-path contract that effort's launchers uphold.
- Builds-on: `2026-08-28-win32-launcher-stdout` ticket 03's "refresh local
  dist" habit — t05's fresh deploy doubles as the crossos effort's
  standing dist refresh if still pending.
