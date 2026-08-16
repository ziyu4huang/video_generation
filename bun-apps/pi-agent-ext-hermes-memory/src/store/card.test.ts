import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { Card, CardKind, CardGraph } from "./card.js";

describe("Card model", () => {
  it("CardKind includes the 3 memory targets + knowledge", () => {
    const kinds: CardKind[] = ["memory", "user", "failure", "knowledge"];
    assert.deepEqual([...new Set(kinds)].sort(), ["failure", "knowledge", "memory", "user"]);
  });
  it("a knowledge Card satisfies the Card type", () => {
    const c: Card = {
      id: "ltx:cfg-scale-7-lever",
      kind: "knowledge",
      content: "LTX prefers cfg-scale 7 for …",
      frontmatter: { id: "ltx:cfg-scale-7-lever", record_type: "lever", status: "active" },
      graph: { links: ["ltx:cfg-scale-baseline"], entities: [{ type: "param", name: "cfg-scale" }] },
    };
    assert.equal(c.kind, "knowledge");
  });
  it("a memory Card omits optional graph", () => {
    const c: Card = { id: "mem-uuid", kind: "memory", content: "x", frontmatter: { id: "mem-uuid" } };
    assert.equal(c.graph, undefined);
  });
});
