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
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffort, effortStatus, makeWayfindEffortTool, validateEffort } from "../src/effort-tool.js";
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
    for (const canary of ["SECRETQ1-alpha", "SECRETW2-bravo", "SECRETA3-charlie", "SECRETR4-delta", "round-trips a row", "went with sqlite"]) {
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
