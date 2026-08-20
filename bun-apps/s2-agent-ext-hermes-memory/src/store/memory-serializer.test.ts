import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { MemorySerializer } from "./memory-serializer.js";
import { serializeMetadataFrontmatter, parseMetadataFrontmatter } from "./memory-format.js";
import { ENTRY_DELIMITER } from "../constants.js";
import type { Card } from "./card.js";

describe("MemorySerializer (extracted §-md)", () => {
  const ser = new MemorySerializer();

  it("serialize→deserialize is byte-identical to memory-format for one entry", () => {
    const card: Card = {
      id: "uuid-1", kind: "memory", content: "prefers MLX bf16",
      frontmatter: { id: "uuid-1", created: "2026-08-09", last: "2026-08-09" },
    };
    const frag = ser.serialize(card);
    const expected = serializeMetadataFrontmatter({ id: "uuid-1", text: "prefers MLX bf16", created: "2026-08-09", last: "2026-08-09" });
    assert.equal(frag, expected); // EXTRACT, not a rewrite
  });

  it("deserialize splits a multi-entry section-md file into N cards", () => {
    const file = [ser.serialize({ id: "a", kind: "memory", content: "one", frontmatter: { id: "a", created: "2026-08-09", last: "2026-08-09" } }),
                  ser.serialize({ id: "b", kind: "memory", content: "two", frontmatter: { id: "b", created: "2026-08-09", last: "2026-08-09" } })]
                  .join(ENTRY_DELIMITER);
    const cards = ser.deserialize(file);
    assert.equal(cards.length, 2);
    assert.equal(cards[0]!.id, "a");
    assert.equal(cards[1]!.id, "b");
    assert.equal(cards[0]!.kind, "memory");
  });

  it("preserves content + frontmatter through round-trip", () => {
    const card: Card = { id: "uuid-2", kind: "memory", content: "body text", frontmatter: { id: "uuid-2", created: "2026-08-09", last: "2026-08-09" } };
    const [back] = ser.deserialize(ser.serialize(card));
    assert.equal(back!.id, card.id);
    assert.equal(back!.content, card.content);
    assert.equal(back!.frontmatter.created, "2026-08-09");
  });

  it("kind === the constructor kind (memory/user/failure)", () => {
    assert.equal(new MemorySerializer("failure").kind, "failure");
    assert.equal(new MemorySerializer("user").kind, "user");
  });
});
