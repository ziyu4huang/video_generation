/**
 * verify-deploy-e2e — unit tests for the recipe + CLI wrapper.
 *
 * Spawn-free: every probe goes through an injected fake SpawnFn keyed on the
 * argv (the real run.sh is never executed, no model call is ever placed). The
 * filesystem surface is a mkdtemp deploy root with a `current` symlink and a
 * deploy.json, mirroring what ~/proj/dist/s2-agent-sh actually looks like.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeployJson, parseExtListPayload, runDeployE2e } from "../src/deploy-e2e-recipe.js";
import { parseVerifyDeployE2eArgs, runVerifyDeployE2eCli } from "../src/verify-deploy-e2e-cli.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const root = mkdtempSync(join(tmpdir(), "deploy-e2e-"));
const VERSION = "0.1.0+gdeadbee";
const versionDir = join(root, VERSION);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeTree(opts: { extensions?: string[]; runSh?: boolean; deployJson?: string } = {}): string {
	mkdirSync(versionDir, { recursive: true });
	if (opts.runSh === false) rmSync(join(versionDir, "run.sh"), { force: true });
	else writeFileSync(join(versionDir, "run.sh"), "#!/usr/bin/env bash\n");
	writeFileSync(
		join(versionDir, "deploy.json"),
		opts.deployJson ??
			JSON.stringify({
				version: VERSION,
				sourceSha: "deadbee",
				config: { extensions: (opts.extensions ?? ["task", "wayfind"]).map((name) => ({ name, enabled: true })) },
			}),
	);
	// Re-created per test — remove the previous round's link first (EEXIST).
	rmSync(join(root, "current"), { force: true });
	symlinkSync(VERSION, join(root, "current"), "dir");
	return versionDir;
}

interface FakeOpts {
	extList?: { loaded?: string[]; stdout?: string; exitCode?: number };
	help?: Partial<SpawnResult>;
	modelCall?: Partial<SpawnResult>;
}

/** Fake spawn keyed on the first non-flag argv — the probe identity. */
function fakeSpawn(o: FakeOpts = {}): SpawnFn {
	return async (_cmd, args): Promise<SpawnResult> => {
		if (args.includes("--help")) {
			return { stdout: "usage…", stderr: "", exitCode: 0, ...o.help };
		}
		if (args.includes("--ext-list")) {
			if (o.extList?.stdout !== undefined || o.extList?.exitCode !== undefined) {
				return { stdout: o.extList?.stdout ?? "", stderr: "", exitCode: o.extList?.exitCode ?? 0 };
			}
			const loaded = o.extList?.loaded ?? ["task", "wayfind"];
			return {
				stdout: JSON.stringify({ loadedCount: loaded.length, loaded, skipped: [] }),
				stderr: "",
				exitCode: 0,
			};
		}
		// model-call probe: -p
		return { stdout: "ok", stderr: "", exitCode: 0, ...o.modelCall };
	};
}

describe("parseDeployJson (pure)", () => {
	test("extracts version/sourceSha and the enabled extension names", () => {
		const r = parseDeployJson(
			JSON.stringify({
				version: "v",
				sourceSha: "s",
				config: { extensions: [{ name: "a", enabled: true }, { name: "b", enabled: false }, { name: "c" }] },
			}),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.enabled).toEqual(["a", "c"]); // enabled:false drops out; absent = enabled
		}
	});
	test("rejects non-JSON and missing fields", () => {
		expect(parseDeployJson("{").ok).toBe(false);
		expect(parseDeployJson("{}").ok).toBe(false);
	});
});

describe("parseExtListPayload (pure)", () => {
	test("parses the payload; rejects garbage", () => {
		expect(parseExtListPayload('{"loadedCount":1,"loaded":["x"],"skipped":[]}').ok).toBe(true);
		expect(parseExtListPayload("not json").ok).toBe(false);
		expect(parseExtListPayload('{"loaded":[]}').ok).toBe(false);
	});
});

describe("runDeployE2e", () => {
	test("all three probes pass on a healthy tree", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		expect(r.verdict).toBe("pass");
		expect(r.version).toBe(VERSION);
		expect(r.probes.map((p) => p.id)).toEqual(["boot", "ext-load", "model-call"]);
		expect(r.probes.every((p) => p.verdict === "pass")).toBe(true);
	});

	test("an extension enabled in deploy.json but not loaded fails ext-load", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ extList: { loaded: ["task"] } }), // wayfind missing
		});
		expect(r.verdict).toBe("fail");
		const ext = r.probes.find((p) => p.id === "ext-load")!;
		expect(ext.verdict).toBe("fail");
		expect(ext.note).toContain("wayfind");
	});

	test("a boot timeout fails the run with diagnostics", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ help: { exitCode: 124, timedOut: true, stdout: "", stderr: "frozen" } }),
		});
		expect(r.verdict).toBe("fail");
		expect(r.probes[0].note).toContain("timed out");
	});

	test("a FAST provider failure on the model call is a SKIP, never a fail", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ modelCall: { exitCode: 1, stdout: "", stderr: "provider lm-studio: connection refused — no api key" } }),
		});
		expect(r.verdict).toBe("skip");
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("skip");
		expect(mc.note).toContain("provider-unavailable");
	});

	test("a model-call TIMEOUT fails (the boot-hang case this layer exists for)", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ modelCall: { exitCode: 124, timedOut: true, stdout: "", stderr: "" } }),
		});
		expect(r.verdict).toBe("fail");
		expect(r.probes.find((p) => p.id === "model-call")!.verdict).toBe("fail");
	});

	test("a corrupt deploy.json is a structured fail, not a throw", async () => {
		makeTree({ deployJson: "{" });
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		expect(r.verdict).toBe("fail");
		expect(r.note).toContain("deploy.json");
		expect(r.probes).toEqual([]);
	});

	test("a missing run.sh is a structured fail", async () => {
		makeTree({ runSh: false });
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		expect(r.verdict).toBe("fail");
		expect(r.note).toContain("run.sh");
	});

	test("--skip-model-call keeps the verdict pass without placing a call", async () => {
		makeTree();
		let placed = false;
		const spawn: SpawnFn = async (_c, args) => {
			if (args.includes("-p")) placed = true;
			return fakeSpawn()( _c, args);
		};
		const r = await runDeployE2e({ versionDir, spawn, skipModelCall: true });
		expect(placed).toBe(false);
		expect(r.verdict).toBe("pass");
		expect(r.probes.find((p) => p.id === "model-call")!.verdict).toBe("skip");
	});
});

describe("parseVerifyDeployE2eArgs (shared CLI contract)", () => {
	test("an unknown flag is a usage error, never silently ignored", () => {
		const r = parseVerifyDeployE2eArgs(["--not-a-flag"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("--not-a-flag");
	});
	test("--help parses as 'not ok' so the caller can render usage at exit 0", () => {
		expect(parseVerifyDeployE2eArgs(["--help"]).ok).toBe(false);
	});
	test("parses --deploy-root <path> and --skip-model-call", () => {
		const r = parseVerifyDeployE2eArgs(["--deploy-root", "/d", "--skip-model-call"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.args.deployRoot).toBe("/d");
			expect(r.args.skipModelCall).toBe(true);
		}
	});
	test("--deploy-root without a value is a usage error", () => {
		expect(parseVerifyDeployE2eArgs(["--deploy-root"]).ok).toBe(false);
	});
});

describe("runVerifyDeployE2eCli", () => {
	test("--help: usage on stderr with exit 0, nothing on stdout", async () => {
		const res = await runVerifyDeployE2eCli(["--help"]);
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("");
		expect(res.stderr).toContain("usage:");
	});

	test("a healthy current: exit 0, pure-JSON stdout that parses back", async () => {
		makeTree();
		const res = await runVerifyDeployE2eCli(["--deploy-root", root], {
			spawn: fakeSpawn(),
			versionDir: undefined,
		});
		expect(res.exitCode).toBe(0);
		const payload = JSON.parse(res.stdout);
		expect(payload.verdict).toBe("pass");
		expect(payload.deployRoot).toBe(root);
	});

	test("no `current` under the deploy root: exit 1 with a structured fail", async () => {
		const emptyRoot = mkdtempSync(join(tmpdir(), "deploy-e2e-empty-"));
		try {
			const res = await runVerifyDeployE2eCli(["--deploy-root", emptyRoot], { spawn: fakeSpawn() });
			expect(res.exitCode).toBe(1);
			const payload = JSON.parse(res.stdout);
			expect(payload.verdict).toBe("fail");
			expect(payload.note).toContain("current");
		} finally {
			rmSync(emptyRoot, { recursive: true, force: true });
		}
	});

	test("a failing probe exits 1 (fail is never exit 0)", async () => {
		makeTree();
		const res = await runVerifyDeployE2eCli(["--deploy-root", root], {
			spawn: fakeSpawn({ extList: { loaded: [] } }),
		});
		expect(res.exitCode).toBe(1);
	});
});
