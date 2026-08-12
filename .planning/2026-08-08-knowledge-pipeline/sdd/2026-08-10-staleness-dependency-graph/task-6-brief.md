# Task 6 Brief — `stale:` flag + query tool (10-impl T6)

> The "what I agreed to build" record. Extracted from the plan's `### Task 6:`
> section, with the **δ standalone-tool** decision + two **pre-implementation
> adjustments** (the plan's T6 test seed idiom + the `refreshStaleness` return
> type) recorded where they diverge from the committed T4/T5 primitives.
>
> Plan: `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-10-staleness-dependency-graph.md` (Task 6 + decision δ).
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED — NOT created/rebased/switched).
> Base SHA: `a1f833cfd1e8541a17d0b44e3946f8d0742e72d4` (the T1+T2+T3+η+T4+T5 tip, already on the branch).

## Scope

T6 is the user-facing `stale:` query surface. One new standalone tool, plus its
unit tests, plus a one-line registration in `src/index.ts`:

1. **`registerPlanningStaleTool(pi, { memoryDir }): ToolDefinition`** — registers
   the `planning_stale` tool (name mirrors the repo convention: `knowledge_search`,
   `knowledge_ingest`, `memory_search`). Two actions via an `action` discriminant:
   - `query` (default path) — `query` param of `"stale"` (all efforts) or
     `"stale:<effort>"` (scope to one effort). Returns the stale planning-ticket
     decisions (closed decisions whose cited/declared source-file deps changed
     since last validation) via `getStaleCards` (T4).
   - `revalidate` — `cardId` param. Re-baselines that one decision against current
     dep bytes via `refreshStaleness` (T5) — the agent re-grill "re-validate" step.
2. **Pure resolvers** (exported for unit testing WITHOUT the pi API):
   - `parseStaleQuery(query): { effort? }` — lenient `"stale" / "" / unknown → {}`,
     `"stale:<effort>" → { effort }`.
   - `runStaleQuery(memoryDir, query, fsRoot): Promise<{ ok; stale: StaleCard[]; error? }>`
     — opens an ephemeral `CardStore`, calls `getStaleCards`, closes.
   - `revalidateCard(memoryDir, cardId, fsRoot): Promise<{ ok; stale; missing; error? }>`
     — opens an ephemeral `CardStore`, calls `refreshStaleness`, closes.

## Decision δ — new standalone tool (NOT extending `@ts-nocheck` memory-tool.ts)

`memory-tool.ts` is `@ts-nocheck` and carries no prefix-query grammar; extending it
would add to an untyped surface. The cleanest additive path is a NEW standalone
tool mirroring the `knowledge_search` / `knowledge_ingest` house style (`gating:
{ core: true }`, typebox `Type.Object` params, a human-readable `text` + structured
`details`, `defineTool(...)`, `pi.registerTool(definition)`). Adopted verbatim.

## Store / fsRoot access — mirrors the existing tools EXACTLY (no new pattern)

- **Store dir (`memoryDir`)** — captured in a **closure at registration**, the same
  way `registerKnowledgeSearchTool` captures `vaultResolver` and
  `registerKnowledgeIngestTool` captures `opts.memoryDir`. The pure resolvers open
  an EPHEMERAL `CardStore` per call via `createCardStore({ memoryDir })` (hermes
  holds no long-lived planning store — the planning mirror uses a short-lived store
  too, see `planning-backfill.ts`). The `memoryDir` passed at registration is
  `globalDir` from `src/index.ts` (the SAME var `createCardStore` /
  `schedulePlanningBackfill` use — confirmed by reading `src/index.ts`).
- **fsRoot (`ctx.cwd`)** — obtained from the `ctx` arg of `execute` (the 5th param,
  `ExtensionContext`, which has `cwd: string` — confirmed in
  `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:217,371`). This
  matches the host's working dir at call time (the same `ctx.cwd`
  `session_start`/`schedulePlanningBackfill` read). No existing *tool* reads
  `ctx.cwd` (they capture everything via closures), but `ctx.cwd` IS the canonical
  fsRoot and is already used by the lifecycle handlers; it is the right source for
  the repo root a `stale:` query must resolve deps against.

> Net: store-dir access mirrors the closure idiom; fsRoot uses the runtime
> `ctx.cwd` (the only repo-root source available inside `execute`). No invented
> pattern.

## Pre-implementation adjustment #1 — the plan's T6 TEST seed is Path-B-wrong

The plan's verbatim T6 test does:

```ts
const staleCard = { id: "planning-ticket:q-eff:01", …
  graph: { relations: [{ s: "…", rel: "depends_on", o: "src/stale.ts" }] } };
await store.upsertCard(staleCard);
await computeStaleness(store, staleCard.id, root);   // ❌ writes NO baseline
```

That seed is a **latent bug** post-η: `computeStaleness` (T4 / Path B) reads the
card's deps from `readSourceCard(store, id, fsRoot)` — a re-parse of the
git-canonical source `.md` — NOT from `store.getCard(id).graph.relations` (the 06a
store does NOT persist `card.graph`; `rowToCard` emits no `graph`). With no source
`.md` on disk, `readSourceCard` returns `null` → `computeStaleness` returns
`{ stale:false, missing:[] }` and writes **no** baseline. So `getStaleCards` would
never flag the card stale; the "returns the stale card" assertion would fail for
the wrong reason (the plan's "clean card excluded" half would pass spuriously).

**Fix:** mirror the T4 test's `seedSource()` idiom verbatim
(`src/store/planning-staleness.test.ts` — `writeDep` + `seedSource`): write a REAL
source `.md` under `<root>/.planning/<effort>/tickets/<no>-<slug>.md` with a
`depends_on:` frontmatter dep + a `cites <path>` body line (so the deserialized
card carries the relations), write BOTH dep files (`v1`), `store.upsertCard` the
ticket ROW (id only — the row needs NO graph; `getStaleCards` enumerates via
`getCardsByKind("planning-ticket")`), then `computeStaleness` to seed the baseline.
Drift by `writeFileSync(dep, "v2")` (changed) or `rmSync(dep)` (vanishing →
`missingDeps`).

## Pre-implementation adjustment #2 — `refreshStaleness` (T5) returns `Promise<boolean>`, not `{stale, missing}`

The plan's verbatim `revalidateCard` does:

```ts
const { stale, missing } = await refreshStaleness(store, cardId, fsRoot);  // ❌
return { ok: true, stale, missing };
```

But the committed T5 `refreshStaleness` returns `Promise<boolean>` (`wasStale`),
NOT `Promise<{ stale, missing }>` — the T5 brief's "Return type: `Promise<boolean>`
(mirrors the sibling `refreshIfStale`)". Destructuring a boolean yields
`stale=undefined, missing=undefined`. **Fix:**

```ts
const wasStale = await refreshStaleness(store, cardId, fsRoot);
return { ok: true, stale: wasStale, missing: [] };
```

This keeps the plan's return SHAPE (`{ ok; stale; missing }` — so the plan's
`revalidateCard` test assertion `r.stale === true` holds AND the tool `execute`'s
`r.missing.length` suffix is safe) while correctly consuming the boolean T5. T5
does not expose `missing` (the sweep already surfaces it via `getStaleCards`); the
re-validate op's job is "clear the flag + report whether it HAD drifted" — a
boolean suffices. `missing` is returned as `[]` (the execute renders it as an
optional empty suffix). The `runStaleQuery` resolver still returns the
`StaleCard[]` (each carrying `missingDeps?` from `getStaleCards`), so missing-dep
info IS surfaced on the query path.

## Tool shape — `defineTool` + `ToolRegistrar` (house style)

Mirrors `knowledge-search-tool.ts` / `knowledge-ingest-tool.ts` exactly:

```ts
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolRegistrar } from "./knowledge-search-tool.js";   // shared narrow type
…
export function registerPlanningStaleTool(pi: ToolRegistrar, opts: { memoryDir: string }): ToolDefinition {
  const definition = defineTool({
    name: "planning_stale",
    label: "Planning Stale",
    gating: { core: true },
    description: …,
    parameters: Type.Object({
      action: StringEnum(["query", "revalidate"] as const),        // required discriminant
      query: Type.Optional(Type.String({ description: "…'stale' | 'stale:<effort>'…" })),
      cardId: Type.Optional(Type.String({ description: "…revalidate target…" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) { … },
  });
  pi.registerTool(definition);
  return definition;
}
```

`action` is a REQUIRED `StringEnum` (matches the house style — `knowledge_search`/
`knowledge_ingest` use required params). The "query is the default" intent is
honoured by `execute`'s control flow (`if (action === "revalidate") …else query`,
with `params.query ?? "stale"` defaulting the query string inside query mode).

## Files

- **Create:** `bun-apps/pi-agent-ext-hermes-memory/src/tools/planning-stale-tool.ts` — the `planning_stale` tool + the three exported pure resolvers (`parseStaleQuery` / `runStaleQuery` / `revalidateCard`).
- **Create:** `bun-apps/pi-agent-ext-hermes-memory/src/tools/planning-stale-tool.test.ts` — co-located with the tool (the plan's placement; matches where `planning-sync-state.test.ts` / `planning-staleness.test.ts` sit).
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/index.ts` — add the import + one `registerPlanningStaleTool(pi, { memoryDir: globalDir });` line next to the other knowledge tools (after `registerKnowledgeIngestTool`).

## Interfaces

- **Consumes:** `getStaleCards` + `StaleCard` from `../store/planning-staleness.js` (T4); `refreshStaleness` from `../store/planning-sync-state.js` (T5 — boolean return); `createCardStore` from `../store/card-store.js`; `ToolRegistrar` from `./knowledge-search-tool.js` (house style). The `δ` "result set IS the `stale` flag" decision is honoured: each returned `StaleCard` is stale by construction (no explicit `stale:true` field — `getStaleCards` only returns stale cards).
- **Produces:**
  - `parseStaleQuery(query): { effort? }`.
  - `runStaleQuery(memoryDir, query, fsRoot): Promise<{ ok; stale: StaleCard[]; error? }>` — ephemeral store; `getStaleCards(store, parseStaleQuery(query).effort, fsRoot)`; close in `finally`.
  - `revalidateCard(memoryDir, cardId, fsRoot): Promise<{ ok; stale: boolean; missing: string[]; error? }>` — ephemeral store; `wasStale = refreshStaleness(store, cardId, fsRoot)`; `missing: []`; close in `finally`.
  - `registerPlanningStaleTool(pi, { memoryDir }): ToolDefinition`.

## Test setup (RED → GREEN)

Co-located `src/tools/planning-stale-tool.test.ts`, using `node:test` + the T4
`seedSource`/`writeDep` idiom (real source `.md` + real dep files, fresh temp
`root`+`mem` per case). Cases:

1. **`parseStaleQuery`** — `"stale" → {}`; `"stale:e" → {effort:"e"}`; unknown / `"" → {}` (the plan's 4 pure cases).
2. **`runStaleQuery` query (no effort)** — seed `q-eff:01` (drift) + `q-eff:02` (clean); drift `01`; `runStaleQuery(mem, "stale", root)` includes `01` (with `stale` implied by presence), excludes `02`.
3. **`runStaleQuery` effort filter** — seed `q-eff:01` (drift) + `q-eff2:03` (drift); `runStaleQuery(mem, "stale:q-eff", root)` returns ONLY `q-eff:01`. An empty effort `"stale:nope-eff"` → `[]`.
4. **`runStaleQuery` missing dep** — seed `q-eff:04` (`depends_on src/gone.ts`); baseline; `rmSync(src/gone.ts)`; `runStaleQuery` surfaces `04` with `missingDeps: ["src/gone.ts"]`.
5. **`revalidateCard` on a stale card** — seed + drift `q-eff:01`; `revalidateCard(mem, id, root)` → `{ ok:true, stale:true }`; a subsequent `runStaleQuery(mem, "stale:q-eff", root)` no longer lists it (re-baseline cleared the flag).
6. **`revalidateCard` on a non-stale (current) card** — seed `q-eff:05` (no drift, baseline current); `revalidateCard` → `{ ok:true, stale:false }`.

## DoD

`stale:` returns only stale cards; `stale:<effort>` filters (clean effort → empty);
a vanishing dep surfaces `missingDeps`; `revalidate` on a stale card returns
`{ok, stale:true}` AND clears the flag (a subsequent query no longer lists it);
`revalidate` on a current card returns `{ok, stale:false}`; the tool is registered
in `src/index.ts` alongside the knowledge tools; existing tools
(`knowledge_search` / `knowledge_ingest` / `memory_search` / …) register + behave
unchanged (the registration is additive); full suite green except the known
memworth/numeric-isolation pre-existing fail (1467 + new tests pass / 1 skip / 1 fail).
