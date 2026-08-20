# Extension Dependency Tree — PRD

> Architecture baseline of the `bun-apps/s2-agent-ext-*` extension graph.
> Captured 2026-07-25 as a reference map for future large changes to the pi
> extension set (adds/removes/merges, dependency cuts, registration reshuffles).
>
> Companion to (and does not duplicate):
> - [`PRD.md`](../PRD.md) — product-level overview + deploy modes
> - [`extension-registry.PRD.md`](extension-registry.PRD.md) — *how* extensions
>   physically load at runtime (jiti / Bun resolution / `ensure-extension-deps`)
>
> This doc answers **what depends on what**; the registry doc answers **how a
> given extension resolves its deps at load time**.

## 1. Purpose

Before making a big change to the extension set — splitting, merging, deleting
a package, or cutting a dependency — consult this tree to see the blast
radius: which other extensions (or the two aggregators) transitively pull a
package in, and via which registration layer (static import vs dynamic `-e`).

**Scope:** the 21 `s2-agent-ext-*` workspace members + the aggregators. The
`gui-movie-director` and `perf-harness` packages have no workspace edges into
the extension graph and are out of scope.

> **Amended 2026-08-12 (s2-agent-cli merge).** This tree was surveyed while
> there were **two** aggregators. `s2-agent-cli` was merged into `s2-agent`
> (its source is now `s2-agent/src/cli/**`) and deleted, so there is exactly
> **one** aggregator today and the two dependency sets below have been unioned
> into `s2-agent`'s `package.json`. The two-aggregator diagram and the
> `s2-agent-cli` subsection are retained as the 2026-07-25 baseline they
> document; read them as history, not as current layout.

## 2. The host layer (provided, never bundled per-extension)

Every extension treats these as **peerDependencies** — the host provides one
shared instance. Bundling a private copy (notably of `typebox`, which drags
~6.5 MB of `@babel/*`) is forbidden; see `extension-registry.PRD.md` §3.

| Package | Pinned | Role |
|---------|--------|------|
| `@earendil-works/pi-coding-agent` | `0.82.0` | Official pi runtime / TUI host |
| `@earendil-works/pi-ai` | `0.82.0` | AI primitives (models, providers) |
| `@earendil-works/pi-agent-core` | `0.82.0` | Agent core (sessions, tools) |
| `@earendil-works/pi-tui` | `0.82.0` | TUI widget primitives |
| `typebox` | `*` (peer) / `^1.3.x` (dev) | Schema/typed-JSON for tool shapes |

These five are exactly what the `ensure-extension-deps` patch symlinks into
the repo-root `node_modules/` in source mode so jiti's `try-native` succeeds.

## 3. Inter-package workspace DAG

Workspace (`workspace:*`) edges only. `→` = `dependencies`; `⇢` = a
*workspace peer* declared in `peerDependencies` (resolved by the host
aggregator, not a hard install edge).

```
                          (aggregators)
            ┌──────────────────┴───────────────────┐
         s2-agent                            s2-agent-cli
   (TUI wrapper,                       (merged INTO s2-agent 2026-08-12;
    static+manifest)                    was: deps 12 ext pkgs + s2-agent)
        │  │  │  │  │                         │
   (see §5 for the full static             (pulls a broad set for
    + manifest registration union)          the standalone CLI bundle)
        │
        ▼  (workspace dependency edges)
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │  movie-director ──► flux2 ──► file2md                       │
  │       │  │  └────► krea2                                    │
  │       │  └──────► ltx                                       │
  │       └─────────► workflow ──► subagent                     │
  │                                                             │
  │  wayfind ──► ext-task                                      │
  │                                                             │
  │  knowledge-card ⇢ obsidian, ⇢ subagent   (peer)             │
  │  hermes-memory ⇢ subagent                 (peer)            │
  │                                                             │
  │  (leaf packages — no workspace edges)                       │
  │  archify  btw  deploy  obsidian  power-tool  research-tool  │
  │  superpowers  tool-gate  web-access  zai-mcp                │
  └─────────────────────────────────────────────────────────────┘
```

**Edge list (exhaustive):**

| From | → dep | Type |
|------|-------|------|
| `s2-agent-ext-flux2` | `s2-agent-ext-file2md` | `dependencies` |
| `s2-agent-ext-movie-director` | `s2-agent-ext-flux2` | `dependencies` |
| `s2-agent-ext-movie-director` | `s2-agent-ext-krea2` | `dependencies` |
| `s2-agent-ext-movie-director` | `s2-agent-ext-ltx` | `dependencies` |
| `s2-agent-ext-movie-director` | `s2-agent-ext-workflow` | `dependencies` |
| `s2-agent-ext-workflow` | `s2-agent-ext-subagent` | `dependencies` |
| `s2-agent-ext-wayfind` | `s2-agent-ext-task` | `dependencies` |
| `s2-agent-ext-knowledge-card` | `s2-agent-ext-obsidian` | `peerDependencies` |
| `s2-agent-ext-knowledge-card` | `s2-agent-ext-subagent` | `peerDependencies` |
| `s2-agent-ext-hermes-memory` | `s2-agent-ext-subagent` | `peerDependencies` |

**Deepest chain:** `movie-director → workflow → subagent` (depth 3, plus
`flux2 → file2md` as a side branch off movie-director). Nothing is cyclic.

**Implication for big changes:** deleting or renaming `subagent`, `file2md`,
`ext-task`, or `workflow` has the widest blast radius — each is consumed by
at least one other extension, not just by the aggregators.

## 4. Per-extension manifest

Registration entry is always `extensions/<name>.ts`. Three packages
(`power-tool`, `hermes-memory`, `web-access`) keep their implementation at
`src/index.ts` / root `index.ts` (their `main`) and expose a 1-line re-export
shim at `extensions/<name>.ts` as the uniform registered entry.

**Legend** — `ws-deps` = workspace `dependencies`; `ext-deps` = external
runtime `dependencies`; `peers` = `peerDependencies` (host-provided).

| Extension | ws-deps | ext-deps | peers | Reg | Entry |
|-----------|---------|----------|-------|-----|-------|
| `archify` | — | — | ai, pca, tui, typebox | DYN | `extensions/archify.ts` (vendored archify@2.12.0) |
| `btw` | — | — | ai, pca, tui | STA | `extensions/btw.ts` |
| `ext-task` | — | — | pca, tui, typebox | STA | `extensions/task.ts` |
| `deploy` | — | — | pca, typebox | DYN | `extensions/deploy.ts` |
| `file2md` | — | — | ai, core, pca, tui, typebox | STA | `extensions/file2md.ts` (shim → `src/index.ts`) |
| `flux2` | file2md | pi-ai, pi-agent-core | pca, typebox | DYN | `extensions/flux2.ts` |
| `hermes-memory` | — | pi-tui, proper-lockfile | ai, pca, ⇢subagent | STA | `extensions/hermes-memory.ts` (shim → `src/index.ts`) |
| `knowledge-card` | — | — | ai, core, pca, tui, typebox, ⇢obsidian, ⇢subagent | STA | `extensions/knowledge-card.ts` |
| `krea2` | — | pi-ai, pi-agent-core | pca, typebox | DYN | `extensions/krea2.ts` |
| `ltx` | — | pi-coding-agent, typebox ⚠ | pca, typebox | DYN | `extensions/ltx.ts` |
| `movie-director` | flux2, krea2, ltx, workflow | pi-ai, pca, ajv, ajv-formats, msedge-tts, typebox, yaml | pca, typebox | DYN | `extensions/movie-director.ts` |
| `obsidian` | — | — | ai, core, pca, tui, typebox | STA | `extensions/obsidian.ts` |
| `power-tool` | — | pca, pi-tui, @playwright/cli, js-yaml, typebox | — | STA | `extensions/power-tool.ts` (shim → `src/index.ts`) |
| `research-tool` | — | fast-xml-parser | ai, pca, tui, typebox | DYN | `extensions/research-tool.ts` |
| `subagent` | — | — | pca, tui, typebox | STA | `extensions/subagent.ts` |
| `superpowers` | — | — | pca | STA | `extensions/superpowers.ts` |
| `tool-gate` | — | — | pca, typebox | DYN | `extensions/tool-gate.ts` |
| `wayfind` | ext-task | — | pca | STA | `extensions/wayfind.ts` |
| `web-access` | — | @mozilla/readability, linkedom, p-limit, turndown, unpdf | ai, pca, tui, typebox | STA | `extensions/web-access.ts` (shim → root `index.ts`) |
| `workflow` | subagent | acorn | pca, tui, typebox | STA | `extensions/workflow.ts` |
| `zai-mcp` | — | @modelcontextprotocol/sdk | ai, core, pca, tui, typebox | DYN | `extensions/zai-mcp.ts` |

Abbreviations: `ai`=pi-ai · `pca`=pi-coding-agent · `core`=pi-agent-core · `tui`=pi-tui.
`Reg`: **STA** = static import (`static-extensions.ts`); **DYN** = dynamic `-e`
(`run-dir/manifest.json` `extensions[]`). See §5.

## 5. The two registration layers

Extensions enter the runtime through **one of two** channels — never both
(double-registration bug; see `static-extensions.ts` header). The split is the
single most important fact for planning a change, because it determines
whether a package survives the `--exe` single-binary build.

### 5a. Static — `s2-agent/src/static-extensions.ts`

Native `import` of the factory, added to `MainOptions.extensionFactories` in
**every** mode (source / bundle / **binary**). Required for the compiled
single-exe because a literal `import` is inlined by Bun's bundler; dynamic
`.ts` paths do not exist in the `$bunfs` virtual FS.

The static set, in load order (the list below is illustrative — the
authoritative set is `run-dir/manifest.json` → `staticExtensions`, pinned
against the code by `run-dir/manifest-consistency.test.ts`):

```
Group A (original general-productivity set):
  ext-task → hermes-memory → superpowers → wayfind → web-access
Group B (migrated from dynamic -e so the exe build bundles them):
  obsidian → btw → file2md → subagent → workflow → knowledge-card → power-tool
```

**Load-order constraint:** `subagent` MUST load before `workflow` — workflow's
`/subagents` viewer reads subagent's populated registry.

### 5b. Dynamic — `s2-agent/run-dir/manifest.json` `extensions[]`

jiti `-e` loaded, thin-bundled at deploy. Works in source + bundle mode;
**emits zero `-e` flags in `--exe` mode** (the `.ts` paths are absent from the
compiled binary). 9 extensions:

```
tool-gate, flux2, krea2, ltx, research-tool, zai-mcp,
movie-director, deploy, archify
```

These are the MLX media pipeline (flux2/krea2/ltx/movie-director), the
research/external-API tools (research-tool/zai-mcp), the diagram tool
(archify), the build/verify tool (deploy), and the token gate (tool-gate).

### 5c. Skills + binarySkills (also in manifest.json)

- `skills[]` (7): obsidian, research-tool, wayfind, hermes-memory,
  superpowers, web-access, archify — skill dirs shipped to the agent.
- `binarySkills[]` (4): hermes-memory, superpowers, wayfind, web-access —
  skill trees embedded into the compiled binary (CSO bootstrap assets).

### 5d. Registration totals

| Layer | Count |
|-------|-------|
| Static (`static-extensions.ts`) | 12 |
| Dynamic (`manifest.extensions[]`) | 9 |
| **Total registered** | **21** (= all `s2-agent-ext-*` packages) |

Every extension package is registered exactly once across the two layers.

## 6. The aggregators

### `s2-agent` (TUI wrapper)

`dependencies` declares only **5** workspace members — `ext-task`,
`hermes-memory`, `superpowers`, `wayfind`, `web-access` — but these are NOT
how extensions are discovered (they are imported via **relative** paths in
`static-extensions.ts`, not the `@repo/*` specifiers, so they do not appear as
`import "@repo/..."`). The real extension set is the **union of
static-extensions.ts (12) + manifest.extensions[] (9) = 21**. The 5 declared
deps exist so `bun install` symlinks them and so the deploy/bundler resolves
the workspace; they are a subset, not the source of truth.

### `s2-agent-cli` (standalone CLI build target) — *merged away 2026-08-12*

> Historical. These 12 edges were folded into `s2-agent`'s own `dependencies`
> when the package was merged; there is no separate standalone CLI bundle.

`dependencies` declares **12** workspace members — `s2-agent`, `workflow`,
`flux2`, `krea2`, `ltx`, `movie-director`, `power-tool`, `research-tool`,
`web-access`, `knowledge-card`, `obsidian`, `file2md` — plus the host
`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `typebox`. This pulls the broad
extension set into the CLI's standalone bundle. The `postinstall` hook
best-effort-builds `s2-agent-ext-workflow`'s dist if missing.

## 7. Observed debt (pre-simplification baseline, 2026-07-25)

Documented as current-state observations for future cleanup. **Not yet
actioned** — see the simplification spec for the plan.

- **deps ∩ peerDependencies redundancy** — `s2-agent-ext-ltx` and
  `s2-agent-ext-movie-director` list `@earendil-works/pi-coding-agent` and
  `typebox` in **both** `dependencies` and `peerDependencies`. Sibling
  packages (flux2, krea2, archify, btw, …) keep these as peers only. The
  `dependencies` entries are redundant.
- **Declared-but-unimported host deps** (verified: no `import` of the
  specifier in source) — candidates to drop or demote to peer:
  - `flux2` → `@earendil-works/pi-agent-core`
  - `krea2` → `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`
  - `movie-director` → `@earendil-works/pi-ai`
  - `power-tool` → `@earendil-works/pi-tui`
- **`s2-agent` `dependencies` under-declares** the true extension set (5 of
  21). Functionally fine (relative imports resolve the rest via workspace
  symlinks), but a static dep audit of `package.json` alone understates the
  real surface.

> Each candidate above must be re-verified by running the package's own tests
> + `bun install` + the `extension-contract.test.ts` load check before
> removal — type-only / indirect imports are easy to miss by grep.

## 8. How to use this doc

- **Adding an extension** → create `s2-agent-ext-<x>/`, pick STA or DYN
  (binary-survival decides), add the edge to §3, a row to §4, and a slot in
  §5. Follow `extension-registry.PRD.md` §4 for the authoring checklist.
- **Removing / merging an extension** → check §3 for inbound edges (is it a
  `ws-dep` or `peer` of another package?), check §6 (is it in an aggregator's
  declared deps?), then update §5 registration counts (12/9/21).
- **Cutting a dependency** → check §4's `ext-deps`/`peers` columns; if it is
  a host peer, every consumer shares one instance — cutting it affects all.

## 9. wayfind ↔ superpowers boundary

The two methodology packages are **parallel, non-connecting pipelines**
(ADR-0005), not a chain. They share the `.planning/<effort>/` layout but no
flow — and no code edge (neither imports the other; no skill/command name
conflicts). See `s2-agent-ext-superpowers/docs/adr/0005-parallel-coexistence-boundary.md`
for the full decision record.

| | **wayfind** (decide-phase) | **superpowers** (plan/execute-phase) |
|---|---|---|
| Pipeline | `grilling`/`wayfinder → to-spec → to-tickets → /wayfind seed → ext-task coordinator` | `brainstorming → writing-plans → executing` |
| Driver | command-driven (`/grill`, `/wayfind`) + `globalThis.__piWayfindGrill` seam | skill-driven, **zero commands, zero globals** |
| Runtime deps | `{ext-task}` (workspace) | `{}` |
| peerDeps | `pi-coding-agent` | `pi-coding-agent` |
| devDeps | biome, pi-coding-agent, @types/bun, tsx, typescript | biome, pi-coding-agent, @types/bun, tsx, typescript |

**Entry-path routing.** The discriminator for which pipeline to enter is
*can I write a plan right now from what's already settled?* Yes → Superpowers;
no → Wayfind (`wayfinder` if huge/multi-session, else `grilling`). Expressed
at the injection layer (`using-superpowers` bootstrap `piBoundaryOverrides()`),
never by patching verbatim skill bodies (ADR-0004).

**Spec-output ownership (the one overlap).** Both `to-spec` (wayfind) and
`brainstorming` (superpowers) produce a spec. They are **separate entry paths**,
not a shared artifact: when a Wayfind decide-phase has settled the decisions,
`brainstorming` defers to `to-spec`. Both converge on `.planning/<effort>/spec.md`.

**Dev vs runtime dependency split (already correct in both packages).**
`peerDependencies` = the runtime host contract (host provides one shared
`pi-coding-agent`); `devDependencies` = build/lint tooling **plus** the peer
re-declared for local typecheck. Neither package carries any third-party
**runtime** dependency — they are pure-skill packages.

**`.planning/` unification map (no `.superpowers/` exception).** Every artifact
home converges under `.planning/<effort>/`:

| Artifact | Home |
|---|---|
| spec | `.planning/<effort>/spec.md` |
| plan | `.planning/<effort>/plan.md` |
| tickets / map | `.planning/<effort>/tickets/`, `map.md` |
| SDD briefs/reports/reviews | `.planning/<effort>/sdd/{briefs,reports,reviews}/` (committed) |
| SDD progress ledger | `.planning/<effort>/sdd/progress.md` (transient) |
| brainstorm mockups | `.planning/<effort>/brainstorm/` (transient) |

The convergence is driven by `PI_PLANNING_EFFORT=<effort>`: export it before
running the SDD helper scripts (`sdd-workspace`, `task-brief`, `review-package`)
or the brainstorm server (`start-server.sh`) and they resolve under
`.planning/<effort>/`. With no effort they fall back to the upstream
`.superpowers/` paths (backward-compatible; gitignored). The bootstrap rules 1,
3, 4 in `src/superpowers.ts` instruct the agent accordingly; rule 2 is the
entry-path routing discriminator.
