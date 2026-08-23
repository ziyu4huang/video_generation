/**
 * deploy_pi_agent_sh now SPAWNS deploy-cli.ts (the pipeline is not imported —
 * importing it would fold its module-scope import.meta paths into the shipped
 * bundle, which the deploy relocatability gate rejects). So there is no
 * in-process params→DeployShOptions mapping left to test; what this suite
 * covers is the subprocess contract: the argv mapping, the fail-closed
 * resolve, the CLI's combined-stream JSON extraction, and the shaping of its
 * result into DeployResult. The spawn seam is injected — a real deploy
 * (build + gates + E2E model probe) must never run in unit tests.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { deployViaCli, parseCliJson, runDeploy, type DeployResult } from "../src/deploy-tool.ts";
import type { RunOpts, RunResult } from "../src/deploy-run.ts";

const PI_AGENT_DIR = "/repo/bun-apps/s2-agent";
const CLI = join("/repo/bun-apps/s2-agent-ext-devops", "src", "deploy-cli.ts");

function fakeSpawn(result: Partial<RunResult>, capture?: (opts: RunOpts) => void) {
	return async (opts: RunOpts): Promise<RunResult> => {
		capture?.(opts);
		return { exitCode: 0, output: "", logPath: "/tmp/log", timedOut: false, ...result };
	};
}

const okJson = JSON.stringify(
	{
		ok: true,
		version: "0.1.0+gabc1234",
		target: "/dist/s2-agent-sh/0.1.0+gabc1234",
		extensions: [{ name: "devops", bytes: 1000 }],
		coreBytes: 70_000_000,
		coreCached: true,
		currentUpdated: true,
		pruned: [],
		e2e: { verdict: "pass", note: "pass (fake)" },
	},
	null,
	2,
);

describe("deployViaCli", () => {
	test("maps params onto deploy-cli argv, omitting everything not asked for", async () => {
		let seen: RunOpts | undefined;
		await deployViaCli(
			{ force: true, noFreeze: true },
			{ resolveDir: () => PI_AGENT_DIR, spawn: fakeSpawn({ output: okJson }, (o) => (seen = o)) },
		);
		expect(seen?.cmd).toBe("bun");
		expect(seen?.args).toEqual([CLI, "--force", "--no-freeze"]);
		expect(seen?.cwd).toBe(join(CLI, ".."));
		// An option present-but-false is NOT the same as absent — the CLI reads
		// `--no-*` flags, so a defaulted false must never become a flag.
		await deployViaCli({}, { resolveDir: () => PI_AGENT_DIR, spawn: fakeSpawn({ output: okJson }, (o) => (seen = o)) });
		expect(seen?.args).toEqual([CLI]);
	});

	test("a null source-dir resolve fails CLOSED with the PI_AGENT_DIR remediation", async () => {
		const r = await deployViaCli({}, { resolveDir: () => null, spawn: fakeSpawn({ output: okJson }) });
		// The spawn must never run when the resolve fails — assert via a spawn
		// that throws if reached.
		expect(r.ok).toBe(false);
		expect(r.errorTail).toContain("PI_AGENT_DIR");
		const r2 = await deployViaCli(
			{},
			{
				resolveDir: () => null,
				spawn: async () => {
					throw new Error("spawn must not run after a failed resolve");
				},
			},
		);
		expect(r2.ok).toBe(false);
	});

	test("a timeout is { ok:false } naming the cap and the log", async () => {
		const r = await deployViaCli(
			{},
			{ resolveDir: () => PI_AGENT_DIR, spawn: fakeSpawn({ timedOut: true, output: "…" }) },
		);
		expect(r.ok).toBe(false);
		expect(r.errorTail).toContain("timed out");
		expect(r.errorTail).toContain("/tmp/log");
	});

	test("unparseable output is { ok:false } with exit code + log tail", async () => {
		const r = await deployViaCli(
			{},
			{ resolveDir: () => PI_AGENT_DIR, spawn: fakeSpawn({ exitCode: 1, output: "boom\ntrace" }) },
		);
		expect(r.ok).toBe(false);
		expect(r.errorTail).toContain("exit 1");
		expect(r.errorTail).toContain("boom");
	});

	test("a CLI failure maps `error` onto errorTail and keeps the rest", async () => {
		const out = JSON.stringify({ ok: false, error: "bundle references specifier(s) the host does not provide: foo" }, null, 2);
		const r = await deployViaCli(
			{},
			{ resolveDir: () => PI_AGENT_DIR, spawn: fakeSpawn({ exitCode: 1, output: out }) },
		);
		expect(r.ok).toBe(false);
		expect(r.errorTail).toContain("host does not provide");
	});

	test("a noop re-deploy passes through as ok:true + noop:true", async () => {
		const out = JSON.stringify(
			{ ok: true, noop: true, version: "0.1.0+gabc1234", target: "/dist/x", message: "exists — pass --force", e2e: { verdict: "skip" } },
			null,
			2,
		);
		const r = await deployViaCli(
			{},
			{ resolveDir: () => PI_AGENT_DIR, spawn: fakeSpawn({ output: out }) },
		);
		expect(r.ok).toBe(true);
		expect(r.noop).toBe(true);
		expect(r.message).toContain("--force");
		expect(r.e2e).toMatchObject({ verdict: "skip" });
	});

	test("an e2e FAIL in the CLI result keeps ok:false (the CLI exits 1)", async () => {
		const out = okJson.replace('"verdict": "pass"', '"verdict": "fail"').replace('"ok": true', '"ok": false');
		const r = await deployViaCli(
			{},
			{ resolveDir: () => PI_AGENT_DIR, spawn: fakeSpawn({ exitCode: 1, output: out }) },
		);
		expect(r.ok).toBe(false);
	});
});

describe("parseCliJson", () => {
	test("extracts the JSON block from combined stdout+stderr output", () => {
		const output = `building core…
✓ staged ext/devops
${okJson}
✓ deployed`;
		expect(parseCliJson(output)?.version).toBe("0.1.0+gabc1234");
	});

	test("braces inside string literals cannot truncate the block", () => {
		const output = `{
  "ok": false,
  "error": "failed at gate { build } with {nested} braces"
}`;
		const parsed = parseCliJson(output);
		expect(parsed?.ok).toBe(false);
		expect(parsed?.error).toContain("{nested}");
	});

	test("takes the LAST well-formed object with a boolean ok", () => {
		const output = `{ "ok": true, "version": "first" }\nrandom { noise\n${okJson}`;
		expect(parseCliJson(output)?.version).toBe("0.1.0+gabc1234");
	});

	test("returns null when no object with a boolean ok is present", () => {
		expect(parseCliJson("no json here { unbalanced")).toBeNull();
		expect(parseCliJson('{"version": "v"}')).toBeNull();
	});
});

describe("runDeploy", () => {
	test("delegates to the injected run seam (the real subprocess is never spawned in tests)", async () => {
		const fake: DeployResult = { ok: true, version: "v" };
		const r = await runDeploy({}, { run: async () => fake });
		expect(r).toBe(fake);
	});
});
