/**
 * Effort-query Phase 1 — `list` action: `enumerateEfforts` + `listEfforts`.
 *
 * Real-fs harness (mkdtempSync sandbox — no mocks), matching the harness style
 * in tests/effort-tool.test.ts. Fixtures are written as raw on-disk markdown
 * in the EXACT format readMap / readEffortMeta / parseTicketFile expect
 * (front-matter with `effort:` so the manifest parses; `## Destination` /
 * `## Not yet specified` / `## Out of scope` sections; NN-slug.md tickets with
 * `type` / `status` / `claimed` / `blocking` front-matter).
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateEfforts, listEfforts, searchEfforts } from "../src/effort-query.js";

const fresh = () => mkdtempSync(join(tmpdir(), "wf-effort-query-"));
const planning = (cwd: string) => join(cwd, ".planning");

/** Seed a raw `map.md` under `.planning/<effort>/` (scaffolds the dir + tickets/). */
function seedMap(cwd: string, effort: string, body: string): void {
  const dir = join(planning(cwd), effort);
  mkdirSync(join(dir, "tickets"), { recursive: true });
  writeFileSync(join(dir, "map.md"), body, "utf-8");
}

/** Seed a raw `NN-slug.md` ticket under `.planning/<effort>/tickets/`. */
function seedTicket(cwd: string, effort: string, file: string, body: string): void {
  const dir = join(planning(cwd), effort, "tickets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body, "utf-8");
}

/** Build the canonical two-effort sandbox: effA (3 tickets) + effB (1 ticket). */
function seedTwoEfforts(cwd: string): void {
  seedMap(
    cwd,
    "effA",
    [
      "---",
      "effort: effA",
      "status: active",
      "last: 2026-08-01",
      "---",
      "",
      "# Wayfinder map: effA",
      "",
      "## Destination",
      "",
      "effA goal line",
      "",
      "## Notes",
      "",
      "notes for effA",
      "",
      "## Decisions so far",
      "",
      "<!-- none yet -->",
      "",
      "## Not yet specified",
      "",
      "- fog one",
      "- fog two",
      "",
      "## Out of scope",
      "",
      "<!-- none -->",
      "",
    ].join("\n"),
  );
  // 01 — open, unclaimed, no blocker  (frontier)
  seedTicket(
    cwd,
    "effA",
    "01-first-decision.md",
    [
      "---",
      "type: task",
      "status: open",
      "---",
      "",
      "# 01 — First decision",
      "",
      "## Question",
      "",
      "What storage do we pick first?",
      "",
    ].join("\n"),
  );
  // 02 — closed (resolution forces status closed)
  seedTicket(
    cwd,
    "effA",
    "02-storage-pick.md",
    [
      "---",
      "type: task",
      "status: closed",
      "---",
      "",
      "# 02 — Storage pick",
      "",
      "## Question",
      "",
      "Which storage?",
      "",
      "## Resolution",
      "",
      "We chose sqlite for now.",
      "",
    ].join("\n"),
  );
  // 03 — open, claimed, blocking 01  (NOT on frontier: claimed + has blocker)
  seedTicket(
    cwd,
    "effA",
    "03-wire-up.md",
    [
      "---",
      "type: task",
      "status: open",
      "claimed: alice",
      "blocking: 01",
      "---",
      "",
      "# 03 — Wire up",
      "",
      "## Question",
      "",
      "How do we wire the layers?",
      "",
    ].join("\n"),
  );

  seedMap(
    cwd,
    "effB",
    [
      "---",
      "effort: effB",
      "status: paused",
      "last: 2026-08-02",
      "---",
      "",
      "# Wayfinder map: effB",
      "",
      "## Destination",
      "",
      "effB goal",
      "",
      "## Notes",
      "",
      "notes effB",
      "",
      "## Decisions so far",
      "",
      "<!-- none yet -->",
      "",
      "## Not yet specified",
      "",
      "<!-- none -->",
      "",
      "## Out of scope",
      "",
      "<!-- none -->",
      "",
    ].join("\n"),
  );
  // 01 — open, unclaimed, no blocker
  seedTicket(
    cwd,
    "effB",
    "01-effb-first.md",
    [
      "---",
      "type: task",
      "status: open",
      "---",
      "",
      "# 01 — EffB first",
      "",
      "## Question",
      "",
      "EffB first question?",
      "",
    ].join("\n"),
  );
}

// ─── enumerateEfforts ────────────────────────────────────────────────────────

describe("enumerateEfforts", () => {
  it("lists effort dirs sorted ascending; ignores dotfile dirs and regular files", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);
    // dotfile dir + a regular file inside .planning — both must be ignored
    mkdirSync(join(planning(cwd), ".hidden"), { recursive: true });
    writeFileSync(join(planning(cwd), "README.md"), "ignore me", "utf-8");

    expect(enumerateEfforts(cwd)).toEqual(["effA", "effB"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns [] when .planning does not exist (throw-free)", () => {
    const cwd = fresh();
    expect(enumerateEfforts(cwd)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns [] when .planning exists but is empty (throw-free)", () => {
    const cwd = fresh();
    mkdirSync(planning(cwd), { recursive: true });
    expect(enumerateEfforts(cwd)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── listEfforts ─────────────────────────────────────────────────────────────

describe("listEfforts", () => {
  it("returns ok:true with slug-sorted per-effort summaries", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);

    const r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.efforts.length).toBe(2);
    expect(r.efforts.map((e) => e.slug)).toEqual(["effA", "effB"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("aggregates effA ticket counts + frontier + fog + status from the manifest", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);

    const r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    const effA = r.efforts.find((e) => e.slug === "effA");
    expect(effA).toBeDefined();

    // open: 01 + 03 ; closed: 02 ; claimed: 03 (open + claimed)
    expect(effA?.ticketCounts).toEqual({ open: 2, closed: 1, claimed: 1 });
    // frontier = open && !claimed && no blockers -> only 01
    expect(effA?.frontierSize).toBe(1);
    // seeded map has two fog bullets
    expect(effA?.fog).toBe(2);
    // status comes from the manifest front-matter
    expect(effA?.status).toBe("active");
    // destination round-trips from the map body
    expect(effA?.destination).toBe("effA goal line");
    // lastModified comes from the manifest `last:` field
    expect(effA?.lastModified).toBe("2026-08-01");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads effB status from the manifest (paused) and reports its counts", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);

    const r = listEfforts(cwd);
    const effB = r.efforts.find((e) => e.slug === "effB");
    expect(effB).toBeDefined();
    expect(effB?.status).toBe("paused");
    expect(effB?.ticketCounts).toEqual({ open: 1, closed: 0, claimed: 0 });
    expect(effB?.frontierSize).toBe(1);
    expect(effB?.fog).toBe(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns ok:true, efforts:[] on an empty .planning (throw-free)", () => {
    const cwd = fresh();
    // no .planning dir at all
    let r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    expect(r.efforts).toEqual([]);

    // empty .planning dir present
    mkdirSync(planning(cwd), { recursive: true });
    r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    expect(r.efforts).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("skips a bad effort without failing the whole list (throw-free, one bad dir)", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);
    // A dir that is NOT a valid effort (no map.md, no front-matter) — readMap
    // returns null so it yields an empty summary, but must not throw and must
    // not drop the well-formed efforts.
    mkdirSync(join(planning(cwd), "effC", "tickets"), { recursive: true });

    const r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    const slugs = r.efforts.map((e) => e.slug);
    expect(slugs).toContain("effA");
    expect(slugs).toContain("effB");
    expect(slugs).toContain("effC");
    const effC = r.efforts.find((e) => e.slug === "effC");
    expect(effC?.ticketCounts).toEqual({ open: 0, closed: 0, claimed: 0 });
    expect(effC?.frontierSize).toBe(0);
    expect(effC?.status).toBe("active"); // default when no manifest
    expect(effC?.destination).toBe("");
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── search fixture (Task 2) ───────────────────────────────────────
// Two efforts: "kg" (knowledge graph) carries the surrealdb ticket (closed,
// with a SurrealDB HNSW resolution), a grilling-type ticket, two identical-title
// tickets for the tie-break case, and a map decision whose gist mentions
// "knowledge graph". "other" has a graph-mentioning destination so the effort
// filter has something to drop.
function seedSearch(cwd: string): void {
  seedMap(
    cwd,
    "kg",
    [
      "---",
      "effort: kg",
      "status: active",
      "last: 2026-08-09",
      "---",
      "",
      "# Wayfinder map: kg",
      "",
      "## Destination",
      "",
      "Ship a knowledge graph memory layer over SurrealDB.",
      "",
      "## Notes",
      "",
      "Exploring HNSW recall.",
      "",
      "## Decisions so far",
      "",
      "- [Use knowledge graph core](tickets/05-graph-core.md) — Knowledge graph backs recall.",
      "",
      "## Not yet specified",
      "",
      "- fog one",
      "",
      "## Out of scope",
      "",
      "<!-- none -->",
      "",
    ].join("\n"),
  );
  // 01 — closed (resolution forces status closed); title + resolution mention SurrealDB.
  seedTicket(
    cwd,
    "kg",
    "01-embed-backend.md",
    [
      "---",
      "type: task",
      "status: closed",
      "---",
      "",
      "# Resolve embed backend (SurrealDB)",
      "",
      "## Question",
      "",
      "How do we store embeddings?",
      "",
      "## Resolution",
      "",
      "SurrealDB HNSW index gives sub-ms recall.",
      "",
    ].join("\n"),
  );
  // 02 — grilling-type, open; title + question mention SurrealDB, question mentions graph.
  seedTicket(
    cwd,
    "kg",
    "02-grill-storage.md",
    [
      "---",
      "type: grilling",
      "status: open",
      "---",
      "",
      "# Grill SurrealDB tradeoffs",
      "",
      "## Question",
      "",
      "Should SurrealDB be the store for the graph?",
      "",
    ].join("\n"),
  );
  // 03 / 04 — identical titles, equal score on query "duplicate" (tie-break by id asc).
  seedTicket(
    cwd,
    "kg",
    "03-dup.md",
    [
      "---",
      "type: task",
      "status: open",
      "---",
      "",
      "# Duplicate title",
      "",
      "## Question",
      "",
      "alpha widget",
      "",
    ].join("\n"),
  );
  seedTicket(
    cwd,
    "kg",
    "04-dup.md",
    [
      "---",
      "type: task",
      "status: open",
      "---",
      "",
      "# Duplicate title",
      "",
      "## Question",
      "",
      "beta widget",
      "",
    ].join("\n"),
  );

  seedMap(
    cwd,
    "other",
    [
      "---",
      "effort: other",
      "status: active",
      "---",
      "",
      "# Wayfinder map: other",
      "",
      "## Destination",
      "",
      "Unrelated graph prototypes.",
      "",
      "## Notes",
      "",
      "none",
      "",
      "## Decisions so far",
      "",
      "<!-- none yet -->",
      "",
      "## Not yet specified",
      "",
      "<!-- none -->",
      "",
      "## Out of scope",
      "",
      "<!-- none -->",
      "",
    ].join("\n"),
  );
}

// ─── searchEfforts ───────────────────────────────────────────────

describe("searchEfforts", () => {
  it("ranks a surrealdb ticket #1 with a body snippet containing the term", () => {
    const cwd = fresh();
    seedSearch(cwd);

    const r = searchEfforts(cwd, "surrealdb");
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.query).toBe("surrealdb");
    expect(r.matches.length).toBeGreaterThan(0);

    const top = r.matches[0];
    expect(top.kind).toBe("ticket");
    expect(top.title).toContain("SurrealDB");
    expect(top.score).toBeGreaterThan(0);
    expect(top.snippet.toLowerCase()).toContain("urrealdb");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("status=closed filter keeps only closed tickets (drops decisions)", () => {
    const cwd = fresh();
    seedSearch(cwd);

    const r = searchEfforts(cwd, "surrealdb", { status: "closed" });
    expect(r.ok).toBe(true);
    expect(r.filters.status).toBe("closed");
    expect(r.matches.length).toBeGreaterThan(0);
    for (const m of r.matches) {
      expect(m.kind).toBe("ticket");
      expect(m.status).toBe("closed");
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("type=grilling filter keeps only grilling tickets (drops decisions)", () => {
    const cwd = fresh();
    seedSearch(cwd);

    const r = searchEfforts(cwd, "surrealdb", { type: "grilling" });
    expect(r.ok).toBe(true);
    expect(r.filters.type).toBe("grilling");
    expect(r.matches.length).toBeGreaterThan(0);
    for (const m of r.matches) {
      expect(m.kind).toBe("ticket");
      expect(m.type).toBe("grilling");
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("effort filter scopes to one effort and surfaces the decision match", () => {
    const cwd = fresh();
    seedSearch(cwd);

    const r = searchEfforts(cwd, "graph", { effort: "kg" });
    expect(r.ok).toBe(true);
    expect(r.filters.effort).toBe("kg");
    expect(r.matches.length).toBeGreaterThan(0);
    for (const m of r.matches) expect(m.effort).toBe("kg");
    // the "knowledge graph" map decision must appear
    expect(r.matches.some((m) => m.kind === "decision" && m.title.includes("knowledge graph"))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("breaks equal-score ties deterministically (ticketId asc) across runs", () => {
    const cwd = fresh();
    seedSearch(cwd);

    const ids = () => searchEfforts(cwd, "duplicate").matches.map((m) => m.ticketId);
    const first = ids();
    const second = ids();
    expect(first).toEqual(["03", "04"]);
    expect(first).toEqual(second);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns ok:true, matches:[] for an empty query", () => {
    const cwd = fresh();
    seedSearch(cwd);

    const r = searchEfforts(cwd, "");
    expect(r.ok).toBe(true);
    expect(r.matches).toEqual([]);
    expect(r.truncated).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("truncates to limit and reports truncated when total > limit", () => {
    const cwd = fresh();
    seedSearch(cwd);

    const r = searchEfforts(cwd, "surrealdb", { limit: 1 });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.matches.length).toBe(1);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is throw-free on an unreadable root (ok:true, matches:[])", () => {
    const r = searchEfforts("/nonexistent-effort-query-root-xyz/cwd", "surrealdb");
    expect(r.ok).toBe(true);
    expect(r.matches).toEqual([]);
  });
});
