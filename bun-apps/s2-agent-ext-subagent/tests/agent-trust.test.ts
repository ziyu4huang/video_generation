import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "@repo/s2-agent-core-runtime";
import {
  createAgentTrustSurface,
  gateProjectAgent,
  gateProjectAgentBatch,
  trustSurfaceFromCtx,
} from "../src/agent-trust.js";
import { createSubagentTool } from "../src/subagent-tool.js";
import { ok } from "./_spawn-result.js";

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

// ── self-arc-26: the store-backed default surface ──────────────────────────
// pi's ProjectTrustStore semantics (shipped trust-manager.js): get(cwd) walks
// cwd's ANCESTORS, the nearest true/false entry wins, `null`-valued entries
// are skipped, no entry → null ("ask"), corrupt JSON → throws. Keys are
// canonical paths (macOS /tmp → /private/tmp), hence realpathSync.

function makeStore(entries: Record<string, boolean | null>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "trust-store-")));
  writeFileSync(join(dir, "trust.json"), JSON.stringify(entries));
  return dir;
}

function makeProject(name = "proj"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), name)));
}

afterAll(() => {
  // Temp dirs are left for the OS tmp cleaner; nothing process-global was set.
});

test("store true at the dispatch cwd → trusted, no gate", async () => {
  const proj = makeProject();
  const surface = createAgentTrustSurface({ ctx: undefined, cwd: proj, agentDir: makeStore({ [proj]: true }) });
  assert.equal(surface.isProjectTrusted(), true);
});

test("store false → headless default-DENY naming the file", async () => {
  const proj = makeProject();
  const surface = createAgentTrustSurface({ ctx: undefined, cwd: proj, agentDir: makeStore({ [proj]: false }) });
  const verdict = await gateProjectAgent(def("project", "evil.md"), surface);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error ?? "", /evil\.md/);
});

test("store has no entry (pi's ask) → UNTRUSTED — the secure flip that makes the gate real", async () => {
  const proj = makeProject();
  const surface = createAgentTrustSurface({
    ctx: undefined,
    cwd: proj,
    agentDir: makeStore({ "/somewhere-else": true }),
  });
  assert.equal(surface.isProjectTrusted(), false);
});

test("ancestor walk: an entry on a parent dir decides for the deeper dispatch cwd", async () => {
  const parent = makeProject();
  const child = join(parent, "deep", "deeper");
  mkdirSync(child, { recursive: true });
  const surface = createAgentTrustSurface({ ctx: undefined, cwd: child, agentDir: makeStore({ [parent]: true }) });
  assert.equal(surface.isProjectTrusted(), true);
});

test("null-valued entry at cwd is SKIPPED; a nearer ancestor's true wins", async () => {
  const parent = makeProject();
  const child = join(parent, "sub");
  mkdirSync(child, { recursive: true });
  const surface = createAgentTrustSurface({
    ctx: undefined,
    cwd: child,
    agentDir: makeStore({ [child]: null, [parent]: true }),
  });
  assert.equal(surface.isProjectTrusted(), true);
});

test("corrupt store JSON degrades to the ctx surface (fail-open with no ctx, ctx verdict otherwise)", async () => {
  const proj = makeProject();
  const badDir = realpathSync(mkdtempSync(join(tmpdir(), "trust-bad-")));
  writeFileSync(join(badDir, "trust.json"), "{not json");
  assert.equal(createAgentTrustSurface({ ctx: undefined, cwd: proj, agentDir: badDir }).isProjectTrusted(), true);
  assert.equal(
    createAgentTrustSurface({ ctx: { isProjectTrusted: () => false }, cwd: proj, agentDir: badDir }).isProjectTrusted(),
    false,
  );
});

test("a readable store OVERRIDES the ctx verdict (this is what makes the gate non-latent)", async () => {
  const proj = makeProject();
  const trustedStore = makeStore({ [proj]: true });
  const untrustedStore = makeStore({ [proj]: false });
  // pi's SettingsManager would report true here (library default)…
  const ctx = { isProjectTrusted: () => true, hasUI: false };
  assert.equal(createAgentTrustSurface({ ctx, cwd: proj, agentDir: trustedStore }).isProjectTrusted(), true);
  // …but the store's explicit false wins → gate fires.
  assert.equal(createAgentTrustSurface({ ctx, cwd: proj, agentDir: untrustedStore }).isProjectTrusted(), false);
});

test("store true overrides a ctx that says untrusted (override is bidirectional, D5)", () => {
  const proj = makeProject();
  // ctx reporting false (e.g. an embedder's own gate) cannot manufacture a
  // denial the store does not support.
  const ctx = { isProjectTrusted: () => false, hasUI: false };
  assert.equal(
    createAgentTrustSurface({ ctx, cwd: proj, agentDir: makeStore({ [proj]: true }) }).isProjectTrusted(),
    true,
  );
});

test("hasUI/confirm pass through from ctx untouched", async () => {
  const proj = makeProject();
  const confirms: string[] = [];
  const surface = createAgentTrustSurface({
    ctx: { hasUI: true, ui: { confirm: async (t: string, m: string) => (confirms.push(`${t}::${m}`), true) } },
    cwd: proj,
    agentDir: makeStore({ [proj]: false }),
  });
  assert.equal(surface.hasUI, true);
  const verdict = await gateProjectAgent(def("project", "evil.md"), surface);
  assert.equal(verdict.ok, true, "confirm-approved → dispatch allowed");
  assert.match(confirms[0], /~\/\.pi\/agent\/trust\.json/);
});

test("tool-default integration: the REAL default path denies an untrusted project def (no injected surface)", async () => {
  const proj = makeProject();
  const store = makeStore({ [proj]: false });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = store;
  try {
    const registry = new Map<string, AgentDefinition>([
      ["evil", { name: "evil", source: "project", fileName: "evil.md" } as unknown as AgentDefinition],
    ]);
    const tool = createSubagentTool({ spawn: async () => ok("SHOULD NOT RUN"), agentRegistry: registry, cwd: proj });
    const res = await tool.execute("id", { task: "t", agentType: "evil" }, undefined as never, undefined, undefined);
    assert.match(res.content[0].text, /not approved for this project/);
    assert.match(res.content[0].text, /evil\.md/);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});
