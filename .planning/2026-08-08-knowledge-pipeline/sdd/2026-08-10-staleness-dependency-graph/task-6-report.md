# Task 6 Report — `stale:` flag + query tool (10-impl T6)

> The "what I actually did + evidence" record. Pairs with `task-6-brief.md`.
>
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED off `a1f833cf`).
> Commit: see "Commit" below.

## What was implemented

One new additive standalone tool (`planning_stale`) + its unit tests + a one-line
registration in `src/index.ts`. The user-facing `stale:` query surface for the
staleness dependency graph:

1. **`registerPlanningStaleTool(pi, { memoryDir }): ToolDefinition`** — the
   `planning_stale` tool (mirrors the `knowledge_search` / `knowledge_ingest` house
   style: `defineTool(...)`, `gating: { core: true }`, typebox `Type.Object`
   params, human-readable `text` + structured `details`). Two actions via a
   required `action` `StringEnum(["query","revalidate"])`:
   - **`query`** — `query` param `"stale"` (all efforts) / `"stale:<effort>"`
     (scoped). Calls `getStaleCards` (T4); returns the stale planning-ticket
     decisions. Each result is stale by construction (δ — the result set IS the
     `stale` flag; `StaleCard.missingDeps` surfaces a vanishing dep).
   - **`revalidate`** — `cardId` param. Calls `refreshStaleness` (T5) to
     re-baseline one decision against its current dep bytes (clearing the stale
     flag) and reports whether it HAD drifted (`{ ok; stale; missing }`).
2. **Pure resolvers** (exported for unit testing without the pi API):
   - `parseStaleQuery(query): { effort? }` — lenient.
   - `runStaleQuery(memoryDir, query, fsRoot): Promise<{ ok; stale: StaleCard[]; error? }>`
     — ephemeral `CardStore` + `getStaleCards` + close.
   - `revalidateCard(memoryDir, cardId, fsRoot): Promise<{ ok; stale; missing; error? }>`
     — ephemeral `CardStore` + `refreshStaleness` + close.

Store-dir access (`memoryDir`) is a closure captured at registration (mirrors
`registerKnowledgeSearchTool`'s `vaultResolver` + `registerKnowledgeIngestTool`'s
`opts.memoryDir`); fsRoot comes from `ctx.cwd` (the 5th `execute` param,
`ExtensionContext.cwd` — the canonical repo-root source inside `execute`, the same
`ctx.cwd` the `session_start`/`schedulePlanningBackfill` handlers read).

## Deviation from the plan's literal T6 code — and why

Two concrete divergences, both driven by the committed T4/T5 primitives (the
plan's T6 code predates the η amendment's read side + the T5 return-type decision):

### #1 — the plan's T6 TEST seed is Path-B-wrong (read deps from source `.md`, not the store row)

The plan's verbatim test does `store.upsertCard(card with graph.relations)` +
`computeStaleness(store, cardId, root)` with **no source `.md` on disk**. That is a
latent bug post-η: `computeStaleness` (T4 / Path B) reads deps from
`readSourceCard(store, id, fsRoot)` — a re-parse of the git-canonical source `.md` —
NOT from `store.getCard(id).graph.relations` (the 06a store does NOT persist
`card.graph`; `rowToCard` emits no `graph`). With no source `.md`,
`readSourceCard` → `null` → `computeStaleness` → `{ stale:false, missing:[] }` +
writes **no** baseline → `getStaleCards` would never flag the card stale; the
"returns the stale card" assertion would fail for the wrong reason (and the
"clean card excluded" half would pass spuriously).

**Fix:** mirror the T4 test's `seedSource` / `writeDep` idiom verbatim
(`src/store/planning-staleness.test.ts`): write a REAL source `.md` under
`<root>/.planning/<effort>/tickets/<no>-<slug>.md` with a `depends_on:` frontmatter
dep + a `cites <path>` body line (so the deserialized card carries the relations),
write BOTH dep files (`v1`), `store.upsertCard` the ticket ROW (id only — the row
needs NO graph; `getStaleCards` enumerates via `getCardsByKind("planning-ticket")`),
then `computeStaleness` to seed the baseline. Drift via `writeFileSync(dep,"v2")`
(changed) or `rmSync(dep)` (vanishing → `missingDeps`).

### #2 — `refreshStaleness` (T5) returns `Promise<boolean>`, not `{stale, missing}`

The plan's verbatim `revalidateCard` does `const { stale, missing } = await
refreshStaleness(store, cardId, fsRoot)`. But the committed T5 `refreshStaleness`
returns `Promise<boolean>` (`wasStale`) — the T5 brief's "Return type:
`Promise<boolean>` (mirrors the sibling `refreshIfStale`)". Destructuring a boolean
yields `stale=undefined, missing=undefined`. **Fix:**

```ts
const wasStale = await refreshStaleness(store, cardId, fsRoot);
return { ok: true, stale: wasStale, missing: [] };
```

This keeps the plan's return SHAPE (`{ ok; stale; missing }` — so the plan's
`revalidateCard` test assertion `r.stale === true` holds AND the tool `execute`'s
`r.missing.length` suffix is safe) while correctly consuming the boolean T5. T5
does not expose `missing`; the query path still surfaces it via
`StaleCard.missingDeps` (from `getStaleCards`). `missing` is returned as `[]`.

> A third, smaller, divergence: the plan's `registerPlanningStaleTool` used a plain
> `const definition: ToolDefinition = {...}` object; this implementation uses
> `defineTool({...})` + imports the shared `ToolRegistrar` from
> `./knowledge-search-tool.js` to mirror the `knowledge_search` / `knowledge_ingest`
> house style EXACTLY (the task's "mirror the house style you read" instruction).
> Functionally identical (`defineTool` is the identity wrapper).

## Files changed (3, +493 insertions)

```
 .../src/index.ts                                  |   6 +++
 .../src/tools/planning-stale-tool.test.ts         | 190 +++++++++++++++++++++
 .../src/tools/planning-stale-tool.ts              | 197 +++++++++++++++++++++
```

### `src/index.ts` — registration (additive; one import + one registration line)

```diff
 import { registerKnowledgeSearchTool } from "./tools/knowledge-search-tool.js";
 import { registerKnowledgeIngestTool } from "./tools/knowledge-ingest-tool.js";
+import { registerPlanningStaleTool } from "./tools/planning-stale-tool.js";
 …
   registerKnowledgeSearchTool(pi, resolveKnowledgeVaultPath);
   registerKnowledgeIngestTool(pi, { memoryDir: globalDir });
+  // Phase-2 (knowledge-pipeline / 10-impl T6): the stale: query + revalidate
+  // tool. Uses the SAME globalDir memory DB the planning mirror + knowledge
+  // ingest use; fsRoot comes from ctx.cwd at call time. Additive — mirrors the
+  // knowledge_* registration pattern.
+  registerPlanningStaleTool(pi, { memoryDir: globalDir });
```

### `src/tools/planning-stale-tool.ts` — the tool object (shape)

```ts
export function registerPlanningStaleTool(
  pi: ToolRegistrar,
  opts: { memoryDir: string },
): ToolDefinition {
  const definition = defineTool({
    name: "planning_stale",
    label: "Planning Stale",
    gating: { core: true },
    description: PLANNING_STALE_DESCRIPTION,
    parameters: Type.Object({
      action: StringEnum(["query", "revalidate"] as const, { description: "…" }),
      query: Type.Optional(Type.String({ description: "…'stale' | 'stale:<effort>'…" })),
      cardId: Type.Optional(Type.String({ description: "…revalidate target…" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      if (params.action === "revalidate") {
        if (!params.cardId) return { content: [{…text:"✗ Missing 'cardId' for revalidate."}], details: { ok:false, error:"missing cardId" } };
        const r = await revalidateCard(opts.memoryDir, params.cardId, cwd);
        const text = r.ok ? `✓ Re-validated ${params.cardId}: ${r.stale ? "had drifted (now re-baselined)" : "was current"}${r.missing.length > 0 ? `; missing deps: ${r.missing.join(", ")}` : ""}.` : `✗ Re-validate failed: ${r.error}`;
        return { content: [{ type: "text", text }], details: r };
      }
      const r = await runStaleQuery(opts.memoryDir, params.query ?? "stale", cwd);
      const text = r.ok ? renderStale(r.stale) : `✗ stale: query failed: ${r.error}`;
      return { content: [{ type: "text", text }], details: r };
    },
  });
  pi.registerTool(definition);
  return definition;
}
```

`revalidateCard`'s deviation #2 (boolean T5 → `{ ok; stale: wasStale; missing: [] }`)
and `runStaleQuery`'s ephemeral-store shape are as specified in the brief. The test
file's `seedSource` / `writeDep` / `seedTicket` helpers mirror the T4 idiom
(deviation #1).

## TDD evidence

- **RED** (`bun test src/tools/planning-stale-tool.test.ts`):
  `error: Cannot find module './planning-stale-tool.js' from
  '…/src/tools/planning-stale-tool.test.ts'` → `0 pass / 1 fail / 1 error` —
  failing for the right reason (the tool module does not exist yet).
- **GREEN** (same command after implementation): `10 pass / 0 fail` — the 4
  `parseStaleQuery` + 3 `runStaleQuery` + 2 `revalidateCard` cases all pass (10 new).

## Full-suite counts

| stage            | pass | skip | fail | notes |
| ---------------- | ---- | ---- | ---- | ----- |
| after-T5 (stated baseline) | 1467 | 1 | 1   | the 1 fail = memworth/numeric-isolation pre-existing |
| after-T6                   | 1477 | 1 | 1   | same 1 skip / 1 known-fail UNCHANGED |

Net delta after-T5 → after-T6: **+10 pass**, 0 change to skip/fail (Ran 1479 tests
across 126 files, was 1469 across 125 — +1 file = the new test file). The +10 are
the T6 cases. The single remaining fail is the unchanged
`numeric isolation — assembled prompt never leaks memworth (UPSP §7 / DO ticket 04)
> formatForSystemPrompt never emits memworth (memory + failure blocks — regression
pin)` — the **exact** test named in the T4/T5 reports, NOT a T6 regression.
`bun run check` (tsc --noEmit) clean.

## Self-review

- **Additive**: a new tool file + a new test file + one import + one registration
  line in `src/index.ts`. No existing tool file touched; no schema change
  (`memories`/`card_md_hash`/`card_dep_hash`); no T4/T5 primitive touched. Existing
  tools still register: the registration block is appended right after
  `registerKnowledgeIngestTool` (the knowledge_* cluster); `knowledge_search` /
  `knowledge_ingest` / `memory_search` / `session_search` / `memory_supersede` /
  `grill_decision` / `skill` / `memory` all stay green (full suite +10, 0 regressions).
- **Store/fsRoot access mirrors the house style EXACTLY**: `opts.memoryDir` closure
  (the `vaultResolver` / `opts.memoryDir` idiom) for the store dir; `ctx.cwd` (the
  5th `execute` param) for fsRoot — no invented access pattern. The pure resolvers
  open an ephemeral `CardStore` per call (hermes holds no long-lived planning
  store — matches the planning mirror / T5 sweep), closed in a `finally`.
- **δ + Path B honored**: the result set IS the `stale` flag (no explicit
  `stale:true` field per card); `getStaleCards` reads deps from `readSourceCard`
  (source `.md` → `graph.relations`), NOT the store row. `revalidateCard` consumes
  the T5 boolean + returns `missing: []` (T5 doesn't expose missing; the query path
  surfaces it via `StaleCard.missingDeps`).
- **Re-baseline is the SOLE re-validate op**: `revalidateCard` calls T5
  `refreshStaleness` (the only re-baseline). The query path (`runStaleQuery` →
  `getStaleCards` → `computeStaleness`) is compare-only (verified by the
  "revalidate clears staleness" test: after revalidate, the subsequent query no
  longer lists the card — proving the flag was cleared by the re-baseline, while the
  query itself never clears anything).

## Concerns / deferred

- **`missing` always `[]` on the revalidate path**: T5 `refreshStaleness` returns
  `Promise<boolean>` (sole re-baseline) and does not expose the current missing
  deps. `revalidateCard` returns `missing: []` to keep the plan's `{ ok; stale;
  missing }` shape the `execute` consumes; the query path surfaces missing via
  `StaleCard.missingDeps`. A richer T5 return (`{ wasStale; missing }`) could carry
  it, but that is a T5 change (out of T6 scope) and T5's brief explicitly chose the
  boolean envelope.
- **Ephemeral store per resolver call**: `runStaleQuery` / `revalidateCard` each
  `createCardStore({ memoryDir })` + `close()`. Sequential (no concurrent-call
  concern); matches the T5 sweep's short-lived-store shape. A future shared-store /
  connection-pool refactor could amortize.
- **No `--self-test`/TUI render test**: the tool's `execute` is exercised only via
  its pure resolvers (the unit tests). The `text`/`details` shaping mirrors
  `knowledge_search`'s proven shape and is low-risk; a live-tool integration test
  (captured registrar → `execute`) would be additive polish, not required by the DoD.

## Commit

```
feat(knowledge-pipeline): stale: query + revalidate tool (10-impl T6)
```
