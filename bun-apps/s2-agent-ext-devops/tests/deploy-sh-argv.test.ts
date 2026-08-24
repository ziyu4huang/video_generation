import { describe, expect, test } from "bun:test";
import { parseDeployShArgv } from "../src/deploy-sh-argv.ts";

describe("parseDeployShArgv", () => {
	test("no flags means a full deploy", () => {
		const r = parseDeployShArgv([]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.action).toEqual({ kind: "deploy", options: {} });
	});

	test("--list is its own action", () => {
		const r = parseDeployShArgv(["--list"]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.action.kind).toBe("list");
	});

	test("--help is its own action", () => {
		const r = parseDeployShArgv(["--help"]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.action.kind).toBe("help");
	});

	test("--ext is rejected — version dirs are immutable (Phase 3 deleted the in-place rebuild)", () => {
		const r = parseDeployShArgv(["--ext", "task"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/--ext/);
	});

	test("parses value flags in both forms", () => {
		const r = parseDeployShArgv(["--out=/tmp/a", "--version", "9.9.9"]);
		expect(r.ok).toBe(true);
		if (r.ok && r.action.kind === "deploy") {
			expect(r.action.options.outRoot).toBe("/tmp/a");
			expect(r.action.options.version).toBe("9.9.9");
		}
	});

	test("--config is retired (registry-code-as-config t03) and errors loudly", () => {
		const r = parseDeployShArgv(["--config=/tmp/c.yaml"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/--config is retired.*registry-config/);
	});

	test("parses negation flags", () => {
		const r = parseDeployShArgv(["--no-freeze", "--no-current", "--force"]);
		expect(r.ok).toBe(true);
		if (r.ok && r.action.kind === "deploy") {
			expect(r.action.options.freeze).toBe(false);
			expect(r.action.options.current).toBe(false);
			expect(r.action.options.force).toBe(true);
		}
	});

	test("rejects an unknown flag", () => {
		const r = parseDeployShArgv(["--nope"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/--nope/);
	});

	test("rejects a value flag with no value", () => {
		const r = parseDeployShArgv(["--out"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/--out/);
	});

	test("rejects a positional argument", () => {
		const r = parseDeployShArgv(["extra"]);
		expect(r.ok).toBe(false);
	});

	test("rejects --list combined with deploy flags", () => {
		const r = parseDeployShArgv(["--list", "--force"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/--list/);
	});

	test("--list still accepts --out", () => {
		const r = parseDeployShArgv(["--list", "--out", "/tmp/a"]);
		expect(r.ok).toBe(true);
		if (r.ok && r.action.kind === "list") expect(r.action.outRoot).toBe("/tmp/a");
	});
});
