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
