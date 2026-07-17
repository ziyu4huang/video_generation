import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	resolveWorkflowScript,
	parseWorkflowArgs,
	runWorkflowScript,
	mergeArgs,
	resolvePackOverrides,
	listWorkflows,
} from "../commands/workflow.ts";
import { findCommandToken } from "../cli.ts";

/**
 * `workflow run/list` — the headless engine runner.
 *
 * These tests exercise the pure pieces (script resolution, --args parsing, the
 * reserved-token dispatch) and ONE end-to-end smoke run with a stub agent
 * (no LLM, no network) so the engine's vm + phase() + agent() globals are
 * proven to work headlessly — the core de-risk for the keystone.
 */

// ── parseWorkflowArgs ──────────────────────────────────────────────────────

describe("parseWorkflowArgs", () => {
	test("undefined / empty → undefined (script sees no `args` global change)", () => {
		expect(parseWorkflowArgs(undefined)).toBeUndefined();
		expect(parseWorkflowArgs("")).toBeUndefined();
	});

	test("valid JSON object is parsed", () => {
		expect(parseWorkflowArgs('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
	});

	test("valid JSON array is parsed", () => {
		expect(parseWorkflowArgs("[1,2,3]")).toEqual([1, 2, 3]);
	});

	test("bad JSON throws a clear, prefixed error (not an opaque SyntaxError)", () => {
		expect(() => parseWorkflowArgs("{not json}")).toThrow(/--args must be valid JSON/);
	});
});

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
		expect(() => resolveWorkflowScript("does-not-exist", { cwd: dir })).toThrow(
			/"does-not-exist" not found/,
		);
	});

	test("resolves .claude/workflows/<name>.js from a fake repo root", () => {
		const root = mkdtempSync(join(tmpdir(), "wf-"));
		mkdirSync(join(root, ".claude", "workflows"), { recursive: true });
		const p = join(root, ".claude", "workflows", "demo.js");
		writeFileSync(p, "export const meta = { name: 'demo', description: 'd' };\n");
		const r = resolveWorkflowScript("demo", { cwd: root });
		expect(r.source).toBe(".claude/workflows");
		expect(r.path).toBe(p);
	});

	test("resolves bun-apps/<pkg>/workflows/<name>.js from a fake repo root", () => {
		const root = mkdtempSync(join(tmpdir(), "wf-"));
		mkdirSync(join(root, "bun-apps", "pi-agent-ext-demo", "workflows"), { recursive: true });
		const p = join(root, "bun-apps", "pi-agent-ext-demo", "workflows", "thing.js");
		writeFileSync(p, "export const meta = { name: 'thing', description: 'd' };\n");
		const r = resolveWorkflowScript("thing", { cwd: root });
		expect(r.source).toBe("package-workflows");
		expect(r.path).toBe(p);
	});

	test("accepts a name with explicit .js suffix under .claude/workflows", () => {
		const root = mkdtempSync(join(tmpdir(), "wf-"));
		mkdirSync(join(root, ".claude", "workflows"), { recursive: true });
		writeFileSync(
			join(root, ".claude", "workflows", "suf.js"),
			"export const meta = { name: 'suf', description: 'd' };\n",
		);
		const r = resolveWorkflowScript("suf.js", { cwd: root });
		expect(r.source).toBe(".claude/workflows");
	});
});

// ── dispatch: `workflow` namespace reserved ────────────────────────────────

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

	test("resolves a pack by NAME under .claude/workflows/<name>/", () => {
		const root = mkdtempSync(join(tmpdir(), "wf-"));
		mkdirSync(join(root, ".claude", "workflows"), { recursive: true });
		makePack(join(root, ".claude", "workflows"), "echo", { name: "echo", description: "d", entry: "index.js" });
		const r = resolveWorkflowScript("echo", { cwd: root });
		expect(r.source).toBe(".claude/workflows");
		expect(r.pack?.manifest.name).toBe("echo");
		expect(r.path).toBe(join(root, ".claude", "workflows", "echo", "index.js"));
	});

	test("resolves a pack by NAME under bun-apps/<pkg>/workflows/<name>/", () => {
		const root = mkdtempSync(join(tmpdir(), "wf-"));
		mkdirSync(join(root, "bun-apps", "pi-agent-cli", "workflows"), { recursive: true });
		makePack(join(root, "bun-apps", "pi-agent-cli", "workflows"), "args-demo", { name: "args-demo", description: "d", entry: "main.js" });
		const r = resolveWorkflowScript("args-demo", { cwd: root });
		expect(r.source).toBe("package-workflows");
		expect(r.pack?.manifest.entry).toBe("main.js");
	});

	test("single-file name still resolves to .js (backward compatible)", () => {
		const root = mkdtempSync(join(tmpdir(), "wf-"));
		mkdirSync(join(root, ".claude", "workflows"), { recursive: true });
		writeFileSync(join(root, ".claude", "workflows", "legacy.js"), "export const meta = { name: 'legacy', description: 'd' };\n");
		const r = resolveWorkflowScript("legacy", { cwd: root });
		expect(r.source).toBe(".claude/workflows");
		expect(r.pack).toBeUndefined();
		expect(r.path).toBe(join(root, ".claude", "workflows", "legacy.js"));
	});

	test("a pack DIR wins over a same-name .js file (dir-first precedence)", () => {
		const root = mkdtempSync(join(tmpdir(), "wf-"));
		const wfDir = join(root, ".claude", "workflows");
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
		writeFileSync(join(packDir, "manifest.json"), JSON.stringify({ name: "broken", description: "d", entry: "nope.js" }));
		expect(() => resolveWorkflowScript(packDir)).toThrow(/entry|nope\.js/i);
	});
});

describe("workflow namespace dispatch", () => {
	test("`workflow` is reserved so it dispatches (not a passthrough prompt)", () => {
		expect(findCommandToken(["workflow", "run", "closed-loop-proof"])).toEqual({
			name: "workflow",
			index: 0,
		});
	});

	test("`workflow run` survives a leading global --model flag", () => {
		expect(findCommandToken(["--model", "x", "workflow", "run", "demo"])).toEqual({
			name: "workflow",
			index: 2,
		});
	});

	test("both sub-commands are reserved (run, list)", () => {
		// Sub-commands are reserved so they are never swallowed as a prompt when
		// they appear as the first positional after `workflow` is stripped.
		expect(findCommandToken(["run"])).toEqual({ name: "run", index: 0 });
		expect(findCommandToken(["list"])).toEqual({ name: "list", index: 0 });
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
			agent: { run: async () => { throw new Error("dry-run must not call the agent"); } },
		});

		expect(receipt.dryRun).toBe(true);
		expect(receipt.meta.name).toBe("echo");
		expect(receipt.agentCount).toBe(0);
		expect(receipt.logs[0]).toContain("validated");
	});

	test("headless smoke run: engine vm + phase() + agent() work without VSCode", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wf-"));
		writeFileSync(join(dir, "echo.js"), ECHO_WORKFLOW);

		// Stub agent: proves runWorkflow runs headlessly (no editor services) and
		// that the `args` global is threaded through. The real WorkflowAgent uses
		// createAgentSession (the same SDK pi-agent-cli uses) — no VSCode deps.
		let seenPrompt: string | undefined;
		const receipt = await runWorkflowScript({
			name: "echo.js",
			args: { source: "unit-test" },
			cwd: dir,
			persistLogs: false,
			// Cast: the real WorkflowAgent.run is a schema-typed generic method;
			// this stub always returns a plain string, so it can't structurally
			// satisfy the generic signature (see RunWorkflowScriptOptions.agent).
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
		expect(
			runWorkflowScript({ name: "nope", cwd: dir, agent: { run: async () => "x" } as any }),
		).rejects.toThrow(/"nope" not found/);
	});
});

// ── mergeArgs / resolvePackOverrides (pure, Decision 5 precedence) ─────────

describe("mergeArgs — manifest default vs CLI override", () => {
	test("no CLI args → manifest args used as-is", () => {
		expect(mergeArgs({ a: 1 }, undefined)).toEqual({ a: 1 });
	});
	test("no manifest args → CLI args used as-is", () => {
		expect(mergeArgs(undefined, { b: 2 })).toEqual({ b: 2 });
	});
	test("both objects → shallow-merge, CLI wins on key conflict", () => {
		expect(mergeArgs({ a: 1, b: 2 }, { b: 99, c: 3 })).toEqual({ a: 1, b: 99, c: 3 });
	});
	test("neither → undefined", () => {
		expect(mergeArgs(undefined, undefined)).toBeUndefined();
	});
	test("non-object args (array/string) → CLI replaces entirely", () => {
		expect(mergeArgs([1, 2], [3])).toEqual([3]);
		expect(mergeArgs("manifest", "cli")).toBe("cli");
		expect(mergeArgs({ a: 1 }, "cli-overrides")).toBe("cli-overrides");
	});
});

describe("resolvePackOverrides — model + args precedence", () => {
	const pack = { manifest: { name: "p", description: "d", entry: "i.js", args: { x: 1 }, model: "manifest-model" } };
	test("CLI model wins over manifest model", () => {
		expect(resolvePackOverrides(pack, { model: "cli-model" }).model).toBe("cli-model");
	});
	test("manifest model used when no CLI model", () => {
		expect(resolvePackOverrides(pack, {}).model).toBe("manifest-model");
	});
	test("no pack → CLI args/model pass through", () => {
		expect(resolvePackOverrides(undefined, { args: { y: 2 }, model: "cli" })).toEqual({ args: { y: 2 }, model: "cli" });
	});
	test("args merge applied", () => {
		expect(resolvePackOverrides(pack, { args: { x: 9, z: 2 } }).args).toEqual({ x: 9, z: 2 });
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

	test("CLI --args shallow-merges over manifest.args (CLI wins)", async () => {
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
			agent: { run: async () => { throw new Error("dry-run must not call the agent"); } },
		});
		expect(receipt.dryRun).toBe(true);
		expect(receipt.meta.name).toBe("echo");
		expect(receipt.agentCount).toBe(0);
	});

	test("the real `echo` example pack resolves + dry-runs (destination proof)", async () => {
		const echoPackDir = resolve(import.meta.dirname, "../../workflows/echo");
		const receipt = await runWorkflowScript({ name: echoPackDir, dryRun: true });
		expect(receipt.dryRun).toBe(true);
		expect(receipt.meta.name).toBe("echo");
		expect(receipt.source).toBe("path");
		expect(receipt.logs[0]).toContain("pack");
	});

	test("the real `echo` pack runs live with a stub agent", async () => {
		const echoPackDir = resolve(import.meta.dirname, "../../workflows/echo");
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
		const dir = resolve(import.meta.dirname, "../../workflows/args-demo");
		const receipt = await runWorkflowScript({ name: dir, dryRun: true });
		expect(receipt.meta.name).toBe("args-demo");
		expect(receipt.dryRun).toBe(true);
	});

	test("the real `args-demo` pack exercises parallel() with manifest default args", async () => {
		const dir = resolve(import.meta.dirname, "../../workflows/args-demo");
		const receipt = await runWorkflowScript({
			name: dir,
			persistLogs: false,
			agent: { run: async () => "stub" } as any,
		});
		expect(receipt.agentCount).toBe(2); // parallel() fans out over default topics [alpha, beta]
		expect(receipt.phases).toEqual(["FanOut"]);
		const result = receipt.result as { topics: string[]; results: unknown[] };
		expect(result.topics).toEqual(["alpha", "beta"]);
		expect(result.results).toHaveLength(2);
	});

	test("the real `args-demo` pack: --args overrides manifest topics", async () => {
		const dir = resolve(import.meta.dirname, "../../workflows/args-demo");
		const receipt = await runWorkflowScript({
			name: dir,
			args: { topics: ["only-one"] },
			persistLogs: false,
			agent: { run: async () => "x" } as any,
		});
		expect(receipt.agentCount).toBe(1);
	});

	test("the real `sample` pack dry-runs (full-surface manifest parses)", async () => {
		const dir = resolve(import.meta.dirname, "../../workflows/sample");
		const receipt = await runWorkflowScript({ name: dir, dryRun: true });
		expect(receipt.dryRun).toBe(true);
		expect(receipt.meta.name).toBe("sample");
		expect(receipt.source).toBe("path");
		expect(receipt.agentCount).toBe(0);
	});

	test("the real `sample` pack exercises pipeline()/phase()/log() with default args", async () => {
		const dir = resolve(import.meta.dirname, "../../workflows/sample");
		const receipt = await runWorkflowScript({
			name: dir,
			persistLogs: false,
			agent: { run: async () => "stub" } as any,
		});
		expect(receipt.meta.name).toBe("sample");
		expect(receipt.agentCount).toBe(3); // pipeline() over default items [alpha, beta, gamma], one agent() each
		expect(receipt.phases).toEqual(["FanOut", "Summarise"]);
		const result = receipt.result as { items: string[]; notes: unknown[] };
		expect(result.items).toEqual(["alpha", "beta", "gamma"]);
		expect(result.notes).toHaveLength(3);
	});

	test("the real `sample` pack: --args overrides manifest items", async () => {
		const dir = resolve(import.meta.dirname, "../../workflows/sample");
		const receipt = await runWorkflowScript({
			name: dir,
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
		const wfDir = join(root, ".claude", "workflows");
		mkdirSync(wfDir, { recursive: true });
		writeFileSync(join(wfDir, "legacy.js"), "export const meta = { name: 'legacy', description: 'a file' };\n");
		makePack(wfDir, "echo", { name: "echo", description: "a pack", entry: "index.js" });
		const { rows } = listWorkflows(root);
		expect(rows.map((r) => r.name).sort()).toEqual(["echo", "legacy"]);
		const echo = rows.find((r) => r.name === "echo")!;
		expect(echo.kind).toBe("pack");
		expect(echo.source).toBe(".claude/workflows");
		const legacy = rows.find((r) => r.name === "legacy")!;
		expect(legacy.kind).toBe("file");
	});

	test("pack rows render name/description from the manifest", () => {
		const root = mkdtempSync(join(tmpdir(), "wf-"));
		const wfDir = join(root, "bun-apps", "pi-agent-cli", "workflows");
		mkdirSync(wfDir, { recursive: true });
		makePack(wfDir, "args-demo", { name: "args-demo", description: "demo desc", entry: "main.js" });
		const { rows } = listWorkflows(root);
		const row = rows.find((r) => r.name === "args-demo")!;
		expect(row.description).toBe("demo desc");
		expect(row.source).toBe("bun-apps/pi-agent-cli/workflows");
		expect(row.kind).toBe("pack");
	});

	test("a malformed pack is reported in errors, not dropped (other rows still list)", () => {
		const root = mkdtempSync(join(tmpdir(), "wf-"));
		const wfDir = join(root, ".claude", "workflows");
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
		const wfDir = join(root, ".claude", "workflows");
		mkdirSync(wfDir, { recursive: true });
		mkdirSync(join(wfDir, "just-a-dir"), { recursive: true });
		const { rows, errors } = listWorkflows(root);
		expect(rows).toEqual([]);
		expect(errors).toEqual([]);
	});
});
