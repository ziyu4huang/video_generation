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

describe("KnowledgeSerializer relations (ticket 03 T4 — hybrid schema + write-back)", () => {
  const ser = new KnowledgeSerializer();
  /** A zettel whose frontmatter `relations:` carries a single edge with the
   *  given raw predicate. */
  const relCard = (rel: string): string => `---
id: t:rel
tags: [zettel, lever]
created: 2026-08-08
relations:
  - s: a
    rel: ${rel}
    o: b
---
# rel card

## 核心想法
body
`;

  it("canonicalizes a core-relation alias on read (ref → references)", () => {
    const [c] = ser.deserialize(relCard("ref"));
    assert.equal(c!.graph?.relations?.[0]?.rel, "references");
  });

  it("canonicalizes an underscore/space alias on read (depends_on → depends-on)", () => {
    const [c] = ser.deserialize(relCard("depends_on"));
    assert.equal(c!.graph?.relations?.[0]?.rel, "depends-on");
  });

  it("preserves a free-form relation unchanged on read (uses)", () => {
    const [c] = ser.deserialize(relCard("uses"));
    assert.equal(c!.graph?.relations?.[0]?.rel, "uses");
  });

  it("serialize() write-back emits the CANONICAL predicate, not the raw alias, and round-trips", () => {
    const [c] = ser.deserialize(relCard("ref"));
    const out = ser.serialize(c!);
    // write-back must emit the already-canonicalized-in-memory relations;
    // the raw alias "ref" must NOT be what lands in the persisted md.
    assert.match(out, /rel: references/);
    // ...and the round-trip survives re-deserialization with the canonical rel.
    const [c2] = ser.deserialize(out);
    assert.equal(c2!.graph?.relations?.[0]?.rel, "references");
  });

  it("serialize() adds no empty relations block when the card has none", () => {
    const [c] = ser.deserialize(fixture);
    const out = ser.serialize(c!);
    assert.doesNotMatch(out, /^relations:/m);
  });
});

describe("KnowledgeSerializer envelope dedup (fix-wave 03 FIX3 — graph.relations is the single truth)", () => {
  const ser = new KnowledgeSerializer();
  const relCard = `---
id: t:rel
created: 2026-08-08
tags: [zettel, lever]
relations:
  - s: a
    rel: ref
    o: b
---
# rel card

## 核心想法
body
`;

  it("deserialize drops the RAW relations from frontmatter (no envelope/graph duality)", () => {
    const [c] = ser.deserialize(relCard);
    // The raw envelope entry must be absent — persisting it alongside the
    // canonical graph.relations would leave the DB holding two versions.
    assert.ok(!("relations" in c!.frontmatter), "frontmatter.relations must be absent");
    // The canonical, normalized form lives ONLY on card.graph.relations.
    assert.equal(c!.graph?.relations?.[0]?.rel, "references");
  });
});
