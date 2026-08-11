import { test, expect, describe } from "bun:test";
import { parseWorkflowArgs } from "../commands/workflow.ts";
import { findCommandToken } from "../dispatch.ts";

/**
 * `workflow run/list` — the CLI command layer.
 *
 * The pack resolver + orchestration now live in the engine
 * (`@repo/pi-agent-ext-workflow` `workflow-pack.ts`) and are shared with the
 * `workflow` tool's `name` parameter; their tests live in the engine. This file
 * covers the CLI-only surface: `--args` JSON parsing and the `workflow` namespace
 * dispatch (reserved-token routing). End-to-end pack runs are exercised by the
 * engine's workflow-pack tests (which point at the example packs in this
 * package's `workflows/` dir) and by `workflow-retrieval-quality.test.ts`.
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
