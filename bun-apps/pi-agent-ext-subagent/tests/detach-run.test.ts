/**
 * Task 05 (cc-subagent-tui): the detach pipeline — foreground → background.
 *
 * `convertToBackground` is the capability the ctrl+b shortcut (Task 06) and the
 * dock (Task 08) will call. Contract under test, per the plan:
 *   - the child SURVIVES: a new detached OS subprocess resumes from a manifest
 *     flushed at detach time (`spawnDetached`, never killed on release);
 *   - the registry entry STAYS LIVE with foreground=false / detached=true;
 *   - `abort` rebinds to the detached child's kill lever;
 *   - persistence owns recovery: the manifest round-trips through
 *     `SubagentRunPersistence.saveDetached`/`loadDetached`;
 *   - unknown / already-background / terminal runs refuse with { ok: false }.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentRunPersistence, SubagentInFlightRegistry } from "@repo/pi-agent-core-runtime";
import type { DetachedChildHandle, DetachedSpawnSpec } from "../src/detach-run.js";
import { convertToBackground, makeProdDetachDeps } from "../src/detach-run.js";

/** A foreground run in a real registry, as dispatchChild would register it. */
function foregroundRun(registry: SubagentInFlightRegistry, id = "call-1", task = "the full raw task text") {
  registry.start({
    id,
    agent: "implementer",
    task,
    taskPreview: "the full raw task text",
    workIntent: "the full raw task text",
    model: "provider/model",
    startedAt: Date.now(),
    status: "running",
    foreground: true,
  });
}

/** Fake detached child: records kill calls, mirrors the handle contract. */
function fakeChild(): DetachedChildHandle & { killCalls: number } {
  const h = { pid: 4242, killCalls: 0, kill: () => void 0 } as DetachedChildHandle & { killCalls: number };
  h.kill = () => {
    h.killCalls += 1;
  };
  return h;
}

function fakeDeps(registry: SubagentInFlightRegistry, manifestPath = "/tmp/does-not-matter.json") {
  const specs: DetachedSpawnSpec[] = [];
  const child = fakeChild();
  return {
    specs,
    child,
    deps: {
      registry,
      spawnDetached: (spec: DetachedSpawnSpec) => {
        specs.push(spec);
        return child;
      },
      persistRun: (id: string) => `${manifestPath}:${id}`,
    },
  };
}

describe("convertToBackground", () => {
  test("child-alive-after-detach: spawned child is not killed when parent releases", () => {
    const registry = new SubagentInFlightRegistry();
    foregroundRun(registry);
    const { specs, child, deps } = fakeDeps(registry);

    const outcome = convertToBackground("call-1", deps);

    assert.deepEqual(outcome, { ok: true, runId: "call-1" });
    assert.equal(specs.length, 1);
    assert.equal(child.killCalls, 0);
    // Parent released: the registry entry reports the detached state the
    // awaited tool call observes to resolve with outcome "detached".
    assert.equal(registry.view("call-1")?.detached, true);
  });

  test("registry entry stays live and flips to background", () => {
    const registry = new SubagentInFlightRegistry();
    foregroundRun(registry);
    const { deps } = fakeDeps(registry);

    convertToBackground("call-1", deps);

    const v = registry.view("call-1");
    assert.ok(v, "entry must stay in the registry");
    assert.equal(v.foreground, false);
    assert.equal(v.detached, true);
  });

  test("abort rebinds to the detached child (exactly one kill)", () => {
    const registry = new SubagentInFlightRegistry();
    foregroundRun(registry);
    const { child, deps } = fakeDeps(registry);

    convertToBackground("call-1", deps);
    registry.abort("call-1");

    assert.equal(child.killCalls, 1);
  });

  test("manifest path from persistRun is handed to the spawned child", () => {
    const registry = new SubagentInFlightRegistry();
    foregroundRun(registry, "call-9");
    const { specs, deps } = fakeDeps(registry, "/tmp/manifest-9.json");

    convertToBackground("call-9", deps);

    assert.equal(specs[0]?.manifestPath, "/tmp/manifest-9.json:call-9");
    assert.equal(specs[0]?.id, "call-9");
    // The full raw task (not the truncated preview) travels in the spec.
    assert.equal(specs[0]?.task, "the full raw task text");
    assert.equal(specs[0]?.agent, "implementer");
  });

  test("unknown id → { ok: false }", () => {
    const registry = new SubagentInFlightRegistry();
    const { deps } = fakeDeps(registry);
    const outcome = convertToBackground("nope", deps);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.error.includes("unknown"));
  });

  test("already background → { ok: false }", () => {
    const registry = new SubagentInFlightRegistry();
    registry.start({
      id: "bg",
      taskPreview: "t",
      workIntent: "t",
      startedAt: Date.now(),
      status: "running",
      foreground: false,
    });
    const { specs, deps } = fakeDeps(registry);
    const outcome = convertToBackground("bg", deps);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.error.includes("already background"));
    assert.equal(specs.length, 0);
  });

  test("terminal run → { ok: false }", () => {
    const registry = new SubagentInFlightRegistry();
    foregroundRun(registry);
    registry.markCompleted("call-1", "done");
    const { specs, deps } = fakeDeps(registry);
    const outcome = convertToBackground("call-1", deps);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.error.includes("terminal"));
    assert.equal(specs.length, 0);
  });
});

describe("detach persistence", () => {
  test("real persistence round-trip: a detached manifest is resumable and never pollutes the completed list", () => {
    const home = mkdtempSync(join(tmpdir(), "subagent-detach-"));
    const p = createSubagentRunPersistence({ home });
    const history = [
      { kind: "toolCall", name: "bash", args: { command: "ls" } },
      { kind: "toolResult", text: "a\nb" },
    ] as never[];

    const path = p.saveDetached({
      id: "r1",
      toolCallId: "r1",
      agent: "implementer",
      task: "the full raw task text",
      model: "provider/model",
      cwd: "/repo",
      detachedAt: new Date().toISOString(),
      history,
    });

    assert.equal(path, join(p.getRunsDir(), "detached", "r1.json"));
    const m = p.loadDetached("r1");
    assert.equal(m?.id, "r1");
    assert.equal(m?.task, "the full raw task text");
    assert.equal(m?.agent, "implementer");
    assert.equal(m?.history.length, 2);
    assert.equal(p.loadDetached("missing"), null);
    // The hand-off manifest must NOT appear in the completed-runs list.
    assert.equal(p.list().length, 0);
    rmSync(home, { recursive: true, force: true });
  });

  test("makeProdDetachDeps flushes a resumable manifest via the real persistence surface", () => {
    const registry = new SubagentInFlightRegistry();
    const home = mkdtempSync(join(tmpdir(), "subagent-detach-"));
    const persistence = createSubagentRunPersistence({ home });
    foregroundRun(registry, "call-42", "refactor the parser");

    const deps = makeProdDetachDeps({ registry, persistence });
    assert.equal(deps.registry, registry);
    assert.equal(typeof deps.spawnDetached, "function");

    const path = deps.persistRun("call-42");
    const m = persistence.loadDetached("call-42");
    assert.equal(m?.task, "refactor the parser");
    assert.ok(path.length > 0);
    rmSync(home, { recursive: true, force: true });
  });
});
