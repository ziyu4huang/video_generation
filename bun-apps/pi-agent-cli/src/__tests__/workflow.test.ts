import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	resolveWorkflowScript,
	parseWorkflowArgs,
	runWorkflowScript,
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
			agent: {
				run: async (prompt: string) => {
					seenPrompt = prompt;
					return "stub-reply";
				},
			},
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
			runWorkflowScript({ name: "nope", cwd: dir, agent: { run: async () => "x" } }),
		).rejects.toThrow(/"nope" not found/);
	});
});
