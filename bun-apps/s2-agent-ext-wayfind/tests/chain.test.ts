import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan } from "../../s2-agent-ext-task/src/plan/parse.ts";
import { flattenTicketsToPlan, seedFromDecisions, syncChainState } from "../src/chain.js";
import { PLAN_PHASES_KEY } from "../src/constants.js";
import { buildPlanSeed, type GlossaryTerm, type ResolvedDecision } from "../src/grill.js";
import { readMap, writeMap, writeTicket } from "../src/map.js";
import type { Ticket } from "../src/model.js";

function mk(id: string, slug: string, title: string, blocking: string[] = [], opts: Partial<Ticket> = {}): Ticket {
  return { id, slug, title, question: "q", type: "task", blocking, status: "open", ...opts };
}

describe("flattenTicketsToPlan", () => {
  it("emits Tasks in topo (blocking) order with [stem] headers + glossary", () => {
    // 03 blocked-by 02, 02 blocked-by 01 → topo order 01, 02, 03 (NOT input order).
    const tickets = [
      mk("03", "gamma", "Gamma", ["02"]),
      mk("01", "alpha", "Alpha", []),
      mk("02", "beta", "Beta", ["01"]),
    ];
    const glossary: GlossaryTerm[] = [{ term: "Foo", definition: "a foo" }];

    const plan = flattenTicketsToPlan(tickets, glossary);

    expect(plan).toMatch(/^### Task 1 — \[01-alpha\] Alpha$/m);
    expect(plan).toMatch(/^### Task 2 — \[02-beta\] Beta$/m);
    expect(plan).toMatch(/^### Task 3 — \[03-gamma\] Gamma$/m);
    expect(plan).not.toContain("**Status:**");
    expect(plan).toContain("## Settled vocabulary");
    expect(plan).toContain("**Foo**: a foo");
    // headers come out in topo order, not input order
    expect(plan.indexOf("[01-alpha]")).toBeLessThan(plan.indexOf("[02-beta]"));
    expect(plan.indexOf("[02-beta]")).toBeLessThan(plan.indexOf("[03-gamma]"));
  });

  it("carries a ticket's acceptance criteria as `- [ ]` steps when present", () => {
    const tickets = [mk("01", "a", "Alpha", [], { acceptance: ["criterion 1", "criterion 2"] })];
    const plan = flattenTicketsToPlan(tickets, []);
    expect(plan).toContain("- [ ] criterion 1");
    expect(plan).toContain("- [ ] criterion 2");
  });

  it("emits a frontier ticket (no blocking) as Task 1", () => {
    const plan = flattenTicketsToPlan([mk("07", "solo", "Solo", [])], []);
    expect(plan).toMatch(/^### Task 1 — \[07-solo\] Solo$/m);
  });

  it("omits the glossary section when there are no terms", () => {
    const plan = flattenTicketsToPlan([mk("01", "a", "A", [])], []);
    expect(plan).not.toContain("## Settled vocabulary");
  });
});

describe("seedFromDecisions", () => {
  it("emits one Task per decision (in order) with glossary", () => {
    const decisions: ResolvedDecision[] = [
      { title: "Use Postgres", answer: "over SQLite for concurrency" },
      { title: "REST API", answer: "not GraphQL" },
    ];
    const glossary: GlossaryTerm[] = [{ term: "Order", definition: "a purchase request" }];

    const plan = seedFromDecisions(decisions, glossary);

    expect(plan).toContain("### Task 1");
    expect(plan).toContain("### Task 2");
    expect(plan).toContain("Use Postgres");
    expect(plan).toContain("REST API");
    expect(plan).toContain("## Settled vocabulary");
    expect(plan).toContain("**Order**: a purchase request");
    expect(plan).not.toContain("**Status:**");
  });

  it("works with no glossary (omits the section)", () => {
    const plan = seedFromDecisions([{ title: "Only decision", answer: "yes" }], []);
    expect(plan).toContain("### Task 1");
    expect(plan).not.toContain("## Settled vocabulary");
  });
});

// ─── end-to-end: the loop's two halves compose (forward + reverse) ───────────
describe("continuous chain loop — end-to-end toy effort", () => {
  const PHASES_KEY = "__piPlanPhases";
  const roots: string[] = [];
  function makeCwd(): string {
    const c = mkdtempSync(join(tmpdir(), "wf-e2e-"));
    roots.push(c);
    return c;
  }
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[PHASES_KEY];
    while (roots.length > 0) {
      const r = roots.pop();
      if (r) rmSync(r, { recursive: true, force: true });
    }
  });

  it("ticket → flatten → task_plan.md → (Task completes) → syncChainState closes the ticket", () => {
    const cwd = makeCwd();
    const effort = "orders";
    writeMap(cwd, {
      effort,
      destination: "ship the orders service",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    });
    writeTicket(cwd, effort, {
      id: "01",
      slug: "storage",
      title: "Pick storage",
      question: "which db?",
      type: "task",
      blocking: [],
      status: "open",
      whatToBuild: "a storage layer",
      acceptance: ["migration runs green"],
    });

    // FORWARD: flatten the ticket into a plan body (what /plan-seed writes).
    const map = readMap(cwd, effort);
    const plan = flattenTicketsToPlan(map?.tickets ?? [], []);
    expect(plan).toMatch(/### Task 1 — \[01-storage\] Pick storage/);
    expect(plan).toContain("- [ ] migration runs green");

    // Simulate the plan coordinator: the phase is now complete and exposes the ticket stem
    // (exactly what readPlanPhases publishes on globalThis.__piPlanPhases).
    (globalThis as Record<string, unknown>)[PHASES_KEY] = () => [
      { id: "1", status: "completed", ticketIds: ["01-storage"] },
    ];

    // REVERSE: syncChainState closes the originating ticket.
    const r = syncChainState(cwd, effort);
    expect(r.closed).toEqual(["01-storage"]);
    expect(readMap(cwd, effort)?.tickets.find((t) => t.id === "01")?.status).toBe("closed");
  });

  it("writing-plans plan (real ext-task parsePlan) → __piPlanPhases → syncChainState closes the ticket", () => {
    // Proves the cross-package contract with the REAL publisher output (status
    // "completed" + stem ticketIds), not a hand-written mock. Guards the seam
    // against drift that isolated mock tests miss (the TB6 status-token bug).
    const cwd = makeCwd();
    const effort = "e2e";
    writeMap(cwd, { effort, destination: "d", notes: "", decisions: [], fog: [], outOfScope: [], tickets: [] });
    writeTicket(cwd, effort, {
      id: "03",
      slug: "foo",
      title: "Foo",
      question: "q",
      type: "task",
      blocking: [],
      status: "open",
      whatToBuild: "b",
      acceptance: ["done"],
    });

    // A writing-plans doc: Task header references ticket [03-foo], checkbox done.
    const phases = parsePlan("### Task 1: [03-foo] Foo\n- [x] done\n", "<e2e>").phases;
    expect(phases[0]?.status).toBe("completed"); // the canonical token
    expect(phases[0]?.ticketIds).toEqual(["03-foo"]); // stem, matches findTicketByRef
    (globalThis as Record<string, unknown>)[PHASES_KEY] = () => phases;

    const r = syncChainState(cwd, effort);
    expect(r.closed).toEqual(["03-foo"]);
    expect(readMap(cwd, effort)?.tickets.find((t) => t.id === "03")?.status).toBe("closed");
  });

  it("flattenTicketsToPlan output feeds parsePlan — wayfind-GENERATED plans enter the loop (ticket 08)", () => {
    // The TB6 e2e above used a hand-written Task string; this proves the REAL
    // wayfind producer (flattenTicketsToPlan, now writing-plans format) parses
    // into the phases/ticketIds/status the close loop needs.
    const plan = flattenTicketsToPlan([mk("03", "foo", "Foo", [], { acceptance: ["step one", "step two"] })], []);
    const parsed = parsePlan(plan, "<wayfind-seed>").phases;

    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("task-1");
    expect(parsed[0].ticketIds).toEqual(["03-foo"]);
    expect(parsed[0].status).toBe("pending");
    expect(parsed[0].stepCount).toBe(2);
    expect(parsed[0].completedSteps).toBe(0);

    // Both steps checked → completed → close-loop fires.
    const completed = parsePlan(plan.replaceAll("- [ ]", "- [x]"), "<wayfind-seed>").phases;
    expect(completed[0].status).toBe("completed");
  });
});

// ─── plan-seed contract (merged from plan-seed-contract.test.ts 2026-08-22) ──
// The output shape `buildPlanSeed` MUST emit so the plan coordinator's
// `parsePlan` (writing-plans format) recognizes the seed. Pins the exact tokens
// parsePlan keys on (see s2-agent-ext-task/src/plan/parse.ts):
//   - Task heading regex: `/^###\s+Task\s+(\d+)/`  →  needs `### Task N`
//   - step regex:         `/^-\s+\[(x| )\]/`        →  needs `- [ ]`
//   - status: DERIVED from step completion — there is NO `**Status:**` token
// (the legacy phase-spine `**Status:** pending` is GONE — ticket 08).
const SEED_DECISIONS = [
  { title: "Where does relay live?", answer: "New `video relay` subcommand." },
  { title: "Failure mode", answer: "Keep the image; do not roll back." },
];
const SEED_GLOSSARY = [
  { term: "Relay", definition: "t2i → i2v → upscale chain in one manifest." },
  { term: "Manifest", definition: "JSONL run.py writes per generation." },
];

describe("PLAN_PHASES_KEY — the reverse-seam contract string", () => {
  it("is exported and equals the globalThis key syncChainState reads", () => {
    // This literal MUST match the one the plan coordinator publishes on globalThis
    // (the reader syncChainState closes tickets against). Pins wayfind's half of
    // the reverse seam (ADR-wayfind-0003). Coordinator now built as s2-agent-ext-task.
    expect(PLAN_PHASES_KEY).toBe("__piPlanPhases");
    expect(typeof PLAN_PHASES_KEY).toBe("string");
    expect(PLAN_PHASES_KEY.length).toBeGreaterThan(0);
  });
});

describe("buildPlanSeed — output tokens parsePlan depends on (writing-plans format)", () => {
  it("emits the writing-plans H1 + inline **Goal:**", () => {
    const seed = buildPlanSeed(SEED_DECISIONS, SEED_GLOSSARY, "add a video relay subcommand");
    expect(seed).not.toBeNull();
    expect(seed).toContain("# Implementation Plan");
    expect(seed).toMatch(/^\*\*Goal:\*\*/m);
  });

  it("emits a `### Task N` heading — the exact token parsePlan's TASK_HEADER_RE matches", () => {
    // parse.ts: TASK_HEADER_RE = /^###\s+Task\s+(\d+)\s*[:—-]?\s*(.*)$/
    // Without a `### Task` line, parsePlan sees zero phases → silent handoff break.
    const seed = buildPlanSeed(SEED_DECISIONS, [], "topic");
    expect(seed).not.toBeNull();
    const taskHeadings = seed?.match(/^###\s+Task\s+\d+/gim) ?? [];
    expect(taskHeadings.length).toBeGreaterThanOrEqual(1);
  });

  it("emits NO `**Status:**` token — status is derived from `- [ ]` step completion", () => {
    // parse.ts derives status from step completion; the legacy `**Status:** pending`
    // is removed (ticket 08). Its presence — or the removed `## Phases` /
    // `## Current Phase` sections — would be a regression to the old format.
    const seed = buildPlanSeed(SEED_DECISIONS, [], "topic");
    expect(seed).not.toBeNull();
    expect(seed).not.toContain("**Status:**");
    expect(seed).not.toContain("## Phases");
    expect(seed).not.toContain("## Current Phase");
  });

  it("carries the resolved glossary into the seed (the grill's domain artifacts survive handoff)", () => {
    const seed = buildPlanSeed([], SEED_GLOSSARY, "topic");
    expect(seed).not.toBeNull();
    expect(seed).toContain("**Relay**");
    expect(seed).toContain("t2i → i2v → upscale");
    expect(seed).toContain("**Manifest**");
  });

  it("carries every resolved decision as an actionable step under a Task", () => {
    const seed = buildPlanSeed(SEED_DECISIONS, [], "topic");
    expect(seed).not.toBeNull();
    for (const d of SEED_DECISIONS) {
      expect(seed).toContain(d.title);
      expect(seed).toContain(d.answer);
    }
  });
});
