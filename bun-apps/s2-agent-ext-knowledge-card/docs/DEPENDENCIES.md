# pi-knowledge-card — Cross-Package Dependencies

> Snapshot: 2026-07-07. The dependency graph that matters for this package:
> what it **needs** (forward) and what **needs it** (reverse). All cross-package
> links are Bun workspace (`workspace:*`) unless noted.

## At a glance

```
                 ┌──────────────────────────────────────────────────────┐
                 │                     FORWARD (needs)                    │
                 │   pi-knowledge-card ──► pi-obsidian (peer, hard)      │
                 │                    └─► @earendil-works/* SDK (peers)   │
                 │                    └─► typebox (peer)                  │
                 └──────────────────────────────────────────────────────┘
                 ┌──────────────────────────────────────────────────────┐
                 │                    REVERSE (needed by)                │
  s2-agent     ──┤                                                      │
                 ├─► pi-knowledge-card                                  │
  pi-hermes-     ├─►   (workspace:* — hard, build-time)                  │
  memory ────────┤    (optional peer + workspace devDep — soft, runtime)│
                 └──────────────────────────────────────────────────────┘
```

> **2 consumers** (was 3 before the consolidation cycle, 2026-07-07).
> `s2-agent-ext-power-tool` used to import `retrieveRecords` / `graphHealth` /
> `healGraph` for its `knowledge_query` + `graph_health` tools — those tools
> were **moved into this package** (the hub owns its tools) and power-tool's
> `pi-knowledge-card` dependency was deleted. See PR-HISTORY.md.

## FORWARD — what pi-knowledge-card imports

Declared in `package.json` `peerDependencies` (this package ships no runtime
deps; everything is a peer so consumers pin versions):

| Dependency | Kind | Used for |
| ---------- | ---- | -------- |
| **`pi-obsidian`** | peer (workspace:*) | **The hard dependency.** `parseFrontmatter`, `validateZettelNote`, `ZETTEL_MAX_BYTES`, `getIndex`, `graphDeadLinks`/`graphOrphans`, `invalidateCache`, `runSubagentWithRetry` (the subagent runner the tools spawn), **and `resolveVault`** (the multi-tier vault resolver every tool uses to find the convergence vault: env → config → app → local). Without pi-obsidian the subagents have nothing to call, the deterministic lib can't parse/validate cards, **and no tool can resolve the vault.** |
| `@earendil-works/pi-coding-agent` | peer | `ExtensionAPI` type (the `pi` registration handle), `Type` (typebox re-export in some consumers). |
| `@earendil-works/pi-ai` · `pi-agent-core` · `pi-tui` | peer | SDK surface the extension/tool registration touches transitively. |
| `typebox` | peer | `Type.Object(...)` schema definitions for tool parameters. |

Actual import sites in the package:

```ts
// src/ingest.ts, src/retrieve.ts
import { parseFrontmatter, validateZettelNote, ZETTEL_MAX_BYTES, ... } from "pi-obsidian/extensions/obsidian.ts";
// extensions/knowledge-card.ts
import { runSubagentWithRetry, resolveVault } from "pi-obsidian/...";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

> **The pi-obsidian boundary is load-bearing.** This package does NOT parse
> Obsidian markdown itself — it delegates to pi-obsidian's `parseFrontmatter`,
> and it does NOT resolve the vault itself either — every tool delegates to
> pi-obsidian's `resolveVault(cwd)` (the hub asks its forward-dep to serve vault
> resolution, not roll its own; this reads the run-dir `obsidian_config.json`
> the no-LLM tools need). A schema change in pi-obsidian's frontmatter parser
> would ripple here. The `allowlists.test.mjs` cross-package guard catches
> tool-name drift; the parser contract is guarded by ingest/retrieve tests
> against real temp vaults. See
> [`../../s2-agent-ext-obsidian/docs/KNOWLEDGE-LAYER.md`](../../s2-agent-ext-obsidian/docs/KNOWLEDGE-LAYER.md)
> for the parser-contract surface this package depends on.

## REVERSE — who imports pi-knowledge-card

Three consumers, two coupling strengths:

### 1. `s2-agent` (the `cli` subcommand tree) — hard, build-time (`workspace:*`)

The CLI shells. Each `zk-*` command imports the task builders / library directly:

| CLI command | Imports from `pi-knowledge-card/...` |
| ----------- | ------------------------------------- |
| `zk-ask.ts` | `buildRagTask`, `ragToolsFor`, `BlendMode` ← `extensions/knowledge-card.ts` |
| `zk-card.ts` | `buildAddTask` / `buildFindTask` / … ← `extensions/knowledge-card.ts` |
| `zk-extract.ts` | `buildDistillTask` + `DISTILL_TOOLS` ← `extensions/knowledge-card.ts` |
| `zk-ingest.ts` | `ingestRecords`, `parseKnowledgeJsonl`, `adaptAutoMemoryMarkdown`, `formatSummary` ← `src/ingest.ts` |
| `zk-query.ts` | `retrieveRecords`, `formatDigest`(implicit), `graphHealth`, `formatHealth`, `mergeDuplicates`, `formatMerge` ← `src/retrieve.ts` + `src/merge.ts` |

**Contract:** the CLI is a thin shell — all logic lives in pi-knowledge-card.
Renaming an exported builder breaks the CLI at build time (caught by
`bun test` in s2-agent, 248 tests). See
the INVARIANT header comment in [`../../s2-agent/src/cli/commands/zk-ask.ts`](../../s2-agent/src/cli/commands/zk-ask.ts).

### 2. `pi-hermes-memory` — SOFT, runtime (`optional peer`)

This is the **intentionally loose** coupling and the one most worth
understanding. See
[`../../s2-agent-ext-hermes-memory/docs/KNOWLEDGE-LAYER.md`](../../s2-agent-ext-hermes-memory/docs/KNOWLEDGE-LAYER.md)
for the full optional-peer + dynamic-import story.

```jsonc
// bun-apps/pi-hermes-memory/package.json
"peerDependencies":      { "pi-knowledge-card": "*" },          // any version
"peerDependenciesMeta":  { "pi-knowledge-card": { "optional": true } },
"devDependencies":       { "pi-knowledge-card": "workspace:*" } // local for dev/test
```

- **Published contract:** pi-knowledge-card is an *optional* peer (`*`, not
  `workspace:*`) — hermes must run fine without it installed.
- **Runtime use:** `src/store/vault-converge.ts` does a **dynamic `import()`**
  of `pi-knowledge-card/src/ingest.ts` inside a try/catch. If the import throws
  (package absent), converge returns `{ ok: false, reason: "pi-knowledge-card /
  pi-obsidian not installed; use the archive file + zk_ingest handoff" }` —
  hermes degrades to writing an archive file instead of converging into the
  graph. **This graceful degradation is by design** (hermes is publishable
  standalone; the knowledge graph is an enhancement, not a requirement).

> Why `*` and not `workspace:*` in peerDependencies? Because hermes is published
> to npm; `workspace:*` would be meaningless off-repo. The loose `*` + optional
> flag is the canonical "enhancement if present" pattern. This is NOT a
> version-drift hazard — `devDependencies: workspace:*` pins the local copy for
> repo dev/test.

## Coupling-strength summary

| Consumer | Link | Breakage mode | Caught by |
| -------- | ---- | ------------- | --------- |
| s2-agent | `workspace:*` (static import) | build-time type/resolution error | `bun test` (248) |
| pi-hermes-memory | optional peer (dynamic `import()`) | runtime graceful degradation (no break) | converge returns `unavailable` |
| **(this) → pi-obsidian** | `workspace:*` peer (static import) | build-time / parser-contract drift | ingest/retrieve tests + `allowlists.test.mjs` |

> **Was 3 consumers.** `s2-agent-ext-power-tool` was removed in the
> consolidation cycle (its `knowledge_query` + `graph_health` tools moved here);
> power-tool is no longer a consumer.

## Cross-links (the knowledge layer is documented symmetrically)

Every package in the knowledge layer carries a `docs/KNOWLEDGE-LAYER.md`
describing **its own** role + coupling, all linking back here:

- [`../../s2-agent-ext-obsidian/docs/KNOWLEDGE-LAYER.md`](../../s2-agent-ext-obsidian/docs/KNOWLEDGE-LAYER.md) — the HARD forward dep (parser + subagent contracts)
- [`../../s2-agent/src/cli/commands/zk-ask.ts`](../../s2-agent/src/cli/commands/zk-ask.ts) — the 5 `zk-*` thin shells (INVARIANT header comment; the package keeps no KNOWLEDGE-LAYER.md)
- [`../../s2-agent-ext-hermes-memory/docs/KNOWLEDGE-LAYER.md`](../../s2-agent-ext-hermes-memory/docs/KNOWLEDGE-LAYER.md) — the SOFT optional-peer edge

When you change a coupling, update the affected `KNOWLEDGE-LAYER.md` AND this
file in the same PR — the symmetry is the contract.

## What this means for changes

- **Renaming an export** → breaks the s2-agent CLI at build time (good: loud,
  caught in `bun test`). Update all consumers in the same PR.
- **Adding an additive field** (e.g. P1's `hasCallouts` on `RetrievedCard`) →
  safe; consumers reading specific fields are unaffected.
- **Changing pi-obsidian's parser contract** → ripples here silently unless
  ingest/retrieve tests catch it (they do, against real vaults).
- **Removing pi-knowledge-card from a consumer** → only hermes tolerates it
  (by design). The CLI requires it.
