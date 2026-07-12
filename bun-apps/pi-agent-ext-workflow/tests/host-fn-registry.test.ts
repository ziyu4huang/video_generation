import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { HostFnRegistry } from "../src/host-fn-registry.js";

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
