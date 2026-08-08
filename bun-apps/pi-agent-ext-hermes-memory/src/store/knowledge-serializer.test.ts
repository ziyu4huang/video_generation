import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeSerializer } from "./knowledge-serializer.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "__fixtures__/knowledge-card.md"), "utf8");

describe("KnowledgeSerializer (read vault-md)", () => {
  const ser = new KnowledgeSerializer();
  it("kind === knowledge", () => assert.equal(ser.kind, "knowledge"));
  it("deserialize a valid zettel → 1 Card", () => {
    const cards = ser.deserialize(fixture, { filePath: "Zettelkasten/knowledge-graph/ltx-cfg-scale-7-lever.md" });
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.equal(c.kind, "knowledge");
    assert.equal(c.id, "ltx:cfg-scale-7-lever");
    assert.match(c.content, /prefers cfg-scale 7/);            // ## 核心想法 body
    assert.equal(c.frontmatter.record_type, "lever");
    assert.equal(c.frontmatter.status, "active");
    assert.equal(c.frontmatter.confidence, 0.93);
  });
  it("parses wiki-links into graph.links", () => {
    const [c] = ser.deserialize(fixture);
    assert.deepEqual(c!.graph?.links, ["ltx:cfg-scale-baseline"]);
  });
  it("parses typed entities frontmatter into graph.entities", () => {
    const [c] = ser.deserialize(fixture);
    assert.deepEqual(c!.graph?.entities, [{ type: "param", name: "cfg-scale" }, { type: "model", name: "ltx-video" }]);
  });
  it("returns [] for a non-zettel file (does not throw)", () => {
    assert.deepEqual(ser.deserialize("# just a heading\n\nno frontmatter"), []);
    assert.deepEqual(ser.deserialize("---\nid: x\n---\nbody"), []); // tags[0] != zettel
  });
  it("serialize round-trips the Card body-preserving (store does not call this in 06a)", () => {
    const [c] = ser.deserialize(fixture);
    const out = ser.serialize(c!);
    assert.match(out, /id: ltx:cfg-scale-7-lever/);
    assert.match(out, /cfg-scale 7 is the LTX sweet spot/);
  });
});
