/**
 * tool-gate-fire probe — unit tests.
 *
 * Builds the REAL tool-gate bundle through the same pipeline the deploy uses
 * (buildExtPackage, registry-driven config) and drives the probe against it:
 * PASS proves the shipped shape (minified cjs, host modules external) gates at
 * session start, fires on a keyword prompt, registers enable_tool, and honors
 * BUN_PI_TOOL_GATE=0. A no-op bundle is the structured FAIL half. No deploy,
 * no model, offline.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtPackage } from "../src/deploy/lib/ext-build.js";
import { parseShConfig } from "../src/deploy/lib/config.js";
import { runToolGateFireProbe } from "../src/tool-gate-fire-probe.js";
import { HOST_API, HOST_MODULE_IDS } from "../../s2-agent/src/sh/host-modules.js";

const root = mkdtempSync(join(tmpdir(), "tg-fire-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BUN_APPS_DIR = join(import.meta.dir, "..", "..");

// The config is DERIVED from the registry — never hardcode a row here, or a
// future registry edit renames/splits the extension and this test silently
// tests a stale shape (the #1713 lesson).
const toolGateExt = parseShConfig(
	readFileSync(join(BUN_APPS_DIR, "s2-agent", "s2-agent.registry.yaml"), "utf8"),
	{ bunAppsDir: BUN_APPS_DIR },
).extensions.find((e) => e.name === "tool-gate");

function expectToolGateRow(): NonNullable<typeof toolGateExt> {
	if (!toolGateExt) throw new Error("tool-gate missing from s2-agent.registry.yaml");
	return toolGateExt;
}

/** Build the real tool-gate ext bundle the deploy pipeline produces. */
async function buildRealBundle(): Promise<{ cjsPath: string; hostModules: string[] }> {
	const outDir = join(root, "ext-tool-gate");
	await buildExtPackage({
		ext: expectToolGateRow(),
		deployRoot: join(root, "deploy"),
		bunAppsDir: BUN_APPS_DIR,
		outDir,
		hostApi: HOST_API,
		hostModules: [...HOST_MODULE_IDS],
		sourceSha: "test",
		builtAt: "test",
	});
	const extJson = JSON.parse(readFileSync(join(outDir, "ext.json"), "utf8")) as {
		hostModules?: string[];
		vendored?: string[];
		runtimeExternals?: string[];
	};
	return {
		cjsPath: join(outDir, "ext.cjs"),
		// Same combination the recipe hands the probe (ext-build's executeExtTool
		// contract: host + vendored + runtime externals).
		hostModules: [
			...(extJson.hostModules ?? []),
			...(extJson.vendored ?? []),
			...(extJson.runtimeExternals ?? []),
		],
	};
}

describe("runToolGateFireProbe", () => {
	test("the real deployed bundle gates, fires on keyword, registers enable_tool", async () => {
		const { cjsPath, hostModules } = await buildRealBundle();
		const r = await runToolGateFireProbe(cjsPath, hostModules);
		expect(r).toEqual({
			ok: true,
			note: "deployed bundle gated at session start (read, bash, e2e_fire_core) and fired on keyword (please pixelize the render before exporting)",
		});
	}, 120_000);

	test("a bundle that registers nothing is a structured fail, not a pass", async () => {
		const outDir = join(root, "ext-noop");
		mkdirSync(outDir, { recursive: true });
		const entry = join(outDir, "noop.ts");
		writeFileSync(entry, "export default (_api: unknown) => {};\n");
		const cjsPath = join(outDir, "ext.cjs");
		// process.execPath = the running bun — CI-safe (portability P2: never a
		// host-binary probe; same pattern as tests/deploy-probe-e2e.test.ts).
		const proc = Bun.spawnSync(
			[process.execPath, "build", entry, "--target=bun", "--format=cjs", "--minify", `--outfile=${cjsPath}`],
			{ cwd: outDir },
		);
		expect(proc.exitCode).toBe(0);
		const r = await runToolGateFireProbe(cjsPath, []);
		expect(r.ok).toBe(false);
		expect(r.note).toContain("no session_start handler");
	}, 120_000);

	test("a missing bundle is a structured fail, not a throw", async () => {
		const r = await runToolGateFireProbe(join(root, "missing", "ext.cjs"), []);
		expect(r.ok).toBe(false);
		// The waiter result shape is preserved by the caller (recipe) — here the
		// probe itself must surface the eval failure as a clean failure, which the
		// recipe turns into the probe's catch branch. Assert the contract: it
		// never throws.
		expect(typeof r.ok).toBe("boolean");
	}, 30_000);
});
