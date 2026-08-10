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
