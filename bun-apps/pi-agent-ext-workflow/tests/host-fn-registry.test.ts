import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { applyHostFnRegistration, HostFnRegistry } from "../src/host-fn-registry.js";

describe("HostFnRegistry", () => {
  it("set/get/has/list", () => {
    const r = new HostFnRegistry();
    r.set("zk.retrieve", { fn: async () => 1 });
    assert.equal(r.has("zk.retrieve"), true);
    assert.equal(r.has("zk.missing"), false);
    assert.equal(typeof r.get("zk.retrieve")?.fn, "function");
    assert.equal(r.get("zk.missing"), undefined);
    assert.deepEqual(r.list(), ["zk.retrieve"]);
  });

  it("re-registering overwrites (idempotent)", () => {
    const r = new HostFnRegistry();
    r.set("zk.retrieve", { fn: async () => 1 });
    r.set("zk.retrieve", { fn: async () => 2 });
    assert.equal(r.list().length, 1);
  });

  it("list() is sorted", () => {
    const r = new HostFnRegistry();
    r.set("zk.zebra", { fn: async () => 1 });
    r.set("zk.alpha", { fn: async () => 1 });
    r.set("zk.middle", { fn: async () => 1 });
    assert.deepEqual(r.list(), ["zk.alpha", "zk.middle", "zk.zebra"]);
  });

  it("rejects names that are not 'ns.name'", () => {
    const r = new HostFnRegistry();
    for (const bad of ["nokdot", "zk.", ".retrieve", "zk.retrieve.extra", "zk.retrieve!", ""]) {
      assert.throws(() => r.set(bad, { fn: async () => 1 }), /'ns\.name'/i, `rejects '${bad}'`);
    }
  });
});

describe("applyHostFnRegistration (event-bus payload → registry)", () => {
  it("translates a valid payload into a registered 'ns.name' entry", () => {
    const r = new HostFnRegistry();
    const fn = async () => 1;
    applyHostFnRegistration(r, { ns: "zk", name: "retrieve", fn, timeoutMs: 30_000 });
    assert.equal(r.has("zk.retrieve"), true);
    assert.equal(r.get("zk.retrieve")?.timeoutMs, 30_000);
  });

  it("ignores malformed payloads without throwing", () => {
    const r = new HostFnRegistry();
    for (const bad of [null, undefined, {}, { ns: "zk" }, { ns: "zk", name: "x" }, { ns: 1, name: 2, fn: 3 }, "nope"]) {
      assert.doesNotThrow(() => applyHostFnRegistration(r, bad));
    }
    assert.equal(r.list().length, 0);
  });

  it("re-registering overwrites (idempotent; load-order safe)", () => {
    const r = new HostFnRegistry();
    applyHostFnRegistration(r, { ns: "zk", name: "retrieve", fn: async () => 1 });
    applyHostFnRegistration(r, { ns: "zk", name: "retrieve", fn: async () => 2 });
    assert.equal(r.list().length, 1);
  });
});
