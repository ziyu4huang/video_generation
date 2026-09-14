import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentDefinition } from "@repo/s2-agent-core-runtime";
import { gateProjectAgent, gateProjectAgentBatch, trustSurfaceFromCtx } from "../src/agent-trust.js";

function def(source: AgentDefinition["source"], name = "evil"): AgentDefinition {
  return {
    name,
    description: "repo-controlled definition",
    source,
    fileName: `${name}.md`,
    isolation: "none",
  } as unknown as AgentDefinition;
}

function trust(overrides: Partial<{ trusted: boolean; hasUI: boolean; approved: boolean }>) {
  const calls: string[] = [];
  return {
    surface: {
      isProjectTrusted: () => overrides.trusted ?? false,
      hasUI: overrides.hasUI ?? false,
      confirm: async (title: string, message: string) => {
        calls.push(`${title} :: ${message}`);
        return overrides.approved ?? false;
      },
    },
    calls,
  };
}

test("user/pack/builtin sources never gate — even untrusted and headless", async () => {
  for (const source of ["user", "pack", "builtin"] as const) {
    const verdict = await gateProjectAgent(def(source), trust({}).surface);
    assert.equal(verdict.ok, true, source);
  }
});

test("project + trusted → no gate", async () => {
  const verdict = await gateProjectAgent(def("project"), trust({ trusted: true }).surface);
  assert.equal(verdict.ok, true);
});

test("project + untrusted + no UI → default-DENY naming file and the trust fix", async () => {
  const verdict = await gateProjectAgent(def("project"), trust({ hasUI: false }).surface);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /not approved for this project/);
  assert.match(verdict.error ?? "", /evil\.md/);
  assert.match(verdict.error ?? "", /\/trust/);
});

test("project + untrusted + hasUI + confirm-approve → ok", async () => {
  const { surface, calls } = trust({ hasUI: true, approved: true });
  const verdict = await gateProjectAgent(def("project"), surface);
  assert.equal(verdict.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Run project-local agents\?/);
  assert.match(calls[0], /evil\.md/);
});

test("project + untrusted + hasUI + confirm-decline → rejected", async () => {
  const verdict = await gateProjectAgent(def("project"), trust({ hasUI: true, approved: false }).surface);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /Canceled/);
});

test("trustSurfaceFromCtx: absent primitives fail open (upstream runner default) with no UI", () => {
  const surface = trustSurfaceFromCtx(undefined);
  assert.equal(surface.isProjectTrusted(), true);
  assert.equal(surface.hasUI, false);
});

test("trustSurfaceFromCtx: reads ctx.isProjectTrusted/hasUI/ui.confirm", async () => {
  const confirms: string[] = [];
  const surface = trustSurfaceFromCtx({
    isProjectTrusted: () => false,
    hasUI: true,
    ui: { confirm: async (t: string, m: string) => (confirms.push(`${t}::${m}`), true) },
  });
  assert.equal(surface.isProjectTrusted(), false);
  assert.equal(surface.hasUI, true);
  assert.equal(await surface.confirm("t", "m"), true);
  assert.equal(confirms.length, 1);
});

test("batch: untrusted + no-UI rejects EVERY offending index, keeps others clean", async () => {
  const entries = [
    { index: 0, def: def("user", "ok-user") },
    { index: 1, def: def("project", "evil-a") },
    { index: 2, def: def("builtin", "ok-builtin") },
    { index: 3, def: def("project", "evil-b") },
  ];
  const rejections = await gateProjectAgentBatch(entries, trust({ hasUI: false }).surface);
  assert.deepEqual([...rejections.keys()].sort(), [1, 3]);
  assert.match(rejections.get(1) ?? "", /evil-a/);
  assert.match(rejections.get(3) ?? "", /evil-b/);
});

test("batch: untrusted + hasUI + one confirm covering all names; decline rejects all", async () => {
  const entries = [
    { index: 1, def: def("project", "evil-a") },
    { index: 3, def: def("project", "evil-b") },
  ];
  const { surface, calls } = trust({ hasUI: true, approved: false });
  const rejections = await gateProjectAgentBatch(entries, surface);
  assert.equal(calls.length, 1, "exactly one batch confirm");
  assert.match(calls[0], /evil-a/);
  assert.match(calls[0], /evil-b/);
  assert.deepEqual([...rejections.keys()].sort(), [1, 3]);
});

test("batch: trusted project → no rejections, no confirm", async () => {
  const { surface, calls } = trust({ trusted: true, hasUI: true, approved: false });
  const rejections = await gateProjectAgentBatch([{ index: 0, def: def("project") }], surface);
  assert.equal(rejections.size, 0);
  assert.equal(calls.length, 0);
});
