import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowTool } from "../src/workflow-tool.js";

/**
 * workflow tool — the `name` parameter (Path B: run an installed workflow pack).
 *
 * Asserts the tool resolves a pack by name/path, shallow-merges manifest default
 * args under the caller's `args`, threads the merged args into the manager, and
 * enforces the `script` XOR `name` contract.
 */

/** Build a pack fixture: <dir>/<name>/{manifest.json, entry}. Returns the pack dir. */
function makePack(
  dir: string,
  name: string,
  manifest: Record<string, unknown>,
  entry = "export const meta = { name: 'pack', description: 'd', phases: [{ title: 'P' }] };\nconst r = await agent('task');\nreturn { args, r };\n",
): string {
  const packDir = join(dir, name);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(packDir, manifest.entry as string), entry);
  return packDir;
}

/** A stub manager that records the (script, args) it is handed. */
function recordingManager(): { manager: any; calls: { script: string; args: unknown }[] } {
  const calls: { script: string; args: unknown }[] = [];
  const manager = {
    startInBackground(script: string, args: unknown) {
      calls.push({ script, args });
      return { runId: "stub-run" };
    },
    runSync(script: string, args: unknown) {
      calls.push({ script, args });
      return {
        result: { ok: true, args },
        meta: { name: "pack", description: "d" },
        phases: ["P"],
        logs: [],
        agentCount: 1,
        durationMs: 0,
        runId: "stub-run",
        tokenUsage: null,
      };
    },
  };
  return { manager, calls };
}

describe("workflow tool — `name` (pack resolution)", () => {
  test("`name` resolves a pack dir + merges manifest args under caller args", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", {
      name: "echo",
      description: "d",
      entry: "index.js",
      args: { m: 1, shared: "manifest" },
    });
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    const result = await tool.execute(
      "call-1",
      { name: packDir, args: { c: 2, shared: "caller" }, background: true } as any,
      undefined as any,
      undefined as any,
      {} as any,
    );

    // Background mode returns immediately with a runId; the manager saw the
    // resolved entry script + the SHALLOW-MERGED args (caller wins on conflict).
    expect((result as { details: { runId: string } }).details.runId).toBe("stub-run");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.script).toContain("export const meta");
    expect(calls[0]?.args).toEqual({ m: 1, c: 2, shared: "caller" });
  });

  test("`name` with no caller args uses manifest args as-is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", {
      name: "echo",
      description: "d",
      entry: "index.js",
      args: { only: "manifest" },
    });
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await tool.execute(
      "call-2",
      { name: packDir, background: true } as any,
      undefined as any,
      undefined as any,
      {} as any,
    );

    expect(calls[0]?.args).toEqual({ only: "manifest" });
  });

  test("a pack with no manifest args passes caller args through untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", { name: "echo", description: "d", entry: "index.js" });
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await tool.execute(
      "call-3",
      { name: packDir, args: { x: 9 }, background: true } as any,
      undefined as any,
      undefined as any,
      {} as any,
    );

    expect(calls[0]?.args).toEqual({ x: 9 });
  });

  test("`name` pointing at a non-existent pack throws (fail-fast, before the manager)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await expect(
      tool.execute(
        "call-4",
        { name: join(dir, "missing"), background: true } as any,
        undefined as any,
        undefined as any,
        {} as any,
      ),
    ).rejects.toThrow(/not found|manifest/);
    expect(calls).toHaveLength(0);
  });

  // Ticket 06 — manifest.model IS applied on the `name` path via
  // ExecOptions.mainModel (it outranks the session mainModel; a script's
  // per-agent `model` still outranks it inside the runtime). Precedence matrix:
  // script > manifest > session.
  test("manifest.model threads into ExecOptions.mainModel on the `name` path (background)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    // Pack declares BOTH args AND a model in its manifest.
    const packDir = makePack(dir, "echo", {
      name: "echo",
      description: "d",
      entry: "index.js",
      args: { fromManifest: true },
      model: "manifest-declared/model",
    });
    // Capturing manager that records the FULL (script, args, options) triple —
    // including the options object where the forwarded model must appear.
    const calls: { script: string; args: unknown; options: unknown }[] = [];
    const manager = {
      startInBackground(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return { runId: "stub-run" };
      },
      runSync(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return {
          result: { ok: true },
          meta: { name: "pack", description: "d" },
          phases: ["P"],
          logs: [],
          agentCount: 1,
          durationMs: 0,
          runId: "stub-run",
          tokenUsage: null,
        };
      },
    };
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await tool.execute(
      "call-model",
      { name: packDir, args: { fromCaller: true }, background: true } as any,
      undefined as any,
      undefined as any,
      {} as any,
    );

    expect(calls).toHaveLength(1);
    // args ARE merged (sanity: the existing behavior still works).
    expect(calls[0]?.args).toEqual({ fromManifest: true, fromCaller: true });
    // Ticket 06: the manifest's model is handed to the manager as the run's
    // mainModel (which outranks the session mainModel inside the manager).
    const opt = calls[0]?.options as Record<string, unknown>;
    expect(opt.mainModel).toBe("manifest-declared/model");
  });

  test("a pack WITHOUT manifest.model omits ExecOptions.mainModel (session governs)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", { name: "echo", description: "d", entry: "index.js" });
    const calls: { script: string; args: unknown; options: unknown }[] = [];
    const manager = {
      startInBackground(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return { runId: "stub-run" };
      },
      runSync(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return {
          result: { ok: true },
          meta: { name: "pack", description: "d" },
          phases: ["P"],
          logs: [],
          agentCount: 1,
          durationMs: 0,
          runId: "stub-run",
          tokenUsage: null,
        };
      },
    };
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await tool.execute(
      "call-no-model",
      { name: packDir, background: true } as any,
      undefined as any,
      undefined as any,
      {} as any,
    );

    // Model-less packs stay byte-identical to the pre-06 behavior: the manager
    // falls back to its session mainModel, and the options carry no model key.
    expect(calls).toHaveLength(1);
    const opt = calls[0]?.options as Record<string, unknown>;
    expect(opt).not.toHaveProperty("mainModel");
    expect(opt).not.toHaveProperty("model");
  });

  test("an inline `script` (no pack) never carries ExecOptions.mainModel", async () => {
    const { manager, calls } = recordingManager() as unknown as {
      manager: any;
      calls: { script: string; args: unknown; options?: unknown }[];
    };
    // recordingManager's startInBackground records (script, args) only; extend it
    // inline here to also capture the options object.
    const withOptions: { script: string; args: unknown; options: unknown }[] = [];
    manager.startInBackground = (script: string, args: unknown, options: unknown) => {
      withOptions.push({ script, args, options });
      return { runId: "stub-run" };
    };
    const tool = createWorkflowTool({ manager });
    const script =
      "export const meta = { name: 'inline_demo', description: 'd', phases: [{ title: 'P' }] };\nconst r = await agent('task');\nreturn { r };\n";

    await tool.execute(
      "call-inline-model",
      { script, background: true } as any,
      undefined as any,
      undefined as any,
      {} as any,
    );

    expect(withOptions).toHaveLength(1);
    const opt = withOptions[0]?.options as Record<string, unknown>;
    expect(opt).not.toHaveProperty("mainModel");
    expect(opt).not.toHaveProperty("model");
    expect(calls).toHaveLength(0);
  });

  // Ticket 06 — Path B result `details` label the governing model: manifest.model
  // when the pack declares one (`modelSource: "manifest"`), else the host
  // session's mainModel (`modelSource: "session"`). `ctx.model` exposes the
  // session model to execute() (see ExtensionContext.model in pi-coding-agent
  // types.d.ts).
  test("Path B background result details label modelSource:'manifest' when manifest.model is declared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", {
      name: "echo",
      description: "d",
      entry: "index.js",
      args: { fromManifest: true },
      model: "manifest-declared/model",
    });
    const calls: { script: string; args: unknown; options: unknown }[] = [];
    const manager = {
      startInBackground(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return { runId: "stub-run" };
      },
      runSync(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return {
          result: { ok: true },
          meta: { name: "pack", description: "d" },
          phases: ["P"],
          logs: [],
          agentCount: 1,
          durationMs: 0,
          runId: "stub-run",
          tokenUsage: null,
        };
      },
    };
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    // ctx.model would report the SESSION model; the manifest model must win
    // both in the label and in the options handed to the manager.
    const ctx = { model: { id: "session-main/model" } } as any;

    const result = await tool.execute(
      "call-task4-bg",
      { name: packDir, args: { fromCaller: true }, background: true } as any,
      undefined as any,
      undefined as any,
      ctx,
    );

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.modelSource).toBe("manifest");
    expect(details.model).toBe("manifest-declared/model");
    // runId + background flag still present (no regression on the existing shape).
    expect(details.runId).toBe("stub-run");
    expect(details.background).toBe(true);

    expect(calls).toHaveLength(1);
    const opt = calls[0]?.options as Record<string, unknown>;
    expect(opt.mainModel).toBe("manifest-declared/model");
  });

  test("Path B inline (background:false) snapshot details also label modelSource:'manifest'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", {
      name: "echo",
      description: "d",
      entry: "index.js",
      model: "manifest-declared/model",
    });
    const calls: { script: string; args: unknown; options: unknown }[] = [];
    const manager = {
      startInBackground(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return { runId: "stub-run" };
      },
      runSync(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return {
          result: { ok: true },
          meta: { name: "pack", description: "d" },
          phases: ["P"],
          logs: [],
          agentCount: 1,
          durationMs: 0,
          runId: "stub-run",
          tokenUsage: null,
        };
      },
    };
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });
    const ctx = { model: { id: "session-main/model" } } as any;

    const result = await tool.execute(
      "call-task4-sync",
      { name: packDir, background: false } as any,
      undefined as any,
      undefined as any,
      ctx,
    );

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.modelSource).toBe("manifest");
    expect(details.model).toBe("manifest-declared/model");
    // The inline path threads the manifest model into the manager too.
    expect(calls).toHaveLength(1);
    const opt = calls[0]?.options as Record<string, unknown>;
    expect(opt.mainModel).toBe("manifest-declared/model");
  });

  test("Path B labels modelSource:'session' + session model id when the pack declares no model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", { name: "echo", description: "d", entry: "index.js" });
    const calls: { script: string; args: unknown; options: unknown }[] = [];
    const manager = {
      startInBackground(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return { runId: "stub-run" };
      },
      runSync(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return {
          result: { ok: true },
          meta: { name: "pack", description: "d" },
          phases: ["P"],
          logs: [],
          agentCount: 1,
          durationMs: 0,
          runId: "stub-run",
          tokenUsage: null,
        };
      },
    };
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });
    const ctx = { model: { id: "session-main/model" } } as any;

    const result = await tool.execute(
      "call-session-label",
      { name: packDir, background: true } as any,
      undefined as any,
      undefined as any,
      ctx,
    );

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.modelSource).toBe("session");
    expect(details.model).toBe("session-main/model");
    const opt = calls[0]?.options as Record<string, unknown>;
    expect(opt).not.toHaveProperty("mainModel");
  });

  // D3-2 — Path B (the `workflow` tool) does NOT thread persistLogs / runsDir /
  // outDir into the manager. This is an intentional asymmetry with Path A
  // (`runWorkflowScript`, the CLI `workflow run` path), which owns those fields
  // and passes them to the engine. Path B builds an options object of only
  // { maxAgents, concurrency, agentRetries, agentTimeoutMs, tokenBudget } so the
  // engine defaults take effect. Pin the omission so a divergence (accidentally
  // forwarding persistLogs=false from the tool, or runsDir from a pack manifest)
  // is caught at the boundary.
  test("`name` path (Path B) does NOT pass persistLogs / runsDir / outDir to the manager (D3-2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", { name: "echo", description: "d", entry: "index.js" });

    // Capturing manager that records the FULL (script, args, options) triple.
    const calls: { script: string; args: unknown; options: unknown }[] = [];
    const manager = {
      startInBackground(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return { runId: "stub-run" };
      },
      runSync(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return {
          result: { ok: true },
          meta: { name: "pack", description: "d" },
          phases: ["P"],
          logs: [],
          agentCount: 1,
          durationMs: 0,
          runId: "stub-run",
          tokenUsage: null,
        };
      },
    };
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await tool.execute(
      "call-d3-2",
      { name: packDir, args: { x: 1 }, background: true } as any,
      undefined as any,
      undefined as any,
      {} as any,
    );

    expect(calls).toHaveLength(1);
    // The options object handed to startInBackground must omit the Path-A-only
    // fields. A divergence here would mean the tool silently overrode the
    // engine's default log persistence or redirect a pack manifest declared.
    const opt = calls[0]?.options as Record<string, unknown>;
    expect(opt).not.toHaveProperty("persistLogs");
    expect(opt).not.toHaveProperty("runsDir");
    expect(opt).not.toHaveProperty("outDir");
    // And the run-shaping knobs that Path B DOES own are still threaded.
    expect(opt).toHaveProperty("maxAgents");
    expect(opt).toHaveProperty("concurrency");
    expect(opt).toHaveProperty("agentRetries");
    expect(opt).toHaveProperty("agentTimeoutMs");
    expect(opt).toHaveProperty("tokenBudget");
  });
});

describe("workflow tool — no-agent script rejection (D9-8)", () => {
  // A script that parses (has `export const meta`) but never invokes `agent()`.
  // Both the background path and the inline path must reject this BEFORE
  // returning a runId / running the workflow, otherwise a no-agent script gets
  // a false-positive "started" runId the caller trusts (background) or fails
  // late inside the manager.
  const NO_AGENT_SCRIPT =
    "export const meta = { name: 'noagent', description: 'd', phases: [{ title: 'P' }] };\nreturn { done: true };\n";

  test("background: true rejects a no-agent script (does NOT return a runId)", async () => {
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ manager: manager as any });

    await expect(
      tool.execute(
        "call-noagent-bg",
        { script: NO_AGENT_SCRIPT, background: true } as any,
        undefined as any,
        undefined as any,
        {} as any,
      ),
    ).rejects.toThrow(/agent\(\) at least once/);

    // The background path must not have handed the script to the manager.
    expect(calls).toHaveLength(0);
  });

  test("background: false rejects a no-agent script (shared pre-flight)", async () => {
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ manager: manager as any });

    await expect(
      tool.execute(
        "call-noagent-sync",
        { script: NO_AGENT_SCRIPT, background: false } as any,
        undefined as any,
        undefined as any,
        {} as any,
      ),
    ).rejects.toThrow(/agent\(\) at least once/);

    // Pre-flight rejected before reaching the manager.
    expect(calls).toHaveLength(0);
  });

  // The stdlib quality helpers (verify/judgePanel/loopUntilDry/completenessCheck)
  // and nested workflow('name') spawn agents INSIDE the engine — the script text
  // never mentions the `agent(` token. The static guard must not reject them.
  const HELPER_ONLY_SCRIPTS: Record<string, string> = {
    verify: "export const meta = { name: 'v', description: 'd' };\nreturn await verify('claim', { reviewers: 3 });\n",
    judgePanel:
      "export const meta = { name: 'j', description: 'd' };\nreturn await judgePanel(['a', 'b'], { judges: 3 });\n",
    loopUntilDry:
      "export const meta = { name: 'l', description: 'd' };\nreturn await loopUntilDry({ round: (i) => [] });\n",
    completenessCheck:
      "export const meta = { name: 'c', description: 'd' };\nreturn await completenessCheck(args, []);\n",
    synthesize:
      "export const meta = { name: 's', description: 'd' };\nreturn await synthesize(args.task, args.results);\n",
    "nested workflow":
      "export const meta = { name: 'n', description: 'd' };\nreturn await workflow('saved-name', { q: 1 });\n",
  };

  for (const [label, script] of Object.entries(HELPER_ONLY_SCRIPTS)) {
    test(`background: true accepts a ${label}-only script (helpers spawn agents internally)`, async () => {
      const { manager, calls } = recordingManager();
      const tool = createWorkflowTool({ manager: manager as any });

      await tool.execute(
        `call-${label}`,
        { script, background: true } as any,
        undefined as any,
        undefined as any,
        {} as any,
      );

      // The guard let the script through to the manager.
      expect(calls).toHaveLength(1);
    });
  }
});

describe("workflow tool — `script` XOR `name` contract", () => {
  test("prepareArguments rejects both `script` and `name`", () => {
    const tool = createWorkflowTool();
    expect(() => tool.prepareArguments?.({ script: "x", name: "y" } as any)).toThrow(/exactly one/);
  });

  test("prepareArguments rejects neither `script` nor `name`", () => {
    const tool = createWorkflowTool();
    expect(() => tool.prepareArguments?.({ args: { a: 1 } } as any)).toThrow(/exactly one/);
  });

  test("prepareArguments passes a `name`-only call through (resolution happens in execute)", () => {
    const tool = createWorkflowTool();
    const out = tool.prepareArguments?.({ name: "echo", args: { a: 1 } } as any) as { name: string; args: unknown };
    expect(out.name).toBe("echo");
    expect(out.args).toEqual({ a: 1 });
  });

  test("prepareArguments normalizes a `script`-only call (unchanged behaviour)", () => {
    const tool = createWorkflowTool();
    const out = tool.prepareArguments?.({ script: "  export const meta = {}  " } as any) as { script: string };
    expect(out.script).toBe("export const meta = {}");
  });
});
