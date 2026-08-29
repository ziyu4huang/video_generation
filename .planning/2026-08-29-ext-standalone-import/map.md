---
effort: 2026-08-29-ext-standalone-import
created: 2026-08-29
last: 2026-08-29 (ticket 02 closed — shim build step + gates shipped; D8 recorded; 6.11MB measured)
status: active
---

# Wayfinder map: 2026-08-29-ext-standalone-import

## Destination

Any external bun script — a claude-code session, a scratch `/tmp` probe, a
cron job on another machine — can `require()` the deployed
`<dist>/ext/ext-standalone.mjs` and drive the shipped extensions' tools
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
  (`<outRoot>/.cores/`), retention keep-5; the shim measured **6.11 MB**
  (t02, bun build --target=bun --minify of standalone.ts, 2517 modules) —
  core-order as estimated, +6.11 MB per version dir, cache-hit after first
  build.

## Tickets

**Execution order:** 01 → 02 → (03 ∥ 04) → 05 — 01→02→{03,04} forced by
`blocking:` edges; 03 and 04 are parallelizable after 02 (03 chosen first:
the AGENTS.md documents what 04's probe then proves end-to-end); 05 closes.
Confirmed 2026-08-29.

| Ticket | Status | Summary |
|---|---|---|
| `tickets/01-shim-entry.md` | closed | `standalone.ts` + 12 contract tests green; s2-agent full suite 989 pass/0 fail; D4 amended (ESM `.mjs`, `import.meta.dir` self-location) |
| `tickets/02-deploy-build-step.md` | closed | `lib/standalone-shim.ts` wired into run.ts; 6.11MB, .cores cache hit on 2nd build; gates s1b/s4/s2 (s1 dropped per D8); deploy.json + Gate 5 record; 8 unit tests + pkg suite 999/0 |
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
  shim bundle** at `ext/ext-standalone.mjs` (8 host modules inlined),
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
- D8 (2026-08-29, measured during t02): the shim's static-specifier gate is
  DROPPED — a regex scan over a bundle that inlines pi-coding-agent drowns in
  string-literal false positives (`'import … from "typebox/schema"'` doc
  templates, "undici" in error strings); the s2 import probe is the stronger
  proof (it resolves every static import for real from the staged tree, where
  no node_modules exists). Dynamic imports stay gated (s1b) with an
  allow-list of Bun's native compat modules (`node-fetch`/`ws`/`undici` —
  all measured resolving from an EMPTY dir under bare bun, 2026-08-29).
  s4 uses Gate 5b's `scanBinaryForeignPaths` + the bun install-cache
  allowlist: the production core ships the same inert
  `var __dirname="~/.bun/install/cache/…/photon-node"` fold and passes the
  same way — the shim must not be held stricter than the core on identical
  bytes. Same reasoning precedent as the core: it is not specifier-gated
  either.

## Frontier

`tickets/02-deploy-build-step.md` — the entry and its contract tests are in; the deploy build step turns them into a shipped, gated dist artifact every later ticket consumes. Everything else builds on the entry's export
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
