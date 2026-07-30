import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseContradictionVerdict } from "../../src/handlers/contradiction-judge.js";

describe("parseContradictionVerdict", () => {
  it("parses a contradicted_id", () => {
    assert.deepEqual(parseContradictionVerdict('{"contradicted_id": 42, "reason": "says npm not pnpm"}'), { contradictedId: 42 });
  });
  it("parses null (no contradiction)", () => {
    assert.deepEqual(parseContradictionVerdict('{"contradicted_id": null, "reason": "none"}'), { contradictedId: null });
  });
  it("handles a fenced json block", () => {
    assert.deepEqual(parseContradictionVerdict('```json\n{"contradicted_id": 7}\n```'), { contradictedId: 7 });
  });
  it("returns null on malformed", () => {
    assert.strictEqual(parseContradictionVerdict("not json"), null);
    assert.strictEqual(parseContradictionVerdict('{"contradicted_id": "oops"}'), null); // non-number
  });
});
