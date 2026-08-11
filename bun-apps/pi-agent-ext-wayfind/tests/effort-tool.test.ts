/**
 * Layer-2 tests — the `wayfind_effort` tool (one tool, action: create|validate|status).
 *
 * Layer 1 landed the EffortMeta model + parsers + validateEffortMap. Layer 2
 * wraps them in a bare agent tool: create scaffolds an effort dir WITH a
 * front-matter manifest; validate runs the conformance check; status returns a
 * compact read-only summary. No steering messages, no LLM orchestration — the
 * agent calls the raw operation and gets structured `details` back.
 *
 * The cwd-based ops (createEffort / validateEffort / effortStatus) are exercised
 * directly against a mkdtemp sandbox (real fs — no mocks); the tool wrapper is
 * driven through execute() with a minimal { cwd } ctx stub, the same seam a real
 * pi session uses.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffortListResult } from "../src/effort-query.js";
import type { EffortStatusResult, EffortStatusTicket } from "../src/effort-tool.js";
import {
  createEffort,
  effortStatus,
  makeWayfindEffortTool,
  renderList,
  renderStatus,
  validateEffort,
} from "../src/effort-tool.js";
import { readMap, writeTicket } from "../src/map.js";
import type { EffortMeta } from "../src/model.js";
import { addTicket, resolveTicket } from "../src/wayfinder.js";

const fresh = () => mkdtempSync(join(tmpdir(), "wf-effort-tool-"));
const mapPath = (cwd: string, effort: string) => join(cwd, ".planning", effort, "map.md");

// ─── createEffort ────────────────────────────────────────────────────────────

describe("createEffort", () => {
  it("writes map.md with a front-matter manifest (effort/created/last/status:active) + tickets dir", () => {
    const cwd = fresh();
    const r = createEffort(cwd, { effort: "2026-08-02-demo", destination: "ship the tool" });

    expect(r.ok).toBe(true);
    expect(r.existed).toBe(false);
    expect(r.effort).toBe("2026-08-02-demo");
    expect(r.path).toBe(".planning/2026-08-02-demo/map.md");

    const onDisk = readFileSync(mapPath(cwd, "2026-08-02-demo"), "utf-8");
    expect(onDisk.startsWith("---\n")).toBe(true); // front-matter first
    expect(onDisk).toContain("effort: 2026-08-02-demo");
    expect(onDisk).toContain("status: active");
    expect(onDisk).toContain("## Destination");
    expect(onDisk).toContain("ship the tool");
    // tickets dir is scaffolded so charting can drop tickets without a mkdir
    expect(existsSync(join(cwd, ".planning", "2026-08-02-demo", "tickets"))).toBe(true);

    // the returned meta round-trips through readMap
    const expectedMeta: EffortMeta = { effort: "2026-08-02-demo", status: "active" };
    expect(r.meta?.effort).toBe(expectedMeta.effort);
    expect(r.meta?.status).toBe("active");
    expect(readMap(cwd, "2026-08-02-demo")?.meta?.status).toBe("active");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("defaults the manifest status to 'active'", () => {
    const cwd = fresh();
    createEffort(cwd, { effort: "x", destination: "d" });
    expect(readMap(cwd, "x")?.meta?.status).toBe("active");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses (ok:false, existed:true) when the map already exists — and leaves the file unchanged", () => {
    const cwd = fresh();
    createEffort(cwd, { effort: "dup", destination: "ORIGINAL" });

    const r = createEffort(cwd, { effort: "dup", destination: "SHOULD NOT WIN" });
    expect(r.ok).toBe(false);
    expect(r.existed).toBe(true);

    // the second create must NOT have clobbered the original destination
    const onDisk = readFileSync(mapPath(cwd, "dup"), "utf-8");
    expect(onDisk).toContain("ORIGINAL");
    expect(onDisk).not.toContain("SHOULD NOT WIN");
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── validateEffort ──────────────────────────────────────────────────────────

describe("validateEffort", () => {
  it("is ok on a freshly createEffort'd map (manifest + Destination present)", () => {
    const cwd = fresh();
    createEffort(cwd, { effort: "v", destination: "conforming" });
    const r = validateEffort(cwd, "v");
    expect(r.ok).toBe(true);
    expect(r.exists).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.meta?.status).toBe("active");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("flags a hand-written legacy map whose ## Destination is missing (the original failure mode)", () => {
    const cwd = fresh();
    const dir = join(cwd, ".planning", "legacy", "tickets");
    mkdirSync(dir, { recursive: true });
    // non-conforming: has a body but NO ## Destination section
    writeFileSync(
      mapPath(cwd, "legacy"),
      ["# Wayfinder map: legacy", "", "## Notes", "", "some notes"].join("\n"),
      "utf-8",
    );
    const r = validateEffort(cwd, "legacy");
    expect(r.ok).toBe(false);
    expect(r.exists).toBe(true);
    expect(r.problems.some((p) => p.toLowerCase().includes("destination"))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("flags a front-matter effort that does not match its folder effort", () => {
    const cwd = fresh();
    const dir = join(cwd, ".planning", "real-folder", "tickets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      mapPath(cwd, "real-folder"),
      [
        "---",
        "effort: DIFFERENT-folder",
        "status: active",
        "---",
        "",
        "# Wayfinder map: real-folder",
        "",
        "## Destination",
        "",
        "d",
      ].join("\n"),
      "utf-8",
    );
    const r = validateEffort(cwd, "real-folder");
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.toLowerCase().includes("effort"))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reports exists:false when there is no map at all", () => {
    const cwd = fresh();
    const r = validateEffort(cwd, "ghost");
    expect(r.ok).toBe(false);
    expect(r.exists).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── effortStatus ────────────────────────────────────────────────────────────

describe("effortStatus", () => {
  it("returns ok:false when there is no map", () => {
    const cwd = fresh();
    const r = effortStatus(cwd, "nope");
    expect(r.ok).toBe(false);
    expect(r.exists).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns manifest + ticket counts + frontier on a populated effort", () => {
    const cwd = fresh();
    createEffort(cwd, { effort: "pop", destination: "d" });
    addTicket(cwd, "pop", "First decision", "what storage?");
    addTicket(cwd, "pop", "Second decision", "what ui?"); // both open, unblocked, unclaimed
    resolveTicket(cwd, "pop", "01", "use sqlite"); // close #1

    const r = effortStatus(cwd, "pop");
    expect(r.ok).toBe(true);
    expect(r.exists).toBe(true);
    expect(r.meta?.status).toBe("active");
    expect(r.open).toBe(1); // #2 still open
    expect(r.closed).toBe(1); // #1 resolved
    expect(r.claimed).toBe(0);
    expect(r.frontier.length).toBe(1); // only #2 on the frontier
    expect(r.frontier[0]?.id).toBe("02");
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── effortStatus: budget-bounded low-res ticket inventory (#455) ────────────
//
// Failure memory #455: subagents reading whole map.md / ticket files verbatim
// exhausted token budgets (3×: 100k, 110k, timeout). The `status` action is the
// agent-callable low-res view (the interactive `/wayfind status` is unavailable
// to subagents). It MUST surface a per-ticket inventory {id,title,status,blocking}
// and MUST NOT leak verbatim bodies (Question / What-to-build / Acceptance /
// Resolution) — that is the whole point of being budget-bounded.

describe("effortStatus — low-res ticket inventory (status action, #455)", () => {
  const ctx = (cwd: string) => ({ cwd }) as any;

  it("returns a per-ticket inventory {id,title,status,blocking} with NO verbatim bodies", async () => {
    const cwd = fresh();
    createEffort(cwd, { effort: "inv", destination: "d" });
    // Ticket 01 carries rich bodies (Question / What-to-build / Acceptance) with
    // distinctive canary phrases; resolving it later adds a Resolution body too.
    writeTicket(cwd, "inv", {
      id: "01",
      slug: "pick-storage",
      title: "Pick storage",
      question: "SECRETQ1-alpha which store fits?",
      type: "task",
      blocking: [],
      status: "open",
      whatToBuild: "SECRETW2-bravo the storage layer end to end.",
      acceptance: ["SECRETA3-charlie round-trips a row"],
    });
    writeTicket(cwd, "inv", {
      id: "02",
      slug: "wire-ui",
      title: "Wire UI",
      question: "how do we surface it?",
      type: "task",
      blocking: ["01"],
      status: "open",
    });
    resolveTicket(cwd, "inv", "01", "SECRETR4-delta went with sqlite"); // closes #1, adds resolution body

    const r = effortStatus(cwd, "inv");
    expect(r.ok).toBe(true);
    expect(r.exists).toBe(true);
    expect(r.tickets.length).toBe(2);

    // Per-ticket shape is EXACTLY {id,title,status,blocking} — no body fields.
    for (const t of r.tickets) {
      expect(Object.keys(t).sort()).toEqual(["blocking", "id", "status", "title"]);
    }

    // The inventory carries status + blocking edges (the point of the view).
    const byId = Object.fromEntries(r.tickets.map((t) => [t.id, t]));
    expect(byId["01"].status).toBe("closed");
    expect(byId["01"].blocking).toEqual([]);
    expect(byId["02"].status).toBe("open");
    expect(byId["02"].blocking).toEqual(["01"]);

    // NO verbatim body leak — check BOTH structured details and rendered content.
    const tool = makeWayfindEffortTool();
    const out = await tool.execute("s3", { action: "status", effort: "inv" }, undefined, undefined, ctx(cwd));
    const contentText = out.content[0]?.text ?? "";
    const blob = `${JSON.stringify(r)}\n${contentText}`;
    for (const canary of [
      "SECRETQ1-alpha",
      "SECRETW2-bravo",
      "SECRETA3-charlie",
      "SECRETR4-delta",
      "round-trips a row",
      "went with sqlite",
    ]) {
      expect(blob).not.toContain(canary);
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns tickets:[] on an empty effort (map present, no ticket files)", () => {
    const cwd = fresh();
    createEffort(cwd, { effort: "empty", destination: "d" });
    const r = effortStatus(cwd, "empty");
    expect(r.ok).toBe(true);
    expect(r.exists).toBe(true);
    expect(r.tickets).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns ok:false with tickets:[] when the effort is missing (graceful, matches the missing-effort idiom)", () => {
    const cwd = fresh();
    const r = effortStatus(cwd, "ghost");
    expect(r.ok).toBe(false);
    expect(r.exists).toBe(false);
    expect(r.tickets).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── makeWayfindEffortTool ───────────────────────────────────────────────────

describe("makeWayfindEffortTool", () => {
  const ctx = (cwd: string) => ({ cwd }) as any;

  it("is named 'wayfind_effort'", () => {
    expect(makeWayfindEffortTool().name).toBe("wayfind_effort");
  });

  it("create writes the manifest map; create again refuses; validate + status pass", async () => {
    const cwd = fresh();
    const tool = makeWayfindEffortTool();

    const created = await tool.execute(
      "c1",
      { action: "create", effort: "t", destination: "D" },
      undefined,
      undefined,
      ctx(cwd),
    );
    expect(created.details.ok).toBe(true);
    expect(created.details.existed).toBe(false);
    expect(created.content[0]?.text?.toLowerCase()).toContain("created");

    const dup = await tool.execute(
      "c2",
      { action: "create", effort: "t", destination: "OTHER" },
      undefined,
      undefined,
      ctx(cwd),
    );
    expect(dup.details.ok).toBe(false);
    expect(dup.details.existed).toBe(true);

    const valid = await tool.execute("v1", { action: "validate", effort: "t" }, undefined, undefined, ctx(cwd));
    expect(valid.details.ok).toBe(true);

    const stat = await tool.execute("s1", { action: "status", effort: "t" }, undefined, undefined, ctx(cwd));
    expect(stat.details.ok).toBe(true);
    expect(stat.details.open).toBe(0);

    rmSync(cwd, { recursive: true, force: true });
  });

  it("status on a missing effort is ok:false", async () => {
    const cwd = fresh();
    const tool = makeWayfindEffortTool();
    const stat = await tool.execute("s2", { action: "status", effort: "missing" }, undefined, undefined, ctx(cwd));
    expect(stat.details.ok).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── makeWayfindEffortTool — list + search actions (ticket 15 T3) ─────────────
//
// Phase 1 effort-query wired into the tool: action:'list' enumerates efforts;
// action:'search' runs cross-effort keyword search. The `effort` param becomes
// OPTIONAL (ignored by list; an optional scope filter for search; still REQUIRED
// for create/validate/status, which now guard and return ok:false when missing).
// Seeded sandbox mirrors tests/effort-query.test.ts: an effort "kg" with a
// SurrealDB ticket (closed), a grilling ticket (open), and a map decision.

/** Seed an effort "kg" with a SurrealDB ticket + a grilling ticket + a decision. */
function seedKgEffort(cwd: string): void {
  const dir = join(cwd, ".planning", "kg");
  mkdirSync(join(dir, "tickets"), { recursive: true });
  writeFileSync(
    join(dir, "map.md"),
    [
      "---",
      "effort: kg",
      "status: active",
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
      "<!-- none -->",
      "",
      "## Out of scope",
      "",
      "<!-- none -->",
      "",
    ].join("\n"),
    "utf-8",
  );
  // 01 — closed; title + resolution mention SurrealDB.
  writeFileSync(
    join(dir, "tickets", "01-embed-backend.md"),
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
    "utf-8",
  );
  // 02 — grilling-type, open; title + question mention SurrealDB.
  writeFileSync(
    join(dir, "tickets", "02-grill-storage.md"),
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
    "utf-8",
  );
}

/** Seed a second effort "other" whose destination also mentions SurrealDB so the
 *  effort filter has a cross-effort match to drop. */
function seedOtherEffort(cwd: string): void {
  const dir = join(cwd, ".planning", "other");
  mkdirSync(join(dir, "tickets"), { recursive: true });
  writeFileSync(
    join(dir, "map.md"),
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
      "Unrelated SurrealDB prototypes.",
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
    "utf-8",
  );
}

describe("makeWayfindEffortTool — list + search (ticket 15 T3)", () => {
  const ctx = (cwd: string) => ({ cwd }) as any;

  it("action 'list' returns ok + non-empty content + an efforts array", async () => {
    const cwd = fresh();
    seedKgEffort(cwd);
    const tool = makeWayfindEffortTool();

    const out = await tool.execute("l1", { action: "list" }, undefined, undefined, ctx(cwd));
    expect(out.details.ok).toBe(true);
    expect(Array.isArray(out.details.efforts)).toBe(true);
    expect(out.details.efforts.length).toBe(1);
    expect(out.details.efforts[0]?.slug).toBe("kg");
    expect((out.content[0]?.text ?? "").length).toBeGreaterThan(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("action 'list' reports 'No efforts found' on an empty .planning", async () => {
    const cwd = fresh();
    const tool = makeWayfindEffortTool();
    const out = await tool.execute("l2", { action: "list" }, undefined, undefined, ctx(cwd));
    expect(out.details.ok).toBe(true);
    expect(out.details.efforts).toEqual([]);
    expect((out.content[0]?.text ?? "").toLowerCase()).toContain("no efforts");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("action 'search' ranks the SurrealDB ticket #1", async () => {
    const cwd = fresh();
    seedKgEffort(cwd);
    const tool = makeWayfindEffortTool();

    const out = await tool.execute("s1", { action: "search", query: "surrealdb" }, undefined, undefined, ctx(cwd));
    expect(out.details.ok).toBe(true);
    expect(Array.isArray(out.details.matches)).toBe(true);
    expect(out.details.matches.length).toBeGreaterThan(0);
    expect(out.details.matches[0]?.title).toContain("SurrealDB");
    expect(out.details.matches[0]?.score).toBeGreaterThan(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("action 'search' with effort filter scopes matches to that effort", async () => {
    const cwd = fresh();
    seedKgEffort(cwd);
    seedOtherEffort(cwd); // would match "surrealdb" without the filter
    const tool = makeWayfindEffortTool();

    const out = await tool.execute(
      "s2",
      { action: "search", query: "surrealdb", effort: "kg" },
      undefined,
      undefined,
      ctx(cwd),
    );
    expect(out.details.ok).toBe(true);
    expect(out.details.matches.length).toBeGreaterThan(0);
    for (const m of out.details.matches) expect(m.effort).toBe("kg");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("action 'search' with statusFilter=open keeps only open tickets", async () => {
    const cwd = fresh();
    seedKgEffort(cwd);
    const tool = makeWayfindEffortTool();
    const out = await tool.execute(
      "s3",
      { action: "search", query: "surrealdb", statusFilter: "open" },
      undefined,
      undefined,
      ctx(cwd),
    );
    expect(out.details.ok).toBe(true);
    for (const m of out.details.matches) {
      expect(m.kind).toBe("ticket");
      expect(m.status).toBe("open");
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("action 'search' with typeFilter=grilling keeps only grilling tickets", async () => {
    const cwd = fresh();
    seedKgEffort(cwd);
    const tool = makeWayfindEffortTool();
    const out = await tool.execute(
      "s4",
      { action: "search", query: "surrealdb", typeFilter: "grilling" },
      undefined,
      undefined,
      ctx(cwd),
    );
    expect(out.details.ok).toBe(true);
    expect(out.details.matches.length).toBeGreaterThan(0);
    for (const m of out.details.matches) {
      expect(m.kind).toBe("ticket");
      expect(m.type).toBe("grilling");
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it("smoke: create then status still work and require effort (effort present path unchanged)", async () => {
    const cwd = fresh();
    const tool = makeWayfindEffortTool();

    const created = await tool.execute(
      "c1",
      { action: "create", effort: "demo", destination: "D" },
      undefined,
      undefined,
      ctx(cwd),
    );
    expect(created.details.ok).toBe(true);
    expect(created.details.existed).toBe(false);

    const stat = await tool.execute("s5", { action: "status", effort: "demo" }, undefined, undefined, ctx(cwd));
    expect(stat.details.ok).toBe(true);
    expect(stat.details.open).toBe(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("status WITHOUT effort returns ok:false (no throw)", async () => {
    const cwd = fresh();
    const tool = makeWayfindEffortTool();
    const stat = await tool.execute("s6", { action: "status" }, undefined, undefined, ctx(cwd));
    expect(stat.details.ok).toBe(false);
    expect((stat.content[0]?.text ?? "").toLowerCase()).toContain("effort");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("create WITHOUT effort returns ok:false (no throw)", async () => {
    const cwd = fresh();
    const tool = makeWayfindEffortTool();
    const r = await tool.execute("c2", { action: "create", destination: "D" }, undefined, undefined, ctx(cwd));
    expect(r.details.ok).toBe(false);
    expect((r.content[0]?.text ?? "").toLowerCase()).toContain("effort");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("validate WITHOUT effort returns ok:false (no throw)", async () => {
    const cwd = fresh();
    const tool = makeWayfindEffortTool();
    const r = await tool.execute("v2", { action: "validate" }, undefined, undefined, ctx(cwd));
    expect(r.details.ok).toBe(false);
    expect((r.content[0]?.text ?? "").toLowerCase()).toContain("effort");
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── 10-impl T9: stale read-side surfacing (effort status/list) ──────────────
//
// T9 enriches the read surfaces so staleness is VISIBLE early (the agent can
// re-grill proactively), complementing T8's graduation gate (which only BLOCKS
// at /wayfind done). Two layers are tested:
//   (a) the RENDER contract — renderStatus/renderList with a pre-populated
//       `stale` field (SYNC, no seam): undefined (hermes-absent / not enriched)
//       vs null vs 0 vs N, plus the per-ticket `⚠ stale` marker.
//   (b) the SEAM integration — the tool's async execute calls readStaleDecisions
//       (the T7 seam) via globalThis.__piHermesStaleCheck (the real seam path,
//       mirrors tests/stale-seam.test.ts + tests/wayfinder.test.ts): hermes
//       present → count + marker; hermes ABSENT → NO stale info, output
//       byte-identical to pre-T9 (null-safe, never crashes).
//
// Design (pinned in the plan): the SYNC pure fns (effortStatus/listEfforts)
// leave `stale` UNSET; the TOOL layer enriches it (async). When hermes is
// absent the tool leaves `stale` UNSET (undefined) — NOT null — so the renderer
// emits nothing and the output is byte-identical to pre-T9. The `null` render
// branch is preserved for explicit-null callers (defensive).

describe("renderStatus / renderList — stale render contract (10-impl T9)", () => {
  const baseStatus = (stale?: number | null): EffortStatusResult => ({
    ok: true,
    exists: true,
    effort: "e",
    destination: "d",
    meta: null,
    open: 0,
    closed: 1,
    claimed: 0,
    fog: 0,
    frontier: [],
    tickets: [],
    ...(stale === undefined ? {} : { stale }),
  });

  it("renderStatus: stale undefined (hermes absent / not enriched) -> NO stale line (byte-identical to pre-T9)", () => {
    const out = renderStatus(baseStatus(undefined));
    expect(out).not.toContain("stale:");
    expect(out).not.toContain("staleness:");
  });

  it("renderStatus: stale null -> 'staleness: unavailable'", () => {
    expect(renderStatus(baseStatus(null))).toContain("staleness: unavailable");
  });

  it("renderStatus: stale 0 -> 'stale: 0 (clean)'", () => {
    expect(renderStatus(baseStatus(0))).toContain("stale: 0 (clean)");
  });

  it("renderStatus: stale N>0 -> 'stale: N' + per-ticket '⚠ stale' marker", () => {
    const t: EffortStatusTicket = { id: "01", title: "decide", status: "closed", blocking: [], stale: true };
    const r: EffortStatusResult = { ...baseStatus(1), tickets: [t] };
    const out = renderStatus(r);
    expect(out).toContain("stale: 1");
    expect(out).toContain("⚠ stale"); // per-ticket marker
  });

  it("renderStatus: a non-stale ticket carries NO marker", () => {
    const r: EffortStatusResult = {
      ...baseStatus(1),
      tickets: [
        { id: "01", title: "stale one", status: "closed", blocking: [], stale: true },
        { id: "02", title: "fresh one", status: "open", blocking: ["01"] },
      ],
    };
    const out = renderStatus(r);
    const lines = out.split("\n");
    const line01 = lines.find((l) => l.trim().startsWith("01 "));
    const line02 = lines.find((l) => l.trim().startsWith("02 "));
    expect(line01).toContain("⚠ stale");
    expect(line02).not.toContain("⚠ stale");
  });

  it("renderList: stale undefined -> NO stale token (byte-identical to pre-T9)", () => {
    const r: EffortListResult = {
      ok: true,
      efforts: [
        {
          slug: "e",
          status: "active",
          destination: "d",
          ticketCounts: { open: 0, closed: 1, claimed: 0 },
          frontierSize: 0,
          fog: 0,
        },
      ],
    };
    expect(renderList(r)).not.toContain("stale=");
  });

  it("renderList: stale null vs 0 vs N rendered distinctly", () => {
    const base = (stale: number | null): EffortListResult => ({
      ok: true,
      efforts: [
        {
          slug: "e",
          status: "active",
          destination: "d",
          ticketCounts: { open: 0, closed: 1, claimed: 0 },
          frontierSize: 0,
          fog: 0,
          stale,
        },
      ],
    });
    expect(renderList(base(null))).toContain("stale=?");
    expect(renderList(base(0))).toContain("stale=0");
    expect(renderList(base(2))).toContain("stale=2");
  });
});

describe("wayfind_effort tool — stale seam integration (10-impl T9)", () => {
  const STALE_KEY = "__piHermesStaleCheck";
  const ctx = (cwd: string) => ({ cwd }) as any;

  /** Seed an effort "stale-eff" with two tickets: 01 (closed) + 02 (open, blocked-by 01). */
  const seedStaleEffort = (cwd: string): void => {
    createEffort(cwd, { effort: "stale-eff", destination: "d" });
    addTicket(cwd, "stale-eff", "Decision A", "which?", "task", []);
    addTicket(cwd, "stale-eff", "Decision B", "next?", "task", ["01"]);
    resolveTicket(cwd, "stale-eff", "01", "decided A"); // closes #1
  };

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[STALE_KEY];
  });

  it("status: hermes present + 1 stale -> 'stale: 1' count + marker on ticket 01 (NOT 02)", async () => {
    const cwd = fresh();
    seedStaleEffort(cwd);
    (globalThis as Record<string, unknown>)[STALE_KEY] = async () => ({
      stale: [{ cardId: "planning-ticket:stale-eff:01", effort: "stale-eff" }],
    });
    const tool = makeWayfindEffortTool();
    const out = await tool.execute("s1", { action: "status", effort: "stale-eff" }, undefined, undefined, ctx(cwd));
    const text = out.content[0]?.text ?? "";
    expect(text).toContain("stale: 1");
    const lines = text.split("\n");
    const line01 = lines.find((l) => l.trim().startsWith("01 "));
    const line02 = lines.find((l) => l.trim().startsWith("02 "));
    expect(line01).toContain("⚠ stale");
    expect(line02).not.toContain("⚠ stale");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("status: hermes present + empty -> 'stale: 0 (clean)' + NO marker", async () => {
    const cwd = fresh();
    seedStaleEffort(cwd);
    (globalThis as Record<string, unknown>)[STALE_KEY] = async () => ({ stale: [] });
    const tool = makeWayfindEffortTool();
    const out = await tool.execute("s2", { action: "status", effort: "stale-eff" }, undefined, undefined, ctx(cwd));
    const text = out.content[0]?.text ?? "";
    expect(text).toContain("stale: 0 (clean)");
    expect(text).not.toContain("⚠ stale");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("status: hermes ABSENT -> NO stale info, output byte-identical to pre-T9 (null-safe)", async () => {
    const cwd = fresh();
    seedStaleEffort(cwd);
    // NO seam published — readStaleDecisions returns null → tool leaves `stale`
    // UNSET → renderStatus emits NO stale line/marker → byte-identical to pre-T9.
    const tool = makeWayfindEffortTool();
    const out = await tool.execute("s3", { action: "status", effort: "stale-eff" }, undefined, undefined, ctx(cwd));
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("stale:");
    expect(text).not.toContain("staleness:");
    expect(text).not.toContain("⚠ stale");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("status: non-stale ticket -> exactly ONE marker (the join marks only the matched cardId)", async () => {
    const cwd = fresh();
    seedStaleEffort(cwd);
    (globalThis as Record<string, unknown>)[STALE_KEY] = async () => ({
      stale: [{ cardId: "planning-ticket:stale-eff:01", effort: "stale-eff" }],
    });
    const tool = makeWayfindEffortTool();
    const out = await tool.execute("s4", { action: "status", effort: "stale-eff" }, undefined, undefined, ctx(cwd));
    const text = out.content[0]?.text ?? "";
    expect(text.split("\n").filter((l) => l.includes("⚠ stale")).length).toBe(1);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("list: hermes present -> per-effort 'stale=1' token", async () => {
    const cwd = fresh();
    seedStaleEffort(cwd);
    (globalThis as Record<string, unknown>)[STALE_KEY] = async () => ({
      stale: [{ cardId: "planning-ticket:stale-eff:01", effort: "stale-eff" }],
    });
    const tool = makeWayfindEffortTool();
    const out = await tool.execute("l1", { action: "list" }, undefined, undefined, ctx(cwd));
    const text = out.content[0]?.text ?? "";
    expect(text).toContain("stale=1");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("list: hermes ABSENT -> NO stale token (byte-identical to pre-T9)", async () => {
    const cwd = fresh();
    seedStaleEffort(cwd);
    const tool = makeWayfindEffortTool();
    const out = await tool.execute("l2", { action: "list" }, undefined, undefined, ctx(cwd));
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("stale=");
    rmSync(cwd, { recursive: true, force: true });
  });
});
