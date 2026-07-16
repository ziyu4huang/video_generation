import { describe, expect, it } from "bun:test";
import { flattenTicketsToPlan, seedFromDecisions } from "../src/chain.js";
import type { GlossaryTerm, ResolvedDecision } from "../src/grill.js";
import type { Ticket } from "../src/map.js";

function mk(id: string, slug: string, title: string, blocking: string[] = [], opts: Partial<Ticket> = {}): Ticket {
  return { id, slug, title, question: "q", type: "task", blocking, status: "open", ...opts };
}

describe("flattenTicketsToPlan", () => {
  it("emits phases in topo (blocking) order with [stem] headers + Status pending + glossary", () => {
    // 03 blocked-by 02, 02 blocked-by 01 → topo order 01, 02, 03 (NOT input order).
    const tickets = [
      mk("03", "gamma", "Gamma", ["02"]),
      mk("01", "alpha", "Alpha", []),
      mk("02", "beta", "Beta", ["01"]),
    ];
    const glossary: GlossaryTerm[] = [{ term: "Foo", definition: "a foo" }];

    const plan = flattenTicketsToPlan(tickets, glossary);

    expect(plan).toMatch(/^### Phase 1 — \[01-alpha\] Alpha$/m);
    expect(plan).toMatch(/^### Phase 2 — \[02-beta\] Beta$/m);
    expect(plan).toMatch(/^### Phase 3 — \[03-gamma\] Gamma$/m);
    expect((plan.match(/- \*\*Status:\*\* pending/g) ?? []).length).toBe(3);
    expect(plan).toContain("## Settled vocabulary");
    expect(plan).toContain("**Foo**: a foo");
    // headers come out in topo order, not input order
    expect(plan.indexOf("[01-alpha]")).toBeLessThan(plan.indexOf("[02-beta]"));
    expect(plan.indexOf("[02-beta]")).toBeLessThan(plan.indexOf("[03-gamma]"));
  });

  it("carries a ticket's acceptance criteria as phase checkboxes when present", () => {
    const tickets = [mk("01", "a", "Alpha", [], { acceptance: ["criterion 1", "criterion 2"] })];
    const plan = flattenTicketsToPlan(tickets, []);
    expect(plan).toContain("- [ ] criterion 1");
    expect(plan).toContain("- [ ] criterion 2");
  });

  it("emits a frontier ticket (no blocking) as Phase 1", () => {
    const plan = flattenTicketsToPlan([mk("07", "solo", "Solo", [])], []);
    expect(plan).toMatch(/^### Phase 1 — \[07-solo\] Solo$/m);
  });

  it("omits the glossary section when there are no terms", () => {
    const plan = flattenTicketsToPlan([mk("01", "a", "A", [])], []);
    expect(plan).not.toContain("## Settled vocabulary");
  });
});

describe("seedFromDecisions", () => {
  it("emits one phase per decision (in order) with glossary + Status pending", () => {
    const decisions: ResolvedDecision[] = [
      { title: "Use Postgres", answer: "over SQLite for concurrency" },
      { title: "REST API", answer: "not GraphQL" },
    ];
    const glossary: GlossaryTerm[] = [{ term: "Order", definition: "a purchase request" }];

    const plan = seedFromDecisions(decisions, glossary);

    expect(plan).toContain("### Phase 1");
    expect(plan).toContain("### Phase 2");
    expect(plan).toContain("Use Postgres");
    expect(plan).toContain("REST API");
    expect(plan).toContain("## Settled vocabulary");
    expect(plan).toContain("**Order**: a purchase request");
    expect((plan.match(/- \*\*Status:\*\* pending/g) ?? []).length).toBe(2);
  });

  it("works with no glossary (omits the section)", () => {
    const plan = seedFromDecisions([{ title: "Only decision", answer: "yes" }], []);
    expect(plan).toContain("### Phase 1");
    expect(plan).not.toContain("## Settled vocabulary");
  });
});
