# Effort-query Phase 1 (list + search) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ticket:** `.planning/2026-08-08-knowledge-pipeline/tickets/15-effort-query-phase1-list-search.md` (status: open; grill accepted 2026-08-09).

**Goal:** Add read-only `list` and `search` actions to the `wayfind_effort` tool so the agent can enumerate efforts and find tickets/decisions across `.planning/` by keyword — dependency-free, no card-store/embed/sync.

**Architecture:** A new pure module `src/effort-query.ts` holds `listEfforts(cwd)` and `searchEfforts(cwd, query, opts)`, both cwd-based and throw-free (return `{ ok, error? }`). They reuse existing parsers `readMap` / `readEffortMeta` (no re-parsing — use `map.tickets`). `effort-tool.ts` grows two action cases + renderers; the `effort` parameter becomes optional (list ignores it; search treats it as an optional filter). All scoring is in-memory term-frequency with field-weight boosts.

**Tech Stack:** TypeScript (strict, NodeNext), Bun runtime + `bun test`, TypeBox (`@sinclair/typebox`) for the tool schema, real-filesystem tests via `mkdtempSync` sandboxes.

## Global Constraints
- **Package:** `bun-apps/pi-agent-ext-wayfind`. Typecheck gate = `bun run build` (tsc strict; there is NO `typecheck` script in package.json). Lint = `bun run check` (biome). Unit tests = `bun test`. Each task's DoD: `( cd bun-apps/pi-agent-ext-wayfind && bun run build && bun test && bun run check )` green for touched files.
- **Read-only:** Phase 1 never writes to `.planning`. Verified by a read-only invariant test (Task 4).
- **Throw-free:** all new functions return `{ ok: boolean; error?: string }`-shaped results; never throw.
- **No new deps.** Reuse `readMap`, `readEffortMeta`, `parseTicketFile` (already exported). Do not re-parse tickets that `readMap` already parsed (use `map.tickets`).
- **ctx.cwd** is the repo root passed by the tool runtime.
- **Phase 1 scope only.** No card-store, no embed, no DB sync, no CRUD, no staleness graph (those are Phase 2 — tickets 08/09/10).
- CI is disabled in this repo; verify locally. Shell discipline: never top-level `cd` — use `( cd <dir> && ... )`.

## Spec (load-bearing quotes from ticket 15)
- Goal: "Deliver a lightweight, dependency-free effort-query capability: cross-effort `list` + `search` over `.planning/`, answering 'what efforts exist' and 'find tickets/decisions about X across efforts.' Read-only; no card-store, no embed, no sync."
- Design 1 (Surface): "extend `wayfind_effort` with `list` + `search` actions (`effort` param optional for these)."
- Design 2 (Search ranking): "in-memory scored keyword match (term-frequency + frontmatter boost: title/tags/Resolution weighted higher). No DB, no embed."
- Design 3 (Content scope): "tickets (frontmatter + body, incl. closed-ticket Resolution/Decisions) + map.md (Destination, Decisions-so-far, Notes). Decisions queryable."
- Design 4 (Output): "`search`: ranked top-K {effort, ticket-id, title, status, type, snippet, score} with filters --effort/--status/--type. `list`: per-effort {slug, status, ticket-counts, frontier-size, fog, last-modified}."
- Design 5 (Read-only): "Phase 1 never writes; git canonical."
- Verification: `list` enumerates all efforts; `search "surrealdb"` ranks Round-2 embed tickets (04/14) highly; `--status closed --type grilling` filters; no `.planning` mutation; package build+test green.

## Types & functions (defined here; every task references these exact names)
All in new file `src/effort-query.ts`:

```ts
export interface EffortTicketCounts { open: number; closed: number; claimed: number; }
export interface EffortListItem {
  slug: string;
  status: string;            // meta?.status ?? "active"
  destination: string;       // map?.destination ?? ""
  ticketCounts: EffortTicketCounts;
  frontierSize: number;      // count of tickets: status==="open" && !claimed && (blocking??[]).length===0
  fog: number;               // map?.fog?.length ?? 0
  lastModified?: string;     // meta?.last
}
export interface EffortListResult { ok: boolean; efforts: EffortListItem[]; error?: string; }

export type SearchDocKind = "ticket" | "decision";
export interface SearchMatch {
  kind: SearchDocKind;
  effort: string;
  ticketId?: string;         // set when kind==="ticket"
  title: string;
  status?: string;           // ticket.status (kind==="ticket")
  type?: string;             // ticket.type (kind==="ticket")
  snippet: string;
  score: number;
}
export interface SearchOptions {
  effort?: string;
  status?: "open" | "closed";
  type?: "research" | "prototype" | "grilling" | "task";
  limit?: number;            // default 10
}
export interface EffortSearchResult {
  ok: boolean;
  query: string;
  filters: { effort?: string; status?: string; type?: string };
  matches: SearchMatch[];
  truncated: boolean;        // true when total matches (pre-slice) > limit
  error?: string;
}

export function enumerateEfforts(cwd: string): string[];
export function listEfforts(cwd: string): EffortListResult;
export function searchEfforts(cwd: string, query: string, opts?: SearchOptions): EffortSearchResult;
```

### Tokenization, scoring, snippet (concrete — implement exactly)
```ts
const STOP = new Set(
  "the a an and or of to in for on is are be with this that it as at by from we i you not but if then so do does has have had will can should would what which how why when where who".split(" ")
);
function tokenize(text: string): string[] {
  return String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !STOP.has(t));
}
function countTerm(tokens: string[], term: string): number {
  let n = 0; for (const t of tokens) if (t === term) n++; return n;
}

// field weights
const W = { title: 8, resolution: 4, whatToBuild: 4, question: 2, acceptance: 2, gist: 2, body: 1 };

// score(doc, queryTerms) = sum over qt in queryTerms of sum over field f of countTerm(tokenize(fieldText_f), qt) * W[f]
// ticket doc fields: title=t.title, resolution=t.resolution, whatToBuild=t.whatToBuild,
//                    question=t.question, acceptance=(t.acceptance??[]).join(" "), body=(t.blocking??[]).join(" ")
// decision doc fields: title=doc.title, gist=d.gist  (synthetic destination doc: body=map.destination+"\n"+map.notes)
// doc scores 0 if no queryTerm hits any field -> excluded.

function makeSnippet(body: string, terms: string[]): string {
  const low = body.toLowerCase();
  let idx = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (idx < 0 || i < idx)) idx = i; }
  if (idx < 0) return "";                 // title-only match -> renderer falls back to title
  const start = Math.max(0, idx - 70), end = Math.min(body.length, idx + 90);
  return (start > 0 ? "\u2026" : "") + body.slice(start, end) + (end < body.length ? "\u2026" : "");
}
```

### Index, filters, ranking (concrete)
- **Index:** for each slug from `enumerateEfforts(cwd)`, `readMap(cwd, slug)`; for each ticket in `map.tickets` -> a `ticket` doc; for each entry in `map.decisions` -> a `decision` doc `{title, gist}`; plus one synthetic `decision` doc `{title: \`\${slug} destination\`, body: \`\${map.destination}\\n\${map.notes}\`}` so effort goals are searchable.
- **Filters** (apply before ranking): `effort` -> keep `doc.effort === opts.effort`; `status` -> keep `kind==="ticket" && ticket.status===opts.status` (drop decisions); `type` -> keep `kind==="ticket" && ticket.type===opts.type` (drop decisions).
- **Ranking:** sort by score desc, then effort asc, then (ticketId asc for tickets / title asc for decisions). `limit = opts.limit ?? 10`. `total = matches.length` before slicing; `matches = sorted.slice(0, limit)`; `truncated = total > limit`.

---

### Task 1: `list` action — `enumerateEfforts` + `listEfforts` + types (ticket T1)
**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/src/effort-query.ts`
- Test: `bun-apps/pi-agent-ext-wayfind/tests/effort-query.test.ts`
**Interfaces:**
- Consumes: `readEffortMeta(cwd, slug): EffortMeta|null` (lifecycle.ts), `readMap(cwd, slug): WayfindMap|null` (map.ts).
- Produces: `enumerateEfforts`, `listEfforts`, `EffortListItem`, `EffortListResult`, `EffortTicketCounts`.

- [ ] **Step 1: Write failing tests** in `tests/effort-query.test.ts` using the `mkdtempSync` real-fs harness from `tests/effort-tool.test.ts`. Seed `.planning/effA/map.md` (+ tickets 01 open-unclaimed-no-blocker, 02 closed, 03 claimed-open-with-blocker) and `.planning/effB/map.md` (+ ticket 01 open). Cases:
  - `enumerateEfforts(cwd)` -> `["effA","effB"]` sorted; non-dir and dotfile entries ignored.
  - `listEfforts(cwd)` -> `ok:true`, `efforts.length===2`, slug-sorted.
  - effA: `ticketCounts` matches seed; `frontierSize===1` (only 01 qualifies); `fog===` seeded map fog length; `status` from meta.
  - `listEfforts` on empty `.planning` -> `ok:true, efforts:[]`.
- [ ] **Step 2: Run** `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/effort-query.test.ts )` -> FAIL (module/functions absent).
- [ ] **Step 3: Implement** `src/effort-query.ts`: the types above, `enumerateEfforts` (`readdirSync(".planning")`, dirs only via `statSync`, sorted ascending), `listEfforts` (loop slugs; `readEffortMeta`+`readMap`; compute `ticketCounts`/`frontierSize`/`fog`; wrap in try/catch -> `{ok:false,error}` on any throw).
- [ ] **Step 4: Run** the test -> PASS.
- [ ] **Step 5:** `( cd bun-apps/pi-agent-ext-wayfind && bun run build )` green.
- [ ] **Step 6: Commit** (explicit paths only): `git add bun-apps/pi-agent-ext-wayfind/src/effort-query.ts bun-apps/pi-agent-ext-wayfind/tests/effort-query.test.ts && git commit -m "feat(wayfind): effort-query list action (ticket 15 T1)"`

**DoD:** `listEfforts` returns correct per-effort summary; throw-free; `bun run build` green.

### Task 2: `search` action — index + tokenize + score + snippet + filters + `searchEfforts` (ticket T2)
**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/effort-query.ts` (add search internals + exported `searchEfforts` + types)
- Test: extend `bun-apps/pi-agent-ext-wayfind/tests/effort-query.test.ts`
**Interfaces:**
- Consumes: `readMap` (tickets + decisions), `enumerateEfforts`.
- Produces: `searchEfforts`, `SearchMatch`, `SearchOptions`, `EffortSearchResult`, `SearchDocKind`.

- [ ] **Step 1: Write failing tests.** Seed one effort with: a ticket titled "Resolve embed backend (SurrealDB)" whose `resolution` mentions "SurrealDB HNSW"; a `grilling`-type ticket; a `closed` ticket; and a map decision whose gist mentions "knowledge graph". Cases:
  - `searchEfforts(cwd,"surrealdb")` -> `ok:true`; first match `kind==="ticket"`, `title` contains "SurrealDB", `score>0`, `snippet` contains "urrealdb".
  - `searchEfforts(cwd,"surrealdb",{status:"closed"})` -> only closed tickets; no decision docs in matches.
  - `searchEfforts(cwd,"x",{type:"grilling"})` -> only grilling tickets; no decision docs.
  - `searchEfforts(cwd,"graph",{effort:"<slug>"})` -> only that effort's docs; the decision match appears.
  - equal-score tickets keep stable order (seed two identical-title tickets; assert deterministic ordering across runs).
  - `searchEfforts(cwd,"")` -> `ok:true, matches:[]`.
  - `searchEfforts(cwd,"surrealdb",{limit:1})` with >=2 matches -> `truncated===true`, `matches.length===1`.
- [ ] **Step 2: Run** -> FAIL.
- [ ] **Step 3: Implement** `tokenize`/`countTerm`, field-weight scoring, `makeSnippet`, index build, filters, ranking/top-K, and `searchEfforts` (throw-free). Use the exact weights/snippet logic above.
- [ ] **Step 4: Run** -> PASS.
- [ ] **Step 5:** `bun run build` green.
- [ ] **Step 6: Commit:** `git add bun-apps/pi-agent-ext-wayfind/src/effort-query.ts bun-apps/pi-agent-ext-wayfind/tests/effort-query.test.ts && git commit -m "feat(wayfind): effort-query search action (ticket 15 T2)"`

**DoD:** surrealdb ranks #1; status/type/effort filters correct; decisions searchable; deterministic ordering; throw-free; `bun run build` green.

### Task 3: wire `list`/`search` into `wayfind_effort` (ticket T3)
**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts`
- Test: extend `bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts`
**Interfaces:**
- Consumes: `listEfforts`, `searchEfforts` from `./effort-query.ts`.
- Produces: tool action cases `list`/`search`; `renderList`, `renderSearch`.

- [ ] **Step 1: Write failing tests** via the tool wrapper (seed sandbox):
  - `makeWayfindEffortTool().execute("c",{action:"list"},undefined,undefined,{cwd})` -> `details.ok===true`, `content[0].text` non-empty, `details.efforts` array.
  - `execute("c",{action:"search",query:"surrealdb"},...)` -> `details.ok===true`, `details.matches` array, top match title contains "SurrealDB".
  - `execute("c",{action:"search",query:"surrealdb",effort:"<slug>"},...)` filters to that effort.
  - Smoke: `create` then `status` still work and require `effort` (omitting `effort` on `status` returns `ok:false`, no throw).
- [ ] **Step 2: Run** `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/effort-tool.test.ts )` -> FAIL (unknown action / missing effort handling).
- [ ] **Step 3: Implement** in `effort-tool.ts`:
  - Add `Type.Literal("list")` and `Type.Literal("search")` to the action union (update the union `description`).
  - Make `effort` `Type.Optional(Type.String(...))`.
  - Add params: `query: Type.Optional(Type.String(...))`, `statusFilter: Type.Optional(Type.Union([Type.Literal("open"),Type.Literal("closed")]))`, `typeFilter: Type.Optional(Type.Union([Type.Literal("research"),Type.Literal("prototype"),Type.Literal("grilling"),Type.Literal("task")]))`.
  - In `execute`: `case "list"` -> `listEfforts(cwd)`; `case "search"` -> `searchEfforts(cwd, params.query ?? "", { effort: params.effort, status: params.statusFilter, type: params.typeFilter })`.
  - For `create`/`validate`/`status`: if `effort` is missing, return an `ok:false` result object (do NOT throw).
  - Add `renderList(EffortListResult)` and `renderSearch(EffortSearchResult)`. Return `{ content:[{type:"text",text}], details: result }`.
  - Keep existing `create`/`validate`/`status` behavior byte-identical when `effort` is present.
- [ ] **Step 4: Run** `bun test tests/effort-tool.test.ts` -> PASS.
- [ ] **Step 5:** `( cd bun-apps/pi-agent-ext-wayfind && bun run build && bun run check )` green.
- [ ] **Step 6: Commit:** `git add bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts && git commit -m "feat(wayfind): wire effort-query list/search into wayfind_effort (ticket 15 T3)"`

**DoD:** list/search reachable through the tool; `effort` optional; `create`/`validate`/`status` unchanged when `effort` present; `bun run build` + `bun run check` green.

### Task 4: read-only invariant + acceptance + full regression (ticket T4)
**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/tests/effort-query.test.ts` (invariant + acceptance)
- Modify: `bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts` (acceptance via tool)
**Interfaces:** Consumes Tasks 1-3.

- [ ] **Step 1: Read-only invariant test.** Snapshot `.planning` in the sandbox (recursive file list + each file's content + mtime). Run `listEfforts(cwd)`, `searchEfforts(cwd,"x")`, and the tool's `list`/`search`. Assert the snapshot is byte-identical afterward (no adds/mods/removes; no mtime change).
- [ ] **Step 2: Acceptance test** (matches ticket Verification): seed Round-2 embed tickets referencing "surrealdb"; `searchEfforts(cwd,"surrealdb")` ranks a Round-2 ticket #1; `listEfforts(cwd)` enumerates all seeded efforts with correct counts; `searchEfforts(cwd,"x",{status:"closed",type:"grilling"})` returns the correct subset. Also assert via the tool (`action:"search"`).
- [ ] **Step 3: Run** -> green (iterate fixtures if needed).
- [ ] **Step 4: Full regression:** `( cd bun-apps/pi-agent-ext-wayfind && bun run build && bun test && bun run check )` all green.
- [ ] **Step 5: Commit:** `git add bun-apps/pi-agent-ext-wayfind/tests/effort-query.test.ts bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts && git commit -m "test(wayfind): effort-query read-only invariant + acceptance (ticket 15 T4)"`

**DoD:** read-only proven (no `.planning` mutation); ticket Verification satisfied; full package `bun run build && bun test && bun run check` green.

---

## Notes for the implementer
- Reuse `readMap`/`readEffortMeta`/`parseTicketFile` — do NOT re-parse tickets (use `map.tickets`).
- Throw-free everywhere: wrap fs reads in try/catch; return `{ok:false,error}`.
- Tests use real fs via `mkdtempSync` + `rmSync` cleanup (see `tests/effort-tool.test.ts` for the harness); no mocks.
- Renderers: `renderList` = compact per-effort block (slug, status, open/closed/claimed, frontier, fog, last); `renderSearch` = numbered rows `1. [effort] #id title (status,type) score \u2014 snippet` (decisions: `1. [effort] \u00b7 decision: title \u2014 snippet`); fall back to `title` when `snippet===""`.
- Determinism is required (tie-break sort by effort asc, then ticketId/title asc).
- Stage explicit paths on every commit (this repo's recurring `git add -A` sweep must not pull in unrelated files).
- Phase 1 only — do NOT add card-store/embed/sync/CRUD (Phase 2, tickets 08/09/10).
