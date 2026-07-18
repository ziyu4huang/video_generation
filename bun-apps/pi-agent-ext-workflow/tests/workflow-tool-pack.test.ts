import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  entry = "export const meta = { name: 'pack', description: 'd', phases: [{ title: 'P' }] };\nreturn { args };\n",
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
      return { result: { ok: true, args }, meta: { name: "pack", description: "d" }, phases: ["P"], logs: [], agentCount: 1, durationMs: 0, runId: "stub-run", tokenUsage: null };
    },
  };
  return { manager, calls };
}

describe("workflow tool — `name` (pack resolution)", () => {
  test("`name` resolves a pack dir + merges manifest args under caller args", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", { name: "echo", description: "d", entry: "index.js", args: { m: 1, shared: "manifest" } });
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
    expect(calls[0]!.script).toContain("export const meta");
    expect(calls[0]!.args).toEqual({ m: 1, c: 2, shared: "caller" });
  });

  test("`name` with no caller args uses manifest args as-is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", { name: "echo", description: "d", entry: "index.js", args: { only: "manifest" } });
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await tool.execute("call-2", { name: packDir, background: true } as any, undefined as any, undefined as any, {} as any);

    expect(calls[0]!.args).toEqual({ only: "manifest" });
  });

  test("a pack with no manifest args passes caller args through untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const packDir = makePack(dir, "echo", { name: "echo", description: "d", entry: "index.js" });
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await tool.execute("call-3", { name: packDir, args: { x: 9 }, background: true } as any, undefined as any, undefined as any, {} as any);

    expect(calls[0]!.args).toEqual({ x: 9 });
  });

  test("`name` pointing at a non-existent pack throws (fail-fast, before the manager)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await expect(
      tool.execute("call-4", { name: join(dir, "missing"), background: true } as any, undefined as any, undefined as any, {} as any),
    ).rejects.toThrow(/not found|manifest/);
    expect(calls).toHaveLength(0);
  });

  test("manifest.model is NOT applied on the `name` path (session mainModel governs)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tool-"));
    // Pack declares BOTH args AND a model in its manifest.
    const packDir = makePack(dir, "echo", {
      name: "echo", description: "d", entry: "index.js",
      args: { fromManifest: true },
      model: "manifest-declared/model",
    });
    // Capturing manager that records the FULL (script, args, options) triple —
    // including the options object where a forwarded model would appear.
    const calls: { script: string; args: unknown; options: unknown }[] = [];
    const manager = {
      startInBackground(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return { runId: "stub-run" };
      },
      runSync(script: string, args: unknown, options: unknown) {
        calls.push({ script, args, options });
        return { result: { ok: true }, meta: { name: "pack", description: "d" }, phases: ["P"], logs: [], agentCount: 1, durationMs: 0, runId: "stub-run", tokenUsage: null };
      },
    };
    const tool = createWorkflowTool({ cwd: dir, manager: manager as any });

    await tool.execute(
      "call-model",
      { name: packDir, args: { fromCaller: true }, background: true } as any,
      undefined as any, undefined as any, {} as any,
    );

    expect(calls).toHaveLength(1);
    // args ARE merged (sanity: the existing behavior still works).
    expect(calls[0]!.args).toEqual({ fromManifest: true, fromCaller: true });
    // The options object handed to the manager MUST NOT carry a model sourced
    // from the manifest. Assert no model-bearing key is present.
    const opt = calls[0]!.options as Record<string, unknown>;
    expect(opt).not.toHaveProperty("model");
    expect(opt).not.toHaveProperty("mainModel");
  });
});

describe("workflow tool — `script` XOR `name` contract", () => {
  test("prepareArguments rejects both `script` and `name`", () => {
    const tool = createWorkflowTool();
    expect(() => tool.prepareArguments!({ script: "x", name: "y" } as any)).toThrow(/exactly one/);
  });

  test("prepareArguments rejects neither `script` nor `name`", () => {
    const tool = createWorkflowTool();
    expect(() => tool.prepareArguments!({ args: { a: 1 } } as any)).toThrow(/exactly one/);
  });

  test("prepareArguments passes a `name`-only call through (resolution happens in execute)", () => {
    const tool = createWorkflowTool();
    const out = tool.prepareArguments!({ name: "echo", args: { a: 1 } } as any) as { name: string; args: unknown };
    expect(out.name).toBe("echo");
    expect(out.args).toEqual({ a: 1 });
  });

  test("prepareArguments normalizes a `script`-only call (unchanged behaviour)", () => {
    const tool = createWorkflowTool();
    const out = tool.prepareArguments!({ script: "  export const meta = {}  " } as any) as { script: string };
    expect(out.script).toBe("export const meta = {}");
  });
});
