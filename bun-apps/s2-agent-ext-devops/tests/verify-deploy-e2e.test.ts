/**
 * verify-deploy-e2e — unit tests for the recipe + CLI wrapper.
 *
 * Spawn-free: every probe goes through an injected fake SpawnFn keyed on the
 * argv (the real launcher is never executed, no model call is ever placed). The
 * filesystem surface is a mkdtemp deploy root with a `current` symlink and a
 * deploy.json, mirroring what ~/proj/dist/s2-agent-sh actually looks like.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeployJson, parseExtListPayload, resolveModelEndpoint, runDeployE2e, modelContentionWarning } from "../src/deploy-e2e-recipe.js";
import { parseVerifyDeployE2eArgs, runVerifyDeployE2eCli } from "../src/verify-deploy-e2e-cli.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const root = mkdtempSync(join(tmpdir(), "deploy-e2e-"));
const VERSION = "0.1.0+gdeadbee";
const versionDir = join(root, VERSION);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeTree(opts: { extensions?: string[]; launcher?: boolean; deployJson?: string } = {}): string {
	mkdirSync(versionDir, { recursive: true });
	if (opts.launcher === false) rmSync(join(versionDir, "s2-agent.sh"), { force: true });
	else writeFileSync(join(versionDir, "s2-agent.sh"), "#!/usr/bin/env bash\n");
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

describe("contention precheck (pure)", () => {
	test("modelContentionWarning: >1 large chat model warns and names them", () => {
		const w = modelContentionWarning(["qwen3.8-27b", "gemma-4-12b", "text-embedding-bge-m3"]);
		expect(w).toContain("qwen3.8-27b");
		expect(w).toContain("gemma-4-12b");
		// the embedder is excluded — it is not contention for the chat model
		expect(w).not.toContain("bge-m3");
	});
	test("one large model (plus embedders) is quiet", () => {
		expect(modelContentionWarning(["qwen3.8-27b", "text-embedding-bge-m3"])).toBeNull();
		expect(modelContentionWarning(["qwen3.8-27b"])).toBeNull();
	});
	test("small models never count as large (≥7b threshold)", () => {
		expect(modelContentionWarning(["foo-4b", "bar-2b"])).toBeNull();
		expect(modelContentionWarning(["foo-7b", "bar-8b"])).not.toBeNull();
	});
	test("resolveModelEndpoint: env override wins, LM Studio default otherwise", () => {
		expect(resolveModelEndpoint({ LMSTUDIO_BASE_URL: "http://x:9" })).toBe("http://x:9");
		expect(resolveModelEndpoint({})).toBe("http://127.0.0.1:1234");
	});
});

/** Fake fetch returning an OpenAI-style /v1/models body — the precheck seam. */
function fakeModelsFetch(ids: string[]): (url: string, init?: RequestInit) => Promise<Response> {
	return async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

describe("runDeployE2e", () => {
	test("all three probes pass on a healthy tree", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		expect(r.verdict).toBe("pass");
		expect(r.version).toBe(VERSION);
		expect(r.probes.map((p) => p.id)).toEqual(["boot", "ext-load", "model-call", "file2md-ocr"]);
		expect(r.probes.find((p) => p.id === "file2md-ocr")?.verdict).toBe("skip"); // not in this tree's deploy set
		expect(r.probes.filter((p) => p.id !== "file2md-ocr").every((p) => p.verdict === "pass")).toBe(true);
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
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("fail");
		// slow-vs-hung: the note must not point straight at the surrealdb wedge
		expect(mc.note).toContain("SLOW");
		expect(mc.note).toContain("300s");
		expect(mc.detail).toContain("BOOT HANG");
	});

	test("contention precheck: >1 large resident model lands in warnings and the fail detail", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ modelCall: { exitCode: 124, timedOut: true, stdout: "", stderr: "" } }),
			modelEndpoint: "http://127.0.0.1:1234",
			fetchImpl: fakeModelsFetch(["qwen3.8-27b", "gemma-4-12b", "text-embedding-bge-m3"]),
		});
		expect(r.warnings.length).toBe(1);
		expect(r.warnings[0]).toContain("qwen3.8-27b");
		// the timeout detail carries the precheck context for the next reader
		expect(r.probes.find((p) => p.id === "model-call")!.detail).toContain("Precheck:");
	});

	test("contention precheck: quiet endpoint → no warnings, verdict unaffected", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn(),
			modelEndpoint: "http://127.0.0.1:1234",
			fetchImpl: fakeModelsFetch(["qwen3.8-27b"]),
		});
		expect(r.verdict).toBe("pass");
		expect(r.warnings).toEqual([]);
	});

	test("contention precheck: an unreachable endpoint is silent, never a failure", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn(),
			modelEndpoint: "http://127.0.0.1:1",
			fetchImpl: async () => {
				throw new Error("connect ECONNREFUSED");
			},
		});
		expect(r.verdict).toBe("pass");
		expect(r.warnings).toEqual([]);
	});

	test("no modelEndpoint → no precheck fetch at all (hermetic default)", async () => {
		makeTree();
		let fetched = false;
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn(),
			fetchImpl: async () => {
				fetched = true;
				return new Response("{}", { status: 200 });
			},
		});
		expect(fetched).toBe(false);
		expect(r.verdict).toBe("pass");
	});

	test("a corrupt deploy.json is a structured fail, not a throw", async () => {
		makeTree({ deployJson: "{" });
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		expect(r.verdict).toBe("fail");
		expect(r.note).toContain("deploy.json");
		expect(r.probes).toEqual([]);
	});

	test("a missing s2-agent.sh is a structured fail", async () => {
		makeTree({ launcher: false });
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		expect(r.verdict).toBe("fail");
		expect(r.note).toContain("s2-agent.sh");
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
			modelEndpoint: null, // hermetic: no real /v1/models fetch
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
			modelEndpoint: null,
		});
		expect(res.exitCode).toBe(1);
	});
});
