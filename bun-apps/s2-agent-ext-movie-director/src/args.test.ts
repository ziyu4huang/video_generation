import { describe, expect, test } from "bun:test";
import { parseArgs, coerceValue } from "./args.ts";

describe("parseArgs — positionals + command", () => {
	test("collects bare positionals in order", () => {
		const p = parseArgs(["preflight", "extra"]);
		expect(p.positionals).toEqual(["preflight", "extra"]);
	});

	test("treats a bare dash as a positional (stdin marker)", () => {
		const p = parseArgs(["-"]);
		expect(p.positionals).toEqual(["-"]);
	});
});

describe("parseArgs — global flags", () => {
	test("--json / --dry-run / --help / --version set booleans", () => {
		const p = parseArgs(["--json", "--dry-run", "--help", "--version", "x"]);
		expect(p.json).toBe(true);
		expect(p.dryRun).toBe(true);
		expect(p.help).toBe(true);
		expect(p.version).toBe(true);
		expect(p.positionals).toEqual(["x"]);
	});

	test("-V / --verbose count (repeatable + stacked short)", () => {
		expect(parseArgs(["-V"]).verbose).toBe(1);
		expect(parseArgs(["--verbose", "--verbose"]).verbose).toBe(2);
		expect(parseArgs(["-VV"]).verbose).toBe(2);
		expect(parseArgs(["-Vh"]).verbose).toBe(1);
		expect(parseArgs(["-Vh"]).help).toBe(true);
	});

	test("--model/--provider/--thinking/--mode consume the next token", () => {
		const p = parseArgs(["--model", "sonnet", "--provider", "lm-studio", "--thinking", "high", "--mode", "json"]);
		expect(p.model).toBe("sonnet");
		expect(p.provider).toBe("lm-studio");
		expect(p.thinking).toBe("high");
		expect(p.mode).toBe("json");
	});

	test("--model=gemma inline form", () => {
		expect(parseArgs(["--model=bonsai-27b"]).model).toBe("bonsai-27b");
	});
});

describe("parseArgs — loose flags → options (coerced)", () => {
	test("string value", () => {
		expect(parseArgs(["--pipeline", "talking-head"]).options).toEqual({ pipeline: "talking-head" });
	});

	test("number value", () => {
		expect(parseArgs(["--frames", "200"]).options).toEqual({ frames: 200 });
	});

	test("boolean value via 'true'", () => {
		expect(parseArgs(["--humanApproved", "true"]).options).toEqual({ humanApproved: true });
	});

	test("boolean flag with no value → true", () => {
		expect(parseArgs(["--humanApproved"]).options).toEqual({ humanApproved: true });
	});

	test("boolean flag stops at the next dash flag", () => {
		const o = parseArgs(["--humanApproved", "--pipeline", "foo"]).options;
		expect(o).toEqual({ humanApproved: true, pipeline: "foo" });
	});

	test("underscored string stays a string (not a parse error)", () => {
		expect(parseArgs(["--status", "in_progress"]).options).toEqual({ status: "in_progress" });
	});

	test("--key=value inline form", () => {
		expect(parseArgs(["--frames=240"]).options).toEqual({ frames: 240 });
	});

	test("negative number via = form (not the consume-next rule)", () => {
		expect(parseArgs(["--offset=-5"]).options).toEqual({ offset: -5 });
	});

	test("JSON array value", () => {
		expect(parseArgs(["--labels", '["a","b"]']).options).toEqual({ labels: ["a", "b"] });
	});

	test("last-write wins on repeated flag", () => {
		expect(parseArgs(["--stage", "idea", "--stage", "script"]).options).toEqual({ stage: "script" });
	});
});

describe("parseArgs — --options JSON merge", () => {
	test("merges a JSON object into options", () => {
		const o = parseArgs(["--options", '{"projectId":"p1","stage":"idea"}']).options;
		expect(o).toEqual({ projectId: "p1", stage: "idea" });
	});

	test("nested object survives intact", () => {
		const o = parseArgs(["--options", '{"editDecisions":{"version":1,"cuts":[]}}']).options;
		expect(o).toEqual({ editDecisions: { version: 1, cuts: [] } });
	});

	test("non-object JSON (string/number/array) is ignored, not crashed", () => {
		expect(parseArgs(["--options", '"hello"']).options).toEqual({});
		expect(parseArgs(["--options", "42"]).options).toEqual({});
		expect(parseArgs(["--options", "[1,2]"]).options).toEqual({});
	});

	test("loose flag wins over --options on conflict (applied in order)", () => {
		// --options first, then --stage overrides it.
		const o = parseArgs(["--options", '{"stage":"idea"}', "--stage", "script"]).options;
		expect(o).toEqual({ stage: "script" });
	});
});

describe("parseArgs — -- separator", () => {
	test("everything after -- is doubleDash verbatim", () => {
		const p = parseArgs(["agent", "--", "produce", "--idea", '"x"']);
		expect(p.positionals).toEqual(["agent"]);
		expect(p.doubleDash).toEqual(["produce", "--idea", '"x"']);
	});

	test("a dash-leading positional is protected by --", () => {
		const p = parseArgs(["--", "-5", "degrees"]);
		expect(p.doubleDash).toEqual(["-5", "degrees"]);
	});
});

describe("coerceValue", () => {
	test("number, boolean, string, null", () => {
		expect(coerceValue("200")).toBe(200);
		expect(coerceValue("true")).toBe(true);
		expect(coerceValue("false")).toBe(false);
		expect(coerceValue("null")).toBeNull();
		expect(coerceValue("in_progress")).toBe("in_progress");
	});
});
