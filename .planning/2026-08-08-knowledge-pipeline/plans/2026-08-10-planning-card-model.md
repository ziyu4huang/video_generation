# Planning-card model — Implementation Plan (Phase-2 / 08-impl)

> **STATUS: SHIPPED** via PR #1208 (squash 02976974) on 2026-08-10. All 6 tasks (T1–T6) complete; tests green (1 pre-existing date-flake, unrelated).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.planning/<effort>/` a first-class tenant of the hermes card-store: a planning-card serializer turns `map.md` → `planning-effort` cards and `tickets/NN.md` → `planning-ticket` cards (with resolution-gist + dependency edges), the card-store persists them in a namespaced target, and `walkAndIngest` mirrors `.planning/` into the store independent of the zk seam.

**Architecture:** Hermes owns ingest + store (ticket 06 spine); a self-contained planning-card serializer plugs into the kind-agnostic store (ticket 01), mirroring the `KnowledgeSerializer` pattern. The serializer parses `.planning` md directly — the md format is the contract, NOT a wayfind code import (avoids a hermes↔wayfind dep cycle; wayfind consumes hermes via the seam later). Two new `CardKind`s (`planning-effort`, `planning-ticket`) namespace the cards inside the SAME `memories` table (widened `target` CHECK). `walkAndIngest` gains a `planning` source family that mirrors independent of the zk `KnowledgePipeline` seam (planning is hermes-internal).

**Tech Stack:** Bun (no build step), TypeScript (`bun run typecheck`), `node:test` + `node:assert/strict`, `yaml` (frontmatter), better-sqlite3/bun:sqlite (via `SqliteBackend`), `@repo/pi-agent-ext-hermes-memory`.

## Global Constraints

- Platform: Apple Silicon, Bun (no build step; `bun run typecheck` for type-checking).
- Workspace: `bun-apps/` root with isolated linker — every imported package MUST be a declared dep of the importing package.
- NEVER use a top-level `cd` — use `( cd <dir> && ... )` or `git -C <WT>` / `--cwd`.
- `.planning/` md is git-canonical; Phase-2 / 08 is READ-ONLY into the store (mirror only). Writes/staleness/sync are tickets 09/10 — DO NOT implement them here.
- `<WT>` = the repo worktree root (the dir containing `bun-apps/` and `.planning/`). All `git -C <WT>` and `( cd ... )` calls use it.
- Memory/user/failure/knowledge cards MUST NOT regress: Tasks 1–4 are additive (new files / type widen); Task 5 widens a CHECK + adds registries (idempotent migration); Task 6 is an additive walk family + a mirror step that no-ops when `.planning/` is absent. If any existing test breaks at a task boundary, STOP and fix.

## Scope boundaries (deferred — NOT in this plan)
- Ticket 09 (sync): content-hash staleness refresh + background backfill + multi-worktree merge handling. 08 is append-once/idempotent; updates are 09.
- Ticket 10 (staleness): dependency-graph re-validation + `stale:`/`conflict:` queries + graduation gate. 08 only EMITS the graph edges (blocked-by + cited paths) that 10 consumes.
- Semantic/embed search over planning-cards (rides ticket 14).
- First-class `planning-decision` cards (decisions stay INLINE on ticket-cards).

---

### Task 1: Planning id scheme + CardKind widening

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-id.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-id.test.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts` (the `CardKind` union, ~line 6)

**Interfaces:**
- Produces: `planningCardKindFromSegs(relSegs): "planning-effort"|"planning-ticket"|null`, `planningCardKindFromPath(filePath)`, `parsePlanningPath(filePath): PlanningPathInfo|null`, `planningEffortId(effort)`, `planningTicketId(effort, ticketNo)`; widens `CardKind` with `"planning-effort" | "planning-ticket"`.

- [ ] **Step 1: Write the failing test**

Create `src/store/planning-id.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  planningCardKindFromPath,
  parsePlanningPath,
  planningEffortId,
  planningTicketId,
} from "./planning-id.js";
import type { CardKind } from "./card.js";

describe("planning-id", () => {
  it("classifies effort + ticket paths", () => {
    assert.equal(
      planningCardKindFromPath(".planning/2026-08-08-knowledge-pipeline/map.md"),
      "planning-effort",
    );
    assert.equal(
      planningCardKindFromPath(
        ".planning/2026-08-08-knowledge-pipeline/tickets/08-planning-card-model.md",
      ),
      "planning-ticket",
    );
  });
  it("rejects non-planning-card paths", () => {
    assert.equal(planningCardKindFromPath(".planning/specs/foo.md"), null);
    assert.equal(
      planningCardKindFromPath(".planning/2026-08-08-knowledge-pipeline/specs/bar.md"),
      null,
    );
    assert.equal(
      planningCardKindFromPath(".planning/2026-08-08-knowledge-pipeline/plans/baz.md"),
      null,
    );
    assert.equal(planningCardKindFromPath("src/store/card.ts"), null);
  });
  it("parses effort + ticketNo/slug", () => {
    assert.deepEqual(parsePlanningPath(".planning/my-effort/map.md"), {
      kind: "planning-effort",
      effort: "my-effort",
    });
    assert.deepEqual(
      parsePlanningPath(".planning/my-effort/tickets/08-planning-card-model.md"),
      { kind: "planning-ticket", effort: "my-effort", ticketNo: "08", slug: "planning-card-model" },
    );
  });
  it("builds globally-unique ids", () => {
    assert.equal(planningEffortId("my-effort"), "planning-effort:my-effort");
    assert.equal(planningTicketId("my-effort", "08"), "planning-ticket:my-effort:08");
  });
  it("planning kinds are valid CardKind values", () => {
    const a: CardKind = "planning-effort";
    const b: CardKind = "planning-ticket";
    assert.equal(a, "planning-effort");
    assert.equal(b, "planning-ticket");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-id.test.ts )`
Expected: FAIL — `Cannot find module "./planning-id.js"`.

- [ ] **Step 3: Widen CardKind**

In `src/store/card.ts`, replace the `CardKind` union with:
```ts
export type CardKind =
  | "memory"
  | "user"
  | "failure"
  | "knowledge"
  | "planning-effort"
  | "planning-ticket";
```

- [ ] **Step 4: Write the implementation**

Create `src/store/planning-id.ts`:
```ts
// src/store/planning-id.ts — canonical id scheme + file-path parsing for
// planning-cards (Phase-2 / ticket 08). Planning-cards share the unified
// `memories` table with memory/knowledge cards, so Card.id (= memories.md_id)
// MUST be globally unique. The `planning-effort:` / `planning-ticket:` prefixes
// guarantee no collision with memory (timestamp/hash) or knowledge (zettel) ids.

/** Discriminate a planning source file from repo-relative path segments.
 *  08 scope: `<effort>/map.md` → effort; `<effort>/tickets/NN-slug.md` → ticket.
 *  Everything else under .planning/ (specs/, plans/, flat files) is NOT a card. */
export function planningCardKindFromSegs(
  relSegs: string[],
): "planning-effort" | "planning-ticket" | null {
  const i = relSegs.indexOf(".planning");
  if (i < 0) return null;
  const after = relSegs.slice(i + 1);
  const n = after.length;
  if (n === 0) return null;
  const file = after[n - 1]!;
  // <effort>/tickets/NN-slug.md  (n >= 3: .planning / effort / tickets / file)
  if (n >= 3 && after[n - 2] === "tickets" && /^\d+-[^/]+\.md$/.test(file)) {
    return "planning-ticket";
  }
  // <effort>/map.md  (n === 2: .planning / effort / map.md)
  if (n === 2 && file === "map.md") return "planning-effort";
  return null;
}

/** Convenience: classify an absolute or relative md path (any separator). */
export function planningCardKindFromPath(
  filePath: string,
): "planning-effort" | "planning-ticket" | null {
  return planningCardKindFromSegs(filePath.split(/[\\/]/));
}

export interface PlanningPathInfo {
  kind: "planning-effort" | "planning-ticket";
  effort: string;
  ticketNo?: string;
  slug?: string;
}

/** Parse a planning source path → { kind, effort, ticketNo?, slug? }, or null. */
export function parsePlanningPath(filePath: string): PlanningPathInfo | null {
  const kind = planningCardKindFromPath(filePath);
  if (!kind) return null;
  const segs = filePath.split(/[\\/]/);
  const i = segs.indexOf(".planning");
  const after = segs.slice(i + 1);
  const effort = after[0]!;
  if (kind === "planning-effort") return { kind, effort };
  const file = after[after.length - 1]!;
  const m = /^(\d+)-(.+)\.md$/.exec(file);
  return { kind, effort, ticketNo: m![1]!, slug: m![2]! };
}

/** Canonical, globally-unique Card.id for a planning-effort card. */
export function planningEffortId(effort: string): string {
  return `planning-effort:${effort}`;
}

/** Canonical, globally-unique Card.id for a planning-ticket card. */
export function planningTicketId(effort: string, ticketNo: string): string {
  return `planning-ticket:${effort}:${ticketNo}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-id.test.ts )`
Expected: PASS (5 tests).

- [ ] **Step 6: Type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run typecheck )`
Expected: no errors.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-id.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-id.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning id scheme + CardKind widen (08-impl T1)"
```

**DoD:** `planning-id.ts` exports the 5 helpers; `CardKind` includes the two planning kinds; `planning-id.test.ts` green; typecheck clean.

---

### Task 2: Planning parse helpers

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.test.ts`

**Interfaces:**
- Produces: `splitPlanningFrontmatter(raw)`, `extractTitle(body)`, `extractResolutionGist(body)`, `parseBlockedBy(raw)`, `extractCitedPaths(body)`.

- [ ] **Step 1: Write the failing test**

Create `src/store/planning-parse.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  splitPlanningFrontmatter,
  extractTitle,
  extractResolutionGist,
  parseBlockedBy,
  extractCitedPaths,
} from "./planning-parse.js";

const TICKET = `---
type: grilling
status: closed
claimed: pi/test
blocked by: 06
---
# 08 — Planning-card model

## Question
Pin the contract. See bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts
and .planning/specs/2026-08-09-knowledge-pipeline-phase2-design.md.

## Resolution (2026-08-09, grilled)
Hermes owns ingest + store; a serializer plugs into hermes.
Cites src/store/card-store.ts.
`;

describe("planning-parse", () => {
  it("splits frontmatter from body (never throws)", () => {
    const s = splitPlanningFrontmatter(TICKET)!;
    assert.equal(s.data.type, "grilling");
    assert.equal(s.data.status, "closed");
    assert.match(s.body, /# 08 — Planning-card model/);
    assert.equal(splitPlanningFrontmatter("# no fence"), null);
  });
  it("extracts the first H1 title", () => {
    assert.equal(extractTitle("# hello\nbody"), "hello");
    assert.equal(extractTitle("body only"), undefined);
  });
  it("extracts a one-line resolution gist (matches '## Resolution (…)')", () => {
    const body = splitPlanningFrontmatter(TICKET)!.body;
    assert.match(extractResolutionGist(body)!, /Hermes owns ingest/);
  });
  it("returns undefined gist when there is no Resolution section", () => {
    assert.equal(extractResolutionGist("# t\n\n## Question\nq"), undefined);
  });
  it("normalises blocked-by string|array → string[]", () => {
    assert.deepEqual(parseBlockedBy("06"), ["06"]);
    assert.deepEqual(parseBlockedBy("06, 07"), ["06", "07"]);
    assert.deepEqual(parseBlockedBy(["01", "02"]), ["01", "02"]);
    assert.deepEqual(parseBlockedBy(undefined), []);
  });
  it("extracts cited repo-relative paths (deduped)", () => {
    const body = splitPlanningFrontmatter(TICKET)!.body;
    const paths = extractCitedPaths(body);
    assert.ok(paths.includes("bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts"));
    assert.ok(paths.includes(".planning/specs/2026-08-09-knowledge-pipeline-phase2-design.md"));
    assert.ok(paths.includes("src/store/card-store.ts"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-parse.test.ts )`
Expected: FAIL — `Cannot find module "./planning-parse.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/store/planning-parse.ts`:
```ts
// src/store/planning-parse.ts — pure helpers to parse .planning md into
// planning-card fields. Self-contained (no wayfind import): the .planning md
// format is the contract, mirroring KnowledgeSerializer's self-contained
// vault-md parsing. Parity with wayfind parseTicketFile/readMap is by format.
import { parse as parseYaml } from "yaml";

const FENCE = "---";

/** Split a leading `---` YAML frontmatter block from the body. null on a
 *  missing/malformed fence (never throws). */
export function splitPlanningFrontmatter(
  raw: string,
): { data: Record<string, unknown>; body: string } | null {
  const lines = raw.split("\n");
  if (lines.length === 0 || lines[0]!.trim() !== FENCE) return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  let data: Record<string, unknown>;
  try {
    const parsed = parseYaml(lines.slice(1, end).join("\n"));
    data = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

/** First H1 line (`# title`), or undefined. */
export function extractTitle(body: string): string | undefined {
  const m = body.match(/^# (.+)$/m);
  return m ? m[1]!.trim() : undefined;
}

/** One-line gist of a ticket's `## Resolution` section: the first non-empty
 *  line, truncated to 200 chars. Matches a `## Resolution` header with optional
 *  trailing suffix (e.g. `## Resolution (2026-08-09, grilled)`). Undefined when
 *  absent/empty. Deterministic — used for query/conflict (ticket 08 Q4). */
export function extractResolutionGist(body: string): string | undefined {
  const lines = body.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Resolution\b/.test(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  const section = out.join("\n").trim();
  if (!section) return undefined;
  const firstLine = section
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return undefined;
  return firstLine.length > 200 ? firstLine.slice(0, 197) + "..." : firstLine;
}

/** Normalise a frontmatter `blocked by` value (string | string[]) → string[]. */
export function parseBlockedBy(raw: unknown): string[] {
  if (typeof raw === "string") return raw.split(/[,\s]+/).filter((s) => s.length > 0);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

/** Repo-relative source paths cited in a body (Resolution/Notes), for the
 *  staleness dependency graph (ticket 10). Matches rooted paths under
 *  bun-apps/, src/, python/, scripts/, docs/, tests/, .planning/. Deduped. */
const CITED_PATH_RE = /((?:bun-apps|src|python|scripts|docs|tests|\.planning)\/[A-Za-z0-9_./-]+)/g;
export function extractCitedPaths(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(CITED_PATH_RE)) {
    const path = m[1]!.trim();
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-parse.test.ts )`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run typecheck )`
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning-parse helpers (08-impl T2)"
```

**DoD:** all 5 helpers exported + green; typecheck clean.

---

### Task 3: PlanningEffortSerializer + PlanningTicketSerializer + fixtures

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/__fixtures__/planning/2026-08-08-fixture-effort/map.md`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/__fixtures__/planning/2026-08-08-fixture-effort/tickets/01-shipping.md`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/__fixtures__/planning/2026-08-08-fixture-effort/tickets/08-planning-card-model.md`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.test.ts`

**Interfaces:**
- Consumes: `Card`, `CardGraph` from `./card.js`; `CardSerializer` from `./card-serializer.js`; Task 1 ids + `parsePlanningPath`; Task 2 parse helpers.
- Produces: `class PlanningEffortSerializer implements CardSerializer<"planning-effort">`, `class PlanningTicketSerializer implements CardSerializer<"planning-ticket">`.

- [ ] **Step 1: Create the fixtures**

Create `src/store/__fixtures__/planning/2026-08-08-fixture-effort/map.md`:
```md
---
status: active
---
# Fixture effort — planning-card serializer

## Destination
A fixture effort used to test the planning-card serializer.

## Decisions so far
- 01: [shipping](tickets/01-shipping.md) — ship it.
- 08: [planning-card model](tickets/08-planning-card-model.md) — hermes owns store.

## Notes
- Reuses bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts.

## Not yet specified
- nothing

## Out of scope
- audio
```

Create `src/store/__fixtures__/planning/2026-08-08-fixture-effort/tickets/01-shipping.md`:
```md
---
type: task
status: closed
---
# 01 — Shipping

## Question
How to ship.

## Resolution
Ship via gh pr merge --squash.
```

Create `src/store/__fixtures__/planning/2026-08-08-fixture-effort/tickets/08-planning-card-model.md`:
```md
---
type: grilling
status: closed
claimed: pi/test
blocked by: 01
---
# 08 — Planning-card model

## Question
Pin the planning-card contract. See bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts
and .planning/specs/2026-08-09-knowledge-pipeline-phase2-design.md.

## Resolution (2026-08-09, grilled)
Hermes owns ingest + store; a planning-card serializer plugs into hermes. Each
ticket becomes a planning-ticket card with a resolution-gist; map.md becomes a
planning-effort card. Cites src/store/card-store.ts.
```

- [ ] **Step 2: Write the failing test**

Create `src/store/planning-serializer.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PlanningEffortSerializer, PlanningTicketSerializer } from "./planning-serializer.js";

const here = dirname(fileURLToPath(import.meta.url));
const effortDir = join(here, "__fixtures__/planning/2026-08-08-fixture-effort");
const mapBytes = readFileSync(join(effortDir, "map.md"), "utf8");
const t08Bytes = readFileSync(join(effortDir, "tickets/08-planning-card-model.md"), "utf8");
const EFFORT = "2026-08-08-fixture-effort";

describe("PlanningEffortSerializer", () => {
  const ser = new PlanningEffortSerializer();
  it("kind === planning-effort", () => assert.equal(ser.kind, "planning-effort"));
  it("deserialize map.md -> 1 planning-effort card", () => {
    const cards = ser.deserialize(mapBytes, { filePath: `.planning/${EFFORT}/map.md` });
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.equal(c.kind, "planning-effort");
    assert.equal(c.id, `planning-effort:${EFFORT}`);
    assert.equal(c.frontmatter.status, "active");
    assert.equal(c.frontmatter.title, "Fixture effort — planning-card serializer");
    assert.match(c.content, /## Destination/);
  });
  it("graph.links = ticket numbers cited in the map", () => {
    const [c] = ser.deserialize(mapBytes, { filePath: `.planning/${EFFORT}/map.md` });
    assert.deepEqual([...(c!.graph?.links ?? [])].sort(), ["01", "08"]);
  });
  it("returns [] without filePath", () => assert.deepEqual(ser.deserialize(mapBytes), []));
});

describe("PlanningTicketSerializer", () => {
  const ser = new PlanningTicketSerializer();
  it("kind === planning-ticket", () => assert.equal(ser.kind, "planning-ticket"));
  it("deserialize tickets/08 -> planning-ticket card with gist + deps", () => {
    const cards = ser.deserialize(t08Bytes, {
      filePath: `.planning/${EFFORT}/tickets/08-planning-card-model.md`,
    });
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.equal(c.kind, "planning-ticket");
    assert.equal(c.id, `planning-ticket:${EFFORT}:08`);
    assert.equal(c.frontmatter.id, "08");
    assert.equal(c.frontmatter.slug, "planning-card-model");
    assert.equal(c.frontmatter.type, "grilling");
    assert.equal(c.frontmatter.status, "closed");
    assert.equal(c.frontmatter.claimed, "pi/test");
    assert.deepEqual(c.frontmatter.blockedBy, ["01"]);
    assert.match(c.frontmatter.resolutionGist, /Hermes owns ingest/);
    assert.match(c.content, /## Resolution/);
  });
  it("graph.relations = blocked-by + cited paths", () => {
    const [c] = ser.deserialize(t08Bytes, {
      filePath: `.planning/${EFFORT}/tickets/08-planning-card-model.md`,
    });
    const rels = c!.graph?.relations ?? [];
    assert.ok(
      rels.some((r) => r.rel === "blocked-by" && r.o === `planning-ticket:${EFFORT}:01`),
    );
    assert.ok(
      rels.some(
        (r) => r.rel === "cites" && r.o === "bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts",
      ),
    );
    assert.ok(
      rels.some(
        (r) =>
          r.rel === "cites" &&
          r.o === ".planning/specs/2026-08-09-knowledge-pipeline-phase2-design.md",
      ),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-serializer.test.ts )`
Expected: FAIL — `Cannot find module "./planning-serializer.js"`.

- [ ] **Step 4: Write the implementation**

Create `src/store/planning-serializer.ts`:
```ts
// src/store/planning-serializer.ts — CardSerializers for planning-cards
// (Phase-2 / ticket 08). Self-contained .planning md parsing (mirrors the
// KnowledgeSerializer pattern; no wayfind import — the md format is the
// contract).
//
//  - PlanningEffortSerializer: deserialize `<effort>/map.md` -> 1 planning-effort Card.
//  - PlanningTicketSerializer: deserialize `<effort>/tickets/NN-slug.md` -> 1 planning-ticket Card.
//
// deserialize REQUIRES opts.filePath (the source path) to derive the effort
// slug (+ ticket no/slug); returns [] if the path is not a planning artifact or
// the md has no frontmatter. serialize round-trips for symmetry (the store does
// NOT call it for planning in 08 — .planning md is git-canonical; writes stay
// wayfind-owned).
import type { Card, CardGraph } from "./card.js";
import type { CardSerializer } from "./card-serializer.js";
import { parsePlanningPath, planningEffortId, planningTicketId } from "./planning-id.js";
import {
  splitPlanningFrontmatter,
  extractTitle,
  extractResolutionGist,
  parseBlockedBy,
  extractCitedPaths,
} from "./planning-parse.js";

function effortCard(mapBytes: string, filePath: string): Card | null {
  const info = parsePlanningPath(filePath);
  if (!info || info.kind !== "planning-effort") return null;
  const split = splitPlanningFrontmatter(mapBytes);
  if (!split) return null;
  const { data, body } = split;
  const title = extractTitle(body);
  const links: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/tickets\/(\d+)-[^)\s]+\.md/g)) {
    const no = m[1]!;
    if (!seen.has(no)) {
      seen.add(no);
      links.push(no);
    }
  }
  const graph: CardGraph | undefined = links.length > 0 ? { links } : undefined;
  const frontmatter: Record<string, unknown> = {
    effort: info.effort,
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(title ? { title } : {}),
  };
  return {
    id: planningEffortId(info.effort),
    kind: "planning-effort",
    content: body.trim(),
    frontmatter,
    ...(graph ? { graph } : {}),
  };
}

function ticketCard(ticketBytes: string, filePath: string): Card | null {
  const info = parsePlanningPath(filePath);
  if (!info || info.kind !== "planning-ticket" || !info.ticketNo) return null;
  const split = splitPlanningFrontmatter(ticketBytes);
  if (!split) return null;
  const { data, body } = split;
  const title = extractTitle(body);
  const blockedBy = parseBlockedBy(data["blocked by"]);
  const resolutionGist = extractResolutionGist(body);
  const citedPaths = extractCitedPaths(body);
  const selfId = planningTicketId(info.effort, info.ticketNo);
  const relations: { s: string; rel: string; o: string }[] = [];
  for (const dep of blockedBy) {
    relations.push({ s: selfId, rel: "blocked-by", o: planningTicketId(info.effort, dep) });
  }
  for (const path of citedPaths) {
    relations.push({ s: selfId, rel: "cites", o: path });
  }
  const graph: CardGraph | undefined = relations.length > 0 ? { relations } : undefined;
  const frontmatter: Record<string, unknown> = {
    id: info.ticketNo,
    slug: info.slug ?? "",
    ...(typeof data.type === "string" ? { type: data.type } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.claimed === "string" && data.claimed.length > 0 ? { claimed: data.claimed } : {}),
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
    ...(resolutionGist ? { resolutionGist } : {}),
    ...(title ? { title } : {}),
  };
  return {
    id: selfId,
    kind: "planning-ticket",
    content: body.trim(),
    frontmatter,
    ...(graph ? { graph } : {}),
  };
}

export class PlanningEffortSerializer implements CardSerializer<"planning-effort"> {
  readonly kind = "planning-effort" as const;
  deserialize(fileBytes: string, opts?: { filePath?: string }): Card[] {
    if (!opts?.filePath) return [];
    const card = effortCard(fileBytes, opts.filePath);
    return card ? [card] : [];
  }
  serialize(card: Card): string {
    const fm = card.frontmatter;
    const lines: string[] = ["---"];
    if (typeof fm.status === "string") lines.push(`status: ${fm.status}`);
    lines.push("---", "");
    if (typeof fm.title === "string") lines.push(`# ${fm.title}`, "");
    lines.push(card.content);
    return lines.join("\n");
  }
}

export class PlanningTicketSerializer implements CardSerializer<"planning-ticket"> {
  readonly kind = "planning-ticket" as const;
  deserialize(fileBytes: string, opts?: { filePath?: string }): Card[] {
    if (!opts?.filePath) return [];
    const card = ticketCard(fileBytes, opts.filePath);
    return card ? [card] : [];
  }
  serialize(card: Card): string {
    const fm = card.frontmatter;
    const lines: string[] = ["---"];
    if (typeof fm.type === "string") lines.push(`type: ${fm.type}`);
    if (typeof fm.status === "string") lines.push(`status: ${fm.status}`);
    if (typeof fm.claimed === "string") lines.push(`claimed: ${fm.claimed}`);
    if (Array.isArray(fm.blockedBy) && (fm.blockedBy as string[]).length > 0) {
      lines.push(`blocked by: ${(fm.blockedBy as string[]).join(", ")}`);
    }
    lines.push("---", "");
    if (typeof fm.title === "string") lines.push(`# ${fm.title}`, "");
    lines.push(card.content);
    return lines.join("\n");
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-serializer.test.ts )`
Expected: PASS (8 tests).

- [ ] **Step 6: Type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run typecheck )`
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/__fixtures__/planning
git -C <WT> commit -m "feat(knowledge-pipeline): planning-card serializers + fixtures (08-impl T3)"
```

**DoD:** both serializers deserialize the fixtures into correctly-shaped cards (ids, frontmatter, graph); typecheck clean.

---

### Task 4: PlanningDedupStrategy (effort + ticket)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-dedup.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-dedup.test.ts`

**Interfaces:**
- Consumes: `Card` from `./card.js`; `DedupDecision`, `DedupStrategy` from `./dedup-strategy.js`.
- Produces: `class PlanningEffortDedupStrategy implements DedupStrategy<"planning-effort">`, `class PlanningTicketDedupStrategy implements DedupStrategy<"planning-ticket">`.

- [ ] **Step 1: Write the failing test**

Create `src/store/planning-dedup.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PlanningEffortDedupStrategy, PlanningTicketDedupStrategy } from "./planning-dedup.js";
import type { Card } from "./card.js";

const ticket = (id: string): Card => ({ id, kind: "planning-ticket", content: "x", frontmatter: {} });

describe("PlanningTicketDedupStrategy", () => {
  const d = new PlanningTicketDedupStrategy();
  it("kind === planning-ticket", () => assert.equal(d.kind, "planning-ticket"));
  it("keeps when the id is new", () => {
    assert.equal(d.dedup(ticket("planning-ticket:e:01"), []).action, "keep");
  });
  it("skips when the id already exists (idempotent re-ingest)", () => {
    const existing = [ticket("planning-ticket:e:01")];
    const dec = d.dedup(ticket("planning-ticket:e:01"), existing);
    assert.equal(dec.action, "skip");
    assert.equal(dec.existingId, "planning-ticket:e:01");
  });
});

describe("PlanningEffortDedupStrategy", () => {
  const d = new PlanningEffortDedupStrategy();
  it("kind === planning-effort", () => assert.equal(d.kind, "planning-effort"));
  it("keeps new, skips existing", () => {
    const e = (id: string): Card => ({ id, kind: "planning-effort", content: "x", frontmatter: {} });
    assert.equal(d.dedup(e("planning-effort:e"), []).action, "keep");
    assert.equal(d.dedup(e("planning-effort:e"), [e("planning-effort:e")]).action, "skip");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-dedup.test.ts )`
Expected: FAIL — `Cannot find module "./planning-dedup.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/store/planning-dedup.ts`:
```ts
// src/store/planning-dedup.ts — DedupStrategy for planning-cards (Phase-2 / 08).
// Idempotent upsert by Card.id (same shape as KnowledgeDedupStrategy). Planning
// content updates land via ticket 09's content-hash refresh; 08 is append-once.
import type { Card } from "./card.js";
import type { DedupDecision, DedupStrategy } from "./dedup-strategy.js";

export class PlanningEffortDedupStrategy implements DedupStrategy<"planning-effort"> {
  readonly kind = "planning-effort" as const;
  dedup(incoming: Card, existing: Card[]): DedupDecision {
    if (existing.some((c) => c.id === incoming.id)) {
      return { action: "skip", existingId: incoming.id, reason: "idempotent re-ingest (same effort id)" };
    }
    return { action: "keep" };
  }
}

export class PlanningTicketDedupStrategy implements DedupStrategy<"planning-ticket"> {
  readonly kind = "planning-ticket" as const;
  dedup(incoming: Card, existing: Card[]): DedupDecision {
    if (existing.some((c) => c.id === incoming.id)) {
      return { action: "skip", existingId: incoming.id, reason: "idempotent re-ingest (same ticket id)" };
    }
    return { action: "keep" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-dedup.test.ts )`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run typecheck )`
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-dedup.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-dedup.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning dedup strategies (08-impl T4)"
```

**DoD:** both strategies keep-new / skip-existing by id; typecheck clean.

---

### Task 5: Card-store planning tenant (schema CHECK + registries + generalized upsert)

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts` (the `memories.target` CHECK line in `SCHEMA_SQL`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts` (add `migrateMemoriesTargetCheckAddPlanning`; call it in `initializeSchema`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` (imports, registries, `upsertCard`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts` (planning round-trip + migration tests)

**Interfaces:**
- Consumes: Tasks 1–4 (CardKind, serializers, dedup).
- Produces: `createCardStore` registers planning serializers + dedup; `upsertCard` persists `planning-effort`/`planning-ticket` (target = kind); the `memories.target` CHECK allows the two new values on fresh + migrated DBs.

- [ ] **Step 1: Write the failing tests (append to `__tests__/card-store.test.ts`)**

Add these imports at the top (alongside the existing ones):
```ts
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
```
Append inside the existing `describe("card-agnostic store (SQLite round-trip)", …)` block (after the existing `it(...)` cases):
```ts
  it("persists + retrieves a planning-ticket Card", async () => {
    const card: Card = {
      id: "planning-ticket:fixture-effort:08",
      kind: "planning-ticket",
      content: "Hermes owns ingest + store",
      frontmatter: { id: "08", slug: "planning-card-model", type: "grilling", status: "closed" },
    };
    await store.upsertCard(card);
    const back = await store.getCard(card.id);
    assert.ok(back);
    assert.equal(back!.kind, "planning-ticket");
    assert.equal(back!.id, card.id);
    assert.equal(back!.frontmatter.slug, "planning-card-model");
  });

  it("re-ingesting a planning-effort id is idempotent", async () => {
    const card: Card = {
      id: "planning-effort:fixture-effort",
      kind: "planning-effort",
      content: "destination",
      frontmatter: { effort: "fixture-effort", status: "active" },
    };
    await store.upsertCard(card);
    await store.upsertCard(card);
    const ofKind = await store.getCardsByKind("planning-effort");
    assert.equal(ofKind.filter((c) => c.id === card.id).length, 1);
  });

  it("migrates a legacy 4-value target CHECK to 6-value (planning kinds allowed)", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "planning-migrate-"));
    try {
      // Seed a post-06a / pre-planning DB: 4-value target CHECK.
      const raw = new Database(join(legacyDir, "sessions.db"));
      raw.exec(
        `CREATE TABLE memories (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           target TEXT NOT NULL CHECK (target IN ('memory','user','failure','knowledge')),
           content TEXT NOT NULL,
           created DATE NOT NULL,
           last_referenced DATE NOT NULL
         )`,
      );
      raw.exec(
        "INSERT INTO memories (target, content, created, last_referenced) VALUES ('knowledge','seed','2026-01-01','2026-01-01')",
      );
      raw.close();
      // Opening the store runs initializeSchema -> migrateMemoriesTargetCheckAddPlanning fires.
      const migrated = await createCardStore({ memoryDir: legacyDir, dbBackend: "sqlite" });
      await migrated.upsertCard({
        id: "planning-ticket:e:01",
        kind: "planning-ticket",
        content: "post-migration",
        frontmatter: { id: "01" },
      });
      const back = await migrated.getCard("planning-ticket:e:01");
      assert.ok(back);
      assert.equal(back!.kind, "planning-ticket");
      await migrated.close();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
```
> NOTE: if `bun:sqlite` is not this package's sqlite binding, swap the `Database` import for the binding `SqliteBackend` uses (check `sqlite-backend.ts` imports) — the seed SQL is identical.

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`
Expected: FAIL — planning `upsertCard` throws ("persists knowledge cards only") / CHECK constraint violation.

- [ ] **Step 3: Widen the SCHEMA_SQL CHECK**

In `src/store/sqlite/schema.ts`, replace the `target` line inside the `memories` CREATE TABLE:
```sql
    target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure', 'knowledge', 'planning-effort', 'planning-ticket')),
```

- [ ] **Step 4: Add the migration method + call it**

In `src/store/sqlite/sqlite-backend.ts`, inside `initializeSchema(db)`, add one line immediately AFTER the existing `this.migrateMemoriesTargetCheckAddKnowledge(db);` call:
```ts
    // Phase-2 (knowledge-pipeline / ticket 08): widen the 4-value target CHECK
    // (memory/user/failure/knowledge) to also allow planning kinds. Idempotent
    // (skips when 'planning-ticket' already present). Mirrors the knowledge
    // migration's table-rebuild idiom.
    this.migrateMemoriesTargetCheckAddPlanning(db);
```
Then add this new private method immediately AFTER `migrateMemoriesTargetCheckAddKnowledge` (same shape — only the CHECK values + idempotency key differ):
```ts
  /** Phase-2 (ticket 08): widen `memories.target` CHECK from the 4-value form
   *  (memory/user/failure/knowledge) to include 'planning-effort' and
   *  'planning-ticket'. Gated on `sqlite_master` SQL-text inspection (the
   *  precedent at migrateMemoriesTargetCheckAddKnowledge): skips when the CREATE
   *  TABLE already mentions 'planning-ticket'; only fires on the exact 4-value
   *  CHECK shape. Carries the FULL current column set through the rebuild. */
  private migrateMemoriesTargetCheckAddPlanning(db: DatabaseLike): void {
    const tableSqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql ?? '';
    if (!tableSql) return;
    if (/'planning-ticket'/.test(tableSql)) return;
    const isFourValueCheck = /target\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*target\s+IN\s*\(\s*'memory'\s*,\s*'user'\s*,\s*'failure'\s*,\s*'knowledge'\s*\)\s*\)/i.test(tableSql);
    if (!isFourValueCheck) return;

    const fullColumns = [
      'id', 'project', 'target', 'category', 'content',
      'failure_reason', 'tool_state', 'corrected_to',
      'created', 'last_referenced', 'mw_success', 'mw_fail', 'status',
      'supersedes', 'superseded_by', 'parent_ids',
      'md_id', 'state', 'severity', 'pin', 'frontmatter',
    ];
    const colList = fullColumns.join(', ');

    const doRewrite = (): void => {
      this.ensureMemoriesColumns(db);
      db.exec(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure', 'knowledge', 'planning-effort', 'planning-ticket')),
          category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL,
          mw_success INTEGER NOT NULL DEFAULT 0,
          mw_fail INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          supersedes INTEGER,
          superseded_by INTEGER,
          parent_ids TEXT,
          md_id TEXT,
          state TEXT NOT NULL DEFAULT 'active',
          severity INTEGER,
          pin INTEGER NOT NULL DEFAULT 0,
          frontmatter TEXT
        );
      `);
      db.exec(`INSERT INTO memories_new (${colList}) SELECT ${colList} FROM memories;`);
      db.exec('DROP TABLE memories');
      db.exec('ALTER TABLE memories_new RENAME TO memories');
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
        CREATE INDEX IF NOT EXISTS idx_memories_target ON memories(target);
        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_md_id ON memories(md_id);
      `);
    };

    if (!db.transaction) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec('BEGIN IMMEDIATE');
        doRewrite();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
      return;
    }
    const tx = db.transaction(() => doRewrite());
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
```

- [ ] **Step 5: Register planning serializers + dedup; generalize upsertCard**

In `src/store/card-store.ts`, add these imports alongside the existing serializer/dedup imports:
```ts
import { PlanningEffortSerializer } from "./planning-serializer.js";
import { PlanningTicketSerializer } from "./planning-serializer.js";
import { PlanningEffortDedupStrategy } from "./planning-dedup.js";
import { PlanningTicketDedupStrategy } from "./planning-dedup.js";
```
In `createCardStore`, extend the two registries (add the four entries shown):
```ts
  const serializers = new Map<CardKind, CardSerializer>([
    ["memory", new MemorySerializer("memory")],
    ["user", new MemorySerializer("user")],
    ["failure", new MemorySerializer("failure")],
    ["knowledge", new KnowledgeSerializer()],
    ["planning-effort", new PlanningEffortSerializer()],
    ["planning-ticket", new PlanningTicketSerializer()],
  ]);
  const memoryDedup = new MemoryDedupStrategy();
  const dedupStrategies = new Map<CardKind, DedupStrategy>([
    ["memory", memoryDedup],
    ["user", memoryDedup],
    ["failure", memoryDedup],
    ["knowledge", new KnowledgeDedupStrategy()],
    ["planning-effort", new PlanningEffortDedupStrategy()],
    ["planning-ticket", new PlanningTicketDedupStrategy()],
  ]);
```
Replace the `upsertCard` method body's inner guard + INSERT so it persists knowledge AND planning kinds, using `card.kind` as `target`:
```ts
    async upsertCard(card: Card): Promise<void> {
      const strategy = dedupStrategies.get(card.kind);
      if (!strategy) {
        throw new Error(`createCardStore: no dedup strategy registered for kind "${card.kind}"`);
      }
      const existing = await fetchCardsByTarget(card.kind);
      const decision = strategy.dedup(card, existing);
      if (decision.action !== "keep") return;

      const persistableKinds = new Set<CardKind>(["knowledge", "planning-effort", "planning-ticket"]);
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          if (!persistableKinds.has(card.kind)) {
            throw new Error(
              `createCardStore.upsertCard persists card-store-managed kinds only (knowledge/planning-*); kind "${card.kind}" uses the existing MemoryStore path.`,
            );
          }
          getDb()
            .prepare(
              `INSERT INTO memories
                 (project, target, category, content, failure_reason, tool_state, corrected_to,
                  created, last_referenced, mw_success, mw_fail, status, md_id, state, severity, pin, frontmatter)
               VALUES (?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, 0, 0, 'active', ?, 'active', NULL, 0, ?)`,
            )
            .run(null, card.kind, card.content, today(), today(), card.id, JSON.stringify(card.frontmatter));
        }),
      );
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`
Expected: PASS (existing knowledge tests + the 3 new planning tests).

- [ ] **Step 7: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run typecheck && bun test )`
Expected: all green (memory/user/failure/knowledge unchanged).
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): card-store planning tenant — CHECK widen + registries + upsert (08-impl T5)"
```

**DoD:** planning-effort + planning-ticket round-trip the store (fresh + migrated DB); knowledge/memory paths unchanged; full package test suite green.

---

### Task 6: walkAndIngest planning family + mirror (seam-independent)

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/knowledge-walk.ts` (`WalkFiles`, `classify`, `emptyResult`, `walkKnowledgeSources` dedupe)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (imports, `WalkAndIngestReceipt`, `walkAndIngest` restructure, new `mirrorPlanningToStore`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (planning mirror test)

**Interfaces:**
- Consumes: Tasks 1, 3, 5 (`planningCardKindFromSegs`/`planningCardKindFromPath`, serializers via the store, `createCardStore`).
- Produces: `WalkFiles.planning: string[]`; `WalkAndIngestReceipt.planningMirrored: number`; `.planning/` is mirrored whenever present (even with no zk seam).

- [ ] **Step 1: Write the failing test (append to `__tests__/walk-and-ingest.test.ts`)**

Add imports at the top as needed:
```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walkAndIngest } from "../src/walk-and-ingest.js";
import { createCardStore } from "../src/store/card-store.js";
```
Append a new describe block:
```ts
describe("walkAndIngest — planning family (seam-independent)", () => {
  it("mirrors .planning/ into the card-store without the zk seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-walk-"));
    const mem = mkdtempSync(join(tmpdir(), "planning-walk-mem-"));
    try {
      const effort = "fixture-walk-effort";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(
        join(root, ".planning", effort, "map.md"),
        "---\nstatus: active\n---\n# Walk effort\n\n## Destination\nd\n",
      );
      writeFileSync(
        join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nDone.\n",
      );
      // Absolute input -> rel paths retain the `.planning` segment the classifier needs.
      const receipt = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(receipt.planningMirrored >= 2, `expected >=2 mirrored, got ${receipt.planningMirrored}`);

      const store = await createCardStore({ memoryDir: mem });
      const tickets = await store.getCardsByKind("planning-ticket");
      const efforts = await store.getCardsByKind("planning-effort");
      await store.close();
      assert.ok(tickets.some((c) => c.id === `planning-ticket:${effort}:01`));
      assert.ok(efforts.some((c) => c.id === `planning-effort:${effort}`));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: FAIL — `planningMirrored` does not exist on the receipt (planning family not classified/mirrored).

- [ ] **Step 3: Add the planning family to the walk**

In `src/knowledge-walk.ts`, add the import at the top:
```ts
import { planningCardKindFromSegs } from "./store/planning-id.js";
```
Extend `WalkFiles`:
```ts
export interface WalkFiles {
  "workflow-jsonl": string[];
  generic: string[];
  planning: string[];
}
```
In `emptyResult`, add the planning array:
```ts
function emptyResult(): WalkResult {
  return {
    files: { "workflow-jsonl": [], generic: [], planning: [] },
    skipped: { dirs: [], binaries: [], symlinks: [], deferredFamily: [] },
  };
}
```
In `classify`, route planning artifacts BEFORE the generic `.md` fallback — replace the `if (ext === ".md") { … }` block with:
```ts
  if (ext === ".md") {
    if (planningCardKindFromSegs(segs)) {
      result.files.planning.push(abs);
      return;
    }
    result.files.generic.push(abs);
    return;
  }
```
In `walkKnowledgeSources`, add the planning dedupe alongside the existing dedupe calls:
```ts
  result.files.planning = dedupeSorted(result.files.planning);
```

- [ ] **Step 4: Add `planningMirrored` to the receipt + restructure walkAndIngest**

In `src/walk-and-ingest.ts`, add imports:
```ts
import { planningCardKindFromPath } from "./store/planning-id.js";
```
Add the field to `WalkAndIngestReceipt`:
```ts
  /** # of planning-cards mirrored into the card-store (Phase-2 / 08; 0 when
   *  no .planning/ source is walked). Independent of the zk seam. */
  planningMirrored: number;
```
Add the `reason`/seam-absent return field accordingly (it already has `mirrored: 0`; add `planningMirrored: 0` there too). Replace the body of `walkAndIngest` with:
```ts
export async function walkAndIngest(
  input: string | string[],
  opts: WalkAndIngestOptions = {},
): Promise<WalkAndIngestReceipt> {
  const folder = opts.folder ?? KNOWLEDGE_FOLDER_DEFAULT;
  const mocPath = opts.mocPath ?? KNOWLEDGE_MOC_DEFAULT;

  // 3-4. Policy walk + source-family detection (hermes owns the walk).
  const walk = walkKnowledgeSources(input, opts);

  // 2. Read the seam (graceful). Planning mirror is seam-INDEPENDENT (08).
  const kp = getKnowledgePipeline();
  let vaultPath = "";
  let ingest: IngestSummary | undefined;
  let heal: HealReceipt | undefined;
  let mirrored = 0;
  const currentHashes: Record<string, string> = {};

  if (kp) {
    // 1. Resolve vault (env-only) — only needed for the knowledge path.
    vaultPath = resolveKnowledgeVaultPath();

    // 5. Adapt workflow-jsonl -> KnowledgeRecord[] (Option A; generic deferred).
    const records = [];
    for (const file of walk.files["workflow-jsonl"]) {
      let content = "";
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      records.push(...parseKnowledgeJsonl(content).records);
    }

    // 6-7. Ingest + heal (zk writes vault-md; hermes does not).
    ingest = await kp.ingestRecords(records, {
      vaultPath,
      source: "workflow-jsonl",
      sourceLabel: opts.sourceLabel ?? "walkAndIngest",
      folder,
      mocPath,
      maxLinks: opts.maxLinks,
      wikiAware: opts.wikiAware,
      linkWeighting: opts.linkWeighting,
    });
    heal = await kp.healGraph({ vaultPath, folder, mocPath });

    // 8-9. Knowledge DB-mirror + Tier-1 drift stub.
    const m = await mirrorVaultMdToStore(vaultPath, folder, opts.memoryDir);
    mirrored = m.mirrored;
    Object.assign(currentHashes, m.currentHashes);
  }

  // 8b. Planning DB-mirror (Phase-2 / 08) — independent of the zk seam.
  const { planningMirrored } = await mirrorPlanningToStore(walk.files.planning, opts.memoryDir);

  // 10. Receipt.
  if (!kp && walk.files.planning.length === 0) {
    return {
      ok: false,
      vaultPath,
      folder,
      mirrored: 0,
      planningMirrored: 0,
      driftStub: { filesHashed: 0, currentHashes: {} },
      skipped: walk.skipped,
      seamPresent: false,
      reason: "zk KnowledgePipeline seam not present and no planning source",
    };
  }
  return {
    ok: true,
    vaultPath,
    folder,
    ingest,
    heal,
    mirrored,
    planningMirrored,
    driftStub: {
      filesHashed: Object.keys(currentHashes).length,
      previousHashes: opts.previousHashes,
      currentHashes,
    },
    skipped: walk.skipped,
    seamPresent: !!kp,
  };
}
```
Add the new helper (next to `mirrorVaultMdToStore`):
```ts
/** Mirror step 8b (Phase-2 / 08): read each `.planning/<effort>/{map.md,
 *  tickets/NN.md}` planning source -> deserialize via the store's planning
 *  serializers -> upsertCard. Independent of the zk seam (planning is
 *  hermes-internal). Idempotent via the planning dedup strategies (append-once;
 *  content updates are ticket 09). Returns the # of planning cards mirrored. */
async function mirrorPlanningToStore(
  planningFiles: string[],
  memoryDir?: string,
): Promise<{ planningMirrored: number }> {
  if (planningFiles.length === 0) return { planningMirrored: 0 };
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let planningMirrored = 0;
  try {
    for (const abs of planningFiles) {
      const kind = planningCardKindFromPath(abs);
      if (!kind) continue;
      let bytes = "";
      try {
        bytes = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const serializer = store.serializerFor(kind);
      const cards = serializer ? serializer.deserialize(bytes, { filePath: abs }) : [];
      for (const card of cards) {
        await store.upsertCard(card);
        planningMirrored++;
      }
    }
  } finally {
    await store.close();
  }
  return { planningMirrored };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: PASS (the new planning test + existing walk tests).

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run typecheck && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/knowledge-walk.ts bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): walkAndIngest planning family + seam-independent mirror (08-impl T6)"
```

**DoD:** `walkAndIngest(<root with .planning/>)` mirrors planning-effort + planning-ticket cards into the store with NO zk seam; `receipt.planningMirrored` populated; existing knowledge walk tests unchanged.

---

## Notes for the implementer

- `<WT>` = the repo worktree root. All `git -C <WT>` and `( cd ... )` calls use it.
- **Memory/user/failure/knowledge cards never regress** is the master invariant: T1–T4 are additive; T5's CHECK widen is idempotent (skips when 'planning-ticket' present) and its migration carries the FULL column set; T5's upsert change keeps memory kinds on their existing MemoryStore path (the `persistableKinds` guard throws for them, same as before); T6's planning mirror is a no-op when `.planning/` is absent and runs independent of the knowledge path. If any non-planning test breaks at a boundary, STOP and fix.
- **No wayfind import.** The planning serializers parse `.planning` md directly (the format is the contract), mirroring `KnowledgeSerializer`. Parity with wayfind `parseTicketFile`/`readMap` is by format, not code — this avoids a hermes↔wayfind dependency cycle (wayfind will consume hermes via the typed seam later, not a direct import).
- **Id scheme is global.** `Card.id` maps to `memories.md_id`, which `getCard` queries across ALL targets — hence the `planning-effort:` / `planning-ticket:` prefixes (memory ids are timestamps/hashes; knowledge ids are zettel ids; no collision).
- **08 is read-only into the store.** No `.planning` writes, no staleness refresh, no sync — those are tickets 09/10. The graph edges (blocked-by + cited paths) are EMITTED here for 10 to consume.
- **T6 absolute-input requirement.** The planning classifier keys off the `.planning` segment in the walked path; invoke `walkAndIngest` with the repo root (or an ancestor of `.planning/`) as the input so rel paths retain `.planning/`. The `knowledge_ingest` tool already does this.