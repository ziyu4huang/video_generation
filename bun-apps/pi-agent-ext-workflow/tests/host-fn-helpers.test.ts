import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { canonicalJSON, hashHostCall } from "../src/host-fn-helpers.js";

describe("canonicalJSON", () => {
  it("key order independent + stable", () => {
    assert.equal(canonicalJSON({ a: 1, b: 2 }), canonicalJSON({ b: 2, a: 1 }));
    assert.equal(canonicalJSON({ a: 1, b: 2 }), '{"a":1,"b":2}');
    assert.equal(canonicalJSON({ n: [{ y: 2, x: 1 }] }), '{"n":[{"x":1,"y":2}]}');
  });

  it("undefined → 'null'; primitives pass through; cycles throw", () => {
    assert.equal(canonicalJSON(undefined), "null");
    assert.equal(canonicalJSON(null), "null");
    assert.equal(canonicalJSON(42), "42");
    assert.equal(canonicalJSON("hi"), '"hi"');
    const o: Record<string, unknown> = {};
    o.self = o;
    assert.throws(() => canonicalJSON(o), /cycle/i);
  });
});

describe("hashHostCall", () => {
  it("stable + insensitive to arg key order", () => {
    const h1 = hashHostCall("zk.retrieve", { query: "loRA", topK: 8 });
    const h2 = hashHostCall("zk.retrieve", { topK: 8, query: "loRA" });
    assert.equal(h1, h2, "key order does not change the hash");
  });

  it("sensitive to args value and to name", () => {
    const base = hashHostCall("zk.retrieve", { query: "loRA", topK: 8 });
    assert.notEqual(base, hashHostCall("zk.retrieve", { query: "loRA", topK: 9 }), "different args → different hash");
    assert.notEqual(base, hashHostCall("zk.ingest", { query: "loRA", topK: 8 }), "different name → different hash");
  });

  it("produces a hex digest", () => {
    assert.match(hashHostCall("a.b", {}), /^[0-9a-f]+$/);
  });
});
