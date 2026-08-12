import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { WorkflowErrorCode } from "@repo/pi-agent-ext-core-runtime";
import { Type } from "typebox";
import { canonicalJSON, hashHostCall, runHostFnWithTimeout } from "../src/host-fn-helpers.js";
import type { HostFnCtx } from "../src/host-fn-registry.js";

const ctx = (signal: AbortSignal = new AbortController().signal): HostFnCtx => ({ cwd: "/", signal, runId: "r" });

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

describe("runHostFnWithTimeout", () => {
  it("returns the fn result", async () => {
    const out = await runHostFnWithTimeout({ fn: async (a: any) => a.x + 1 }, { x: 1 }, ctx(), "t.echo");
    assert.equal(out, 2);
  });

  it("fn throw → HOST_FN_FAILED (hard error)", async () => {
    await assert.rejects(
      () =>
        runHostFnWithTimeout(
          {
            fn: async () => {
              throw new Error("boom");
            },
          },
          {},
          ctx(),
          "t.boom",
        ),
      (e: any) => e.code === WorkflowErrorCode.HOST_FN_FAILED && e.recoverable === false && /boom/.test(e.message),
    );
  });

  it("timeout → HOST_FN_TIMEOUT (recoverable)", async () => {
    const slow = () => new Promise((resolve) => setTimeout(resolve, 1000));
    await assert.rejects(
      () => runHostFnWithTimeout({ fn: slow, timeoutMs: 20 }, {}, ctx(), "t.slow"),
      (e: any) => e.code === WorkflowErrorCode.HOST_FN_TIMEOUT && e.recoverable === true,
    );
  });

  it("parent signal abort → rejects (aborted)", async () => {
    const controller = new AbortController();
    const never = new Promise(() => {});
    const p = runHostFnWithTimeout({ fn: never, timeoutMs: 5000 }, {}, ctx(controller.signal), "t.stuck");
    controller.abort();
    await assert.rejects(p);
  });

  it("schema mismatch → HOST_FN_SCHEMA", async () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    await assert.rejects(
      () => runHostFnWithTimeout({ fn: async () => ({ nope: 1 }), schema }, {}, ctx(), "t.schema"),
      (e: any) => e.code === WorkflowErrorCode.HOST_FN_SCHEMA && e.recoverable === false,
    );
  });

  it("schema-conforming result passes", async () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    const out = await runHostFnWithTimeout({ fn: async () => ({ ok: true }), schema }, {}, ctx(), "t.ok");
    assert.deepEqual(out, { ok: true });
  });

  it("non-serializable result → HOST_FN_NON_SERIALIZABLE", async () => {
    const fn = () => ({
      f() {
        return 1;
      },
    }); // functions are not JSON-serializable
    await assert.rejects(
      () => runHostFnWithTimeout({ fn }, {}, ctx(), "t.fnval"),
      (e: any) => e.code === WorkflowErrorCode.HOST_FN_NON_SERIALIZABLE,
    );
  });
});
