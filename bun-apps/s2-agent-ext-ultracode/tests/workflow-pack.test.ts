import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findRepoRoot,
  listWorkflows,
  mergeArgs,
  resolveModel,
  resolvePackOverrides,
  resolveWorkflowPack,
  resolveWorkflowScript,
  runWorkflowScript,
} from "../src/workflow-pack.js";

/**
 * workflow-pack — the shared resolver + orchestration (single source of truth
 * for the `workflow` tool `name` path — the sole entry path since the CLI
 * `workflow run` meta-command was removed 2026-08-25, round-2 t02).
 *
 * These tests exercise the pure pieces (script + pack resolution, args/model
 * precedence, enumeration) and one headless smoke run with a stub agent (no LLM,
 * no network) so the engine vm + phase() + agent() globals are proven headlessly.
 * The "real pack" destination-proof tests point at the example packs that now
 * live in s2-agent (bun-apps/s2-agent/workflows/).
 */

// ── resolveWorkflowScript ──────────────────────────────────────────────────

describe("resolveWorkflowScript", () => {
  test("empty name throws", () => {
    expect(() => resolveWorkflowScript("")).toThrow(/script name or path is required/);
    expect(() => resolveWorkflowScript("   ")).toThrow(/script name or path is required/);
  });

  test("resolves a literal path (absolute)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const p = join(dir, "wf.js");
    writeFileSync(p, "export const meta = { name: 'x', description: 'd' };\n");
    const r = resolveWorkflowScript(p);
    expect(r.source).toBe("path");
    expect(r.path).toBe(p);
    expect(r.script).toContain("export const meta");
  });

  test("resolves a literal path relative to cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const p = join(dir, "rel.js");
    writeFileSync(p, "export const meta = { name: 'y', description: 'd' };\n");
    const r = resolveWorkflowScript("rel.js", { cwd: dir });
    expect(r.source).toBe("path");
    expect(r.script).toContain("'y'");
  });

  test("missing name under a fake root → clear not-found error", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    expect(() => resolveWorkflowScript("does-not-exist", { cwd: dir })).toThrow(/"does-not-exist" not found/);
  });

  test("resolves .pi/workflows/<name>.js from a fake repo root", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    mkdirSync(join(root, ".pi", "workflows"), { recursive: true });
    const p = join(root, ".pi", "workflows", "demo.js");
    writeFileSync(p, "export const meta = { name: 'demo', description: 'd' };\n");
    const r = resolveWorkflowScript("demo", { cwd: root });
    expect(r.source).toBe(".pi/workflows");
    expect(r.path).toBe(p);
  });

  test("resolves bun-apps/<pkg>/workflows/<name>.js from a fake repo root", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    mkdirSync(join(root, "bun-apps", "s2-agent-ext-demo", "workflows"), { recursive: true });
    const p = join(root, "bun-apps", "s2-agent-ext-demo", "workflows", "thing.js");
    writeFileSync(p, "export const meta = { name: 'thing', description: 'd' };\n");
    const r = resolveWorkflowScript("thing", { cwd: root });
    expect(r.source).toBe("package-workflows");
    expect(r.path).toBe(p);
  });

  test("accepts a name with explicit .js suffix under .pi/workflows", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    mkdirSync(join(root, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(root, ".pi", "workflows", "suf.js"), "export const meta = { name: 'suf', description: 'd' };\n");
    const r = resolveWorkflowScript("suf.js", { cwd: root });
    expect(r.source).toBe(".pi/workflows");
  });

  test("resolves a pack from <cwd>/workflows with source cwd-workflows (portable tier)", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-wf-cwd-"));
    const echoDir = join(root, "workflows", "echo");
    mkdirSync(echoDir, { recursive: true });
    writeFileSync(
      join(echoDir, "manifest.json"),
      JSON.stringify({ name: "echo", description: "cwd", entry: "index.js" }),
    );
    writeFileSync(
      join(echoDir, "index.js"),
      `export const meta = { name: "echo", description: "cwd" };\nreturn { tier: "cwd" };\n`,
    );
    const r = resolveWorkflowScript("echo", { cwd: root });
    expect(r.source).toBe("cwd-workflows");
    expect(r.script).toContain('tier: "cwd"');
  });

  test("resolves a pack from <binDir>/workflows with source bin-workflows (injectable binDir)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-wf-cwd2-"));
    const bin = mkdtempSync(join(tmpdir(), "pi-wf-bin-"));
    const echoDir = join(bin, "workflows", "echo");
    mkdirSync(echoDir, { recursive: true });
    writeFileSync(
      join(echoDir, "manifest.json"),
      JSON.stringify({ name: "echo", description: "bin", entry: "index.js" }),
    );
    writeFileSync(
      join(echoDir, "index.js"),
      `export const meta = { name: "echo", description: "bin" };\nreturn { tier: "bin" };\n`,
    );
    const r = resolveWorkflowScript("echo", { cwd, binDir: bin });
    expect(r.source).toBe("bin-workflows");
    expect(r.script).toContain('tier: "bin"');
  });

  test("cwd tier ranks ABOVE repo .pi/workflows (most local wins)", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-wf-prec-"));
    // cwd-tier pack (bare <root>/workflows/echo)
    mkdirSync(join(root, "workflows", "echo"), { recursive: true });
    writeFileSync(
      join(root, "workflows", "echo", "manifest.json"),
      JSON.stringify({ name: "echo", description: "cwd", entry: "index.js" }),
    );
    writeFileSync(
      join(root, "workflows", "echo", "index.js"),
      `export const meta = { name: "echo", description: "cwd" };\nreturn { tier: "cwd" };\n`,
    );
    // repo-tier pack (<root>/.pi/workflows/echo) — different content to distinguish
    mkdirSync(join(root, ".pi", "workflows", "echo"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "workflows", "echo", "manifest.json"),
      JSON.stringify({ name: "echo", description: "repo", entry: "index.js" }),
    );
    writeFileSync(
      join(root, ".pi", "workflows", "echo", "index.js"),
      `export const meta = { name: "echo", description: "repo" };\nreturn { tier: "repo" };\n`,
    );
    const r = resolveWorkflowScript("echo", { cwd: root }); // findRepoRoot(root) finds .pi/workflows → repo tiers reachable
    expect(r.source).toBe("cwd-workflows");
    expect(r.script).toContain('tier: "cwd"');
  });

  test("bin tier ranks BELOW cwd tier", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-wf-cwd3-"));
    const bin = mkdtempSync(join(tmpdir(), "pi-wf-bin2-"));
    for (const base of [cwd, bin]) {
      mkdirSync(join(base, "workflows", "echo"), { recursive: true });
      writeFileSync(
        join(base, "workflows", "echo", "manifest.json"),
        JSON.stringify({ name: "echo", description: base === cwd ? "cwd" : "bin", entry: "index.js" }),
      );
      writeFileSync(
        join(base, "workflows", "echo", "index.js"),
        `export const meta = { name: "echo", description: "${base === cwd ? "cwd" : "bin"}" };\nreturn { tier: "${base === cwd ? "cwd" : "bin"}" };\n`,
      );
    }
    const r = resolveWorkflowScript("echo", { cwd, binDir: bin });
    expect(r.source).toBe("cwd-workflows");
  });
});

// ── resolveWorkflowScript: workflow packs (folders + manifest.json) ───────

/** Create a pack fixture: <root>/<packName>/manifest.json + the entry script.
 *  Returns the pack dir. */
function makePack(
  root: string,
  packName: string,
  manifest: Record<string, unknown>,
  entryScript = "export const meta = { name: 'pack', description: 'd' };\nreturn { ok: true, args };\n",
): string {
  const packDir = join(root, packName);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(packDir, manifest.entry as string), entryScript);
  return packDir;
}

describe("resolveWorkflowScript — workflow packs", () => {
  test("resolves a literal pack dir path (manifest.json + entry)", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const packDir = makePack(root, "echo", { name: "echo", description: "smoke", entry: "index.js" });
    const r = resolveWorkflowScript(packDir);
    expect(r.source).toBe("path");
    expect(r.pack?.packDir).toBe(packDir);
    expect(r.pack?.manifest.name).toBe("echo");
    expect(r.path).toBe(join(packDir, "index.js"));
    expect(r.script).toContain("export const meta");
  });

  test("a literal dir WITHOUT manifest.json throws (not a silent not-found)", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const dir = join(root, "no-manifest");
    mkdirSync(dir, { recursive: true });
    expect(() => resolveWorkflowScript(dir)).toThrow(/without a manifest\.json/);
  });

  test("resolves a pack by NAME under .pi/workflows/<name>/", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    mkdirSync(join(root, ".pi", "workflows"), { recursive: true });
    makePack(join(root, ".pi", "workflows"), "echo", { name: "echo", description: "d", entry: "index.js" });
    const r = resolveWorkflowScript("echo", { cwd: root });
    expect(r.source).toBe(".pi/workflows");
    expect(r.pack?.manifest.name).toBe("echo");
    expect(r.path).toBe(join(root, ".pi", "workflows", "echo", "index.js"));
  });

  test("resolves a pack by NAME under bun-apps/<pkg>/workflows/<name>/", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    mkdirSync(join(root, "bun-apps", "s2-agent", "workflows"), { recursive: true });
    makePack(join(root, "bun-apps", "s2-agent", "workflows"), "args-demo", {
      name: "args-demo",
      description: "d",
      entry: "main.js",
    });
    const r = resolveWorkflowScript("args-demo", { cwd: root });
    expect(r.source).toBe("package-workflows");
    expect(r.pack?.manifest.entry).toBe("main.js");
  });

  test("single-file name still resolves to .js (backward compatible)", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    mkdirSync(join(root, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "workflows", "legacy.js"),
      "export const meta = { name: 'legacy', description: 'd' };\n",
    );
    const r = resolveWorkflowScript("legacy", { cwd: root });
    expect(r.source).toBe(".pi/workflows");
    expect(r.pack).toBeUndefined();
    expect(r.path).toBe(join(root, ".pi", "workflows", "legacy.js"));
  });

  test("a pack DIR wins over a same-name .js file (dir-first precedence)", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const wfDir = join(root, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "echo.js"), "export const meta = { name: 'file-echo', description: 'd' };\n");
    makePack(wfDir, "echo", { name: "pack-echo", description: "d", entry: "index.js" });
    const r = resolveWorkflowScript("echo", { cwd: root });
    expect(r.pack?.manifest.name).toBe("pack-echo");
  });

  test("a pack whose manifest entry file is missing throws a clear error", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const packDir = join(root, "broken");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, "manifest.json"),
      JSON.stringify({ name: "broken", description: "d", entry: "nope.js" }),
    );
    expect(() => resolveWorkflowScript(packDir)).toThrow(/entry|nope\.js/i);
  });
});

// ── resolveWorkflowPack (slim projection used by the workflow tool) ────────

describe("resolveWorkflowPack", () => {
  test("projects script + manifest for a pack dir", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const packDir = makePack(root, "echo", { name: "echo", description: "d", entry: "index.js" });
    const r = resolveWorkflowPack(packDir);
    expect(r.manifest?.name).toBe("echo");
    expect(r.entryPath).toBe(join(packDir, "index.js"));
    expect(r.script).toContain("export const meta");
    expect(r.source).toBe("path");
  });

  test("manifest is undefined for a single-file script", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    const p = join(dir, "f.js");
    writeFileSync(p, "export const meta = { name: 'f', description: 'd' };\n");
    const r = resolveWorkflowPack(p);
    expect(r.manifest).toBeUndefined();
    expect(r.script).toContain("'f'");
  });
});

// ── runWorkflowScript: dry-run + headless smoke (stub agent) ───────────────

/** A tiny workflow that calls agent() once and returns the result. */
const ECHO_WORKFLOW = `export const meta = {
  name: "echo",
  description: "smoke: one agent call, returns its result",
  phases: [{ title: "Echo" }],
}
const out = await agent("say hi", { label: "echo-1", phase: "Echo" })
return { echoed: out, args }
`;

describe("runWorkflowScript", () => {
  test("dry-run validates the script without calling the agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    writeFileSync(join(dir, "echo.js"), ECHO_WORKFLOW);

    const receipt = await runWorkflowScript({
      name: "echo.js",
      dryRun: true,
      cwd: dir,
      // Even without a stub agent, dry-run must NOT reach it.
      agent: {
        run: async () => {
          throw new Error("dry-run must not call the agent");
        },
      },
    });

    expect(receipt.dryRun).toBe(true);
    expect(receipt.meta.name).toBe("echo");
    expect(receipt.agentCount).toBe(0);
    expect(receipt.logs[0]).toContain("validated");
  });

  test("headless smoke run: engine vm + phase() + agent() work without VSCode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    writeFileSync(join(dir, "echo.js"), ECHO_WORKFLOW);

    let seenPrompt: string | undefined;
    const receipt = await runWorkflowScript({
      name: "echo.js",
      args: { source: "unit-test" },
      cwd: dir,
      persistLogs: false,
      agent: {
        run: async (prompt: string) => {
          seenPrompt = prompt;
          return "stub-reply";
        },
      } as any,
    });

    expect(receipt.dryRun).toBe(false);
    expect(receipt.meta.name).toBe("echo");
    expect(receipt.agentCount).toBe(1);
    expect(receipt.phases).toEqual(["Echo"]);
    expect(receipt.result).toEqual({ echoed: "stub-reply", args: { source: "unit-test" } });
    expect(seenPrompt).toBe("say hi");
  });

  test("missing script → throws (does not silently produce an empty run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    expect(runWorkflowScript({ name: "nope", cwd: dir, agent: { run: async () => "x" } as any })).rejects.toThrow(
      /"nope" not found/,
    );
  });

  test("--out-dir redirects the persisted run log to that folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    writeFileSync(join(dir, "echo.js"), ECHO_WORKFLOW);
    const outDir = mkdtempSync(join(tmpdir(), "wf-out-"));
    const receipt = await runWorkflowScript({
      name: "echo.js",
      cwd: dir,
      outDir,
      persistLogs: true,
      agent: { run: async () => "stub" } as any,
    });
    expect(receipt.agentCount).toBe(1);
    expect(receipt.runId).toBeTruthy();
    const logFile = join(outDir, `${receipt.runId}.log`);
    expect(existsSync(logFile)).toBe(true);
  });

  test("default outDir is PWD/.pi/workflows/runs when outDir omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    writeFileSync(join(dir, "echo.js"), ECHO_WORKFLOW);
    const receipt = await runWorkflowScript({
      name: "echo.js",
      cwd: dir,
      persistLogs: true,
      agent: { run: async () => "stub" } as any,
    });
    const expectedDir = join(dir, ".pi", "workflows", "runs");
    expect(existsSync(expectedDir)).toBe(true);
    expect(readdirSync(expectedDir).some((f) => f === `${receipt.runId}.log`)).toBe(true);
  });

  // ── model resolution (Task 2): resolveModel wired into runWorkflowScript ──

  test("no overrides -> model is the pi default (source pi-default), not undefined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    writeFileSync(join(dir, "echo.js"), ECHO_WORKFLOW);
    const receipt = await runWorkflowScript({
      name: "echo.js",
      cwd: dir,
      dryRun: true,
      piDefaultModel: "zai/glm-5.2",
      agent: {
        run: async () => {
          throw new Error("dry-run must not call the agent");
        },
      },
    });
    expect(receipt.model).toBe("zai/glm-5.2");
    expect(receipt.modelSource).toBe("pi-default");
  });

  test("manifest.model beats pi default (source manifest)", async () => {
    // args-demo is a real pack that declares
    //   "model": "lm-studio/prism-ml/bonsai-27b"
    // in its manifest. Even with a pi default supplied, the manifest must win.
    const argsDemoPack = resolve(import.meta.dirname, "../../s2-agent/workflows/args-demo");
    const manifest = require(`${argsDemoPack}/manifest.json`);
    const receipt = await runWorkflowScript({
      name: argsDemoPack,
      dryRun: true,
      piDefaultModel: "zai/glm-5.2",
    });
    expect(receipt.model).toBe(manifest.model);
    expect(receipt.modelSource).toBe("manifest");
  });
});

// ── mergeArgs / resolvePackOverrides (pure, Decision 5 precedence) ─────────

describe("mergeArgs — manifest default vs caller override", () => {
  test("no caller args → manifest args used as-is", () => {
    expect(mergeArgs({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
  test("no manifest args → caller args used as-is", () => {
    expect(mergeArgs(undefined, { b: 2 })).toEqual({ b: 2 });
  });
  test("both objects → shallow-merge, caller wins on key conflict", () => {
    expect(mergeArgs({ a: 1, b: 2 }, { b: 99, c: 3 })).toEqual({ a: 1, b: 99, c: 3 });
  });
  test("neither → undefined", () => {
    expect(mergeArgs(undefined, undefined)).toBeUndefined();
  });
  test("non-object args (array/string) → caller replaces entirely", () => {
    expect(mergeArgs([1, 2], [3])).toEqual([3]);
    expect(mergeArgs("manifest", "cli")).toBe("cli");
    expect(mergeArgs({ a: 1 }, "cli-overrides")).toBe("cli-overrides");
  });
});

describe("resolvePackOverrides — model + args precedence", () => {
  const pack = { manifest: { name: "p", description: "d", entry: "i.js", args: { x: 1 }, model: "manifest-model" } };
  test("caller model wins over manifest model", () => {
    expect(resolvePackOverrides(pack, { callerModel: "cli-model" }).model).toBe("cli-model");
  });
  test("manifest model used when no caller model", () => {
    expect(resolvePackOverrides(pack, {}).model).toBe("manifest-model");
  });
  test("no pack → caller args/model pass through", () => {
    expect(resolvePackOverrides(undefined, { args: { y: 2 }, callerModel: "cli" })).toEqual({
      args: { y: 2 },
      model: "cli",
    });
  });
  test("args merge applied", () => {
    expect(resolvePackOverrides(pack, { args: { x: 9, z: 2 } }).args).toEqual({ x: 9, z: 2 });
  });
});

// ── resolveModel (pure, 4-tier model precedence) ─────────────────────────────

describe("resolveModel — precedence --model > PI_MODEL > manifest > pi-default", () => {
  test("caller --model wins", () => {
    const r = resolveModel("cli/x", "env/y", "manifest/z", "pi/d");
    expect(r).toEqual({ model: "cli/x", source: "--model" });
  });
  test("env wins when no caller (PI_MODEL above manifest)", () => {
    const r = resolveModel(undefined, "env/y", "manifest/z", "pi/d");
    expect(r).toEqual({ model: "env/y", source: "env" });
  });
  test("manifest wins when no caller/env", () => {
    const r = resolveModel(undefined, undefined, "manifest/z", "pi/d");
    expect(r).toEqual({ model: "manifest/z", source: "manifest" });
  });
  test("pi-default wins when no caller/env/manifest", () => {
    const r = resolveModel(undefined, undefined, undefined, "pi/d");
    expect(r).toEqual({ model: "pi/d", source: "pi-default" });
  });
  test("all undefined -> {undefined, none}", () => {
    const r = resolveModel(undefined, undefined, undefined, undefined);
    expect(r).toEqual({ model: undefined, source: "none" });
  });
});

// ── runWorkflowScript: workflow packs (precedence end-to-end) ──────────────

describe("runWorkflowScript — workflow packs", () => {
  test("pack manifest.args flows as the default when no --args", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    makePack(root, "echo", { name: "echo", description: "d", entry: "index.js", args: { from: "manifest" } });
    const receipt = await runWorkflowScript({
      name: join(root, "echo"),
      persistLogs: false,
      agent: { run: async () => "stub" } as any,
    });
    expect(receipt.result).toEqual({ ok: true, args: { from: "manifest" } });
  });

  test("caller --args shallow-merges over manifest.args (caller wins)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    makePack(root, "echo", { name: "echo", description: "d", entry: "index.js", args: { a: 1, b: 2 } });
    const receipt = await runWorkflowScript({
      name: join(root, "echo"),
      args: { b: 99, c: 3 },
      persistLogs: false,
      agent: { run: async () => "stub" } as any,
    });
    expect((receipt.result as { args: unknown }).args).toEqual({ a: 1, b: 99, c: 3 });
  });

  test("pack dry-run parses the manifest + entry end-to-end (no agent)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    makePack(root, "echo", { name: "echo", description: "smoke", entry: "index.js" });
    const receipt = await runWorkflowScript({
      name: join(root, "echo"),
      dryRun: true,
      agent: {
        run: async () => {
          throw new Error("dry-run must not call the agent");
        },
      },
    });
    expect(receipt.dryRun).toBe(true);
    expect(receipt.meta.name).toBe("echo");
    expect(receipt.agentCount).toBe(0);
  });

  // The "real pack" destination-proof tests point at the example packs that now
  // live in s2-agent (bun-apps/s2-agent/workflows/). From this test dir that is
  // ../../s2-agent/workflows/<pack>.
  const CLI_WORKFLOWS = resolve(import.meta.dirname, "../../s2-agent/workflows");

  test("the real `echo` example pack resolves + dry-runs (destination proof)", async () => {
    const echoPackDir = join(CLI_WORKFLOWS, "echo");
    const receipt = await runWorkflowScript({ name: echoPackDir, dryRun: true });
    expect(receipt.dryRun).toBe(true);
    expect(receipt.meta.name).toBe("echo");
    expect(receipt.source).toBe("path");
    expect(receipt.logs[0]).toContain("pack");
  });

  test("the real `echo` pack runs live with a stub agent", async () => {
    const echoPackDir = join(CLI_WORKFLOWS, "echo");
    const receipt = await runWorkflowScript({
      name: echoPackDir,
      args: { msg: "hello pack" },
      persistLogs: false,
      agent: { run: async () => "stub-echo" } as any,
    });
    expect(receipt.meta.name).toBe("echo");
    expect(receipt.agentCount).toBe(1);
    expect((receipt.result as { args: unknown }).args).toEqual({ msg: "hello pack" });
  });

  test("the real `args-demo` pack dry-runs (parses)", async () => {
    const receipt = await runWorkflowScript({ name: join(CLI_WORKFLOWS, "args-demo"), dryRun: true });
    expect(receipt.meta.name).toBe("args-demo");
    expect(receipt.dryRun).toBe(true);
  });

  test("the real `args-demo` pack exercises parallel() with manifest default args", async () => {
    const receipt = await runWorkflowScript({
      name: join(CLI_WORKFLOWS, "args-demo"),
      persistLogs: false,
      agent: { run: async () => "stub" } as any,
    });
    expect(receipt.agentCount).toBe(2); // parallel() over default topics [alpha, beta]
    expect(receipt.phases).toEqual(["FanOut"]);
    const result = receipt.result as { topics: string[]; results: unknown[] };
    expect(result.topics).toEqual(["alpha", "beta"]);
    expect(result.results).toHaveLength(2);
  });

  test("the real `args-demo` pack: --args overrides manifest topics", async () => {
    const receipt = await runWorkflowScript({
      name: join(CLI_WORKFLOWS, "args-demo"),
      args: { topics: ["only-one"] },
      persistLogs: false,
      agent: { run: async () => "x" } as any,
    });
    expect(receipt.agentCount).toBe(1);
  });

  test("the real `sample` pack dry-runs (full-surface manifest parses)", async () => {
    const receipt = await runWorkflowScript({ name: join(CLI_WORKFLOWS, "sample"), dryRun: true });
    expect(receipt.dryRun).toBe(true);
    expect(receipt.meta.name).toBe("sample");
    expect(receipt.source).toBe("path");
    expect(receipt.agentCount).toBe(0);
  });

  test("the real `sample` pack exercises pipeline()/phase()/log() with default args", async () => {
    const receipt = await runWorkflowScript({
      name: join(CLI_WORKFLOWS, "sample"),
      persistLogs: false,
      agent: { run: async () => "stub" } as any,
    });
    expect(receipt.meta.name).toBe("sample");
    expect(receipt.agentCount).toBe(3); // pipeline() over default items [alpha, beta, gamma]
    expect(receipt.phases).toEqual(["FanOut", "Summarise"]);
    const result = receipt.result as { items: string[]; notes: unknown[] };
    expect(result.items).toEqual(["alpha", "beta", "gamma"]);
    expect(result.notes).toHaveLength(3);
  });

  test("the real `sample` pack: --args overrides manifest items", async () => {
    const receipt = await runWorkflowScript({
      name: join(CLI_WORKFLOWS, "sample"),
      args: { items: ["solo"] },
      persistLogs: false,
      agent: { run: async () => "x" } as any,
    });
    expect(receipt.agentCount).toBe(1);
  });
});

// ── listWorkflows (enumerates packs + single-file scripts) ─────────────────

describe("listWorkflows", () => {
  test("lists packs and single-file scripts together", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const wfDir = join(root, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "legacy.js"), "export const meta = { name: 'legacy', description: 'a file' };\n");
    makePack(wfDir, "echo", { name: "echo", description: "a pack", entry: "index.js" });
    const { rows } = listWorkflows(root);
    expect(rows.map((r) => r.name).sort()).toEqual(["echo", "legacy"]);
    const echo = rows.find((r) => r.name === "echo")!;
    expect(echo.kind).toBe("pack");
    expect(echo.source).toBe(".pi/workflows");
    const legacy = rows.find((r) => r.name === "legacy")!;
    expect(legacy.kind).toBe("file");
  });

  test("pack rows render name/description from the manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const wfDir = join(root, "bun-apps", "s2-agent", "workflows");
    mkdirSync(wfDir, { recursive: true });
    makePack(wfDir, "args-demo", { name: "args-demo", description: "demo desc", entry: "main.js" });
    const { rows } = listWorkflows(root);
    const row = rows.find((r) => r.name === "args-demo")!;
    expect(row.description).toBe("demo desc");
    expect(row.source).toBe("bun-apps/s2-agent/workflows");
    expect(row.kind).toBe("pack");
  });

  test("a malformed pack is reported in errors, not dropped (other rows still list)", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const wfDir = join(root, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "good.js"), "export const meta = { name: 'good', description: 'g' };\n");
    const badDir = join(wfDir, "broken");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "manifest.json"), "{not json}");
    const { rows, errors } = listWorkflows(root);
    expect(rows.map((r) => r.name)).toContain("good");
    expect(errors.some((e) => e.path === badDir)).toBe(true);
  });

  test("directories without manifest.json are skipped silently", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const wfDir = join(root, ".pi", "workflows");
    mkdirSync(wfDir, { recursive: true });
    mkdirSync(join(wfDir, "just-a-dir"), { recursive: true });
    const { rows, errors } = listWorkflows(root);
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
  });

  // D5-1 — listWorkflows enumerates `.pi/workflows` BEFORE any `bun-apps/<pkg>`
  // row. The dirs[] array in listWorkflows is built as
  //   [ { ".pi/workflows", ... }, ...bun-apps/<pkg>/workflows (one per pkg) ]
  // so .pi rows always come first. This pins the source-ordering guarantee so a
  // refactor that reorders the dirs[] array (or sorts rows[] alphabetically by
  // source AFTER the fact) cannot silently break the .pi-first precedence.
  //
  // NOTE: the per-package ordering among `bun-apps/<pkg>` entries is
  // filesystem-dependent (readdir order, NOT sorted) — this test deliberately
  // does NOT assert any specific pkg-vs-pkg order, only the .pi-before-bun-apps
  // guarantee.
  test("a `.pi/workflows` row is always listed BEFORE any `bun-apps/<pkg>` row (D5-1)", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    // Place a pack under .pi/workflows (the user-private root).
    const piDir = join(root, ".pi", "workflows");
    mkdirSync(piDir, { recursive: true });
    makePack(piDir, "pi-first", { name: "pi-first", description: "from .pi", entry: "index.js" });
    // Place a DIFFERENT pack under bun-apps/<pkg>/workflows (a shipped pack).
    const pkgDir = join(root, "bun-apps", "s2-agent", "workflows");
    mkdirSync(pkgDir, { recursive: true });
    makePack(pkgDir, "pkg-second", { name: "pkg-second", description: "from pkg", entry: "main.js" });

    const { rows } = listWorkflows(root);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const piIdx = rows.findIndex((r) => r.source === ".pi/workflows");
    const pkgIdx = rows.findIndex((r) => r.source.startsWith("bun-apps/"));
    expect(piIdx).toBeGreaterThanOrEqual(0);
    expect(pkgIdx).toBeGreaterThanOrEqual(0);
    expect(piIdx).toBeLessThan(pkgIdx);
  });

  test("enumerates packs in <cwd>/workflows and <binDir>/workflows (portable tiers)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-ls-cwd-"));
    const bin = mkdtempSync(join(tmpdir(), "pi-ls-bin-"));
    // claudeRoot with no repo dirs → only the portable tiers should surface
    const claudeRoot = mkdtempSync(join(tmpdir(), "pi-ls-root-"));
    for (const [base, label] of [
      [cwd, "cwd"],
      [bin, "bin"],
    ] as const) {
      mkdirSync(join(base, "workflows", "echo"), { recursive: true });
      writeFileSync(
        join(base, "workflows", "echo", "manifest.json"),
        JSON.stringify({ name: "echo", description: label, entry: "index.js" }),
      );
      writeFileSync(
        join(base, "workflows", "echo", "index.js"),
        `export const meta = { name: "echo", description: "${label}" };\nreturn {};\n`,
      );
    }
    const { rows } = listWorkflows(claudeRoot, { cwd, binDir: bin });
    const sources = rows.map((r) => r.source);
    expect(sources).toContain("cwd/workflows");
    expect(sources).toContain("bin/workflows");
    // Display ordering mirrors resolution precedence (first hit wins):
    // <cwd>/workflows ranks ABOVE <binDir>/workflows. This fixture's claudeRoot
    // is a bare mkdtemp with no .pi/bun-apps dirs, so only the two portable
    // tiers are present — assert cwd-before-bin here.
    expect(sources.indexOf("cwd/workflows")).toBeLessThan(sources.indexOf("bin/workflows"));
    expect(rows.find((r) => r.source === "cwd/workflows" && r.name === "echo")).toBeTruthy();
  });
});

// ── findRepoRoot — walk-up cap ─────────────────────────────────────────────

describe("findRepoRoot — walk-up cap", () => {
  test("returns the root when a marker is found within the 12-iteration cap", () => {
    // Build a synthetic exists() that reports a marker exactly at depth 11.
    // Each dirname step peels one segment; count segments from `start`.
    const segments = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "rootMarker"];
    const start = `/${segments.join("/")}/leaf`;
    // exists() returns true only for the path ending in rootMarker/.pi/workflows
    const exists = (p: string) => p.endsWith("/rootMarker/.pi/workflows");
    const expectedRoot = `/${segments.join("/")}`;
    expect(findRepoRoot(start, exists)).toBe(expectedRoot);
  });
  test("returns undefined when no marker is found within 12 levels (cap prevents infinite walk)", () => {
    // A path deeper than 12 segments with no marker anywhere → undefined, fast.
    const deep = `/${Array.from({ length: 30 }, (_, i) => `d${i}`).join("/")}/leaf`;
    const exists = (_p: string) => false;
    expect(findRepoRoot(deep, exists)).toBeUndefined();
  });
  test("stops at the filesystem root without throwing (dirname === dir termination)", () => {
    expect(findRepoRoot("/", () => false)).toBeUndefined();
  });
});
