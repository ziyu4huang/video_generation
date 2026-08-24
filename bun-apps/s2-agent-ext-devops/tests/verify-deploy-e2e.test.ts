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
import {
	parseDeployJson,
	parseExtListPayload,
	resolveModelEndpoint,
	runDeployE2e,
	modelContentionWarning,
	parseHermesStartupRoundTrips,
	ONESHOT_RUNTIME_BUDGET_MS,
	HERMES_STARTUP_ROUNDTRIP_CAP,
} from "../src/deploy-e2e-recipe.js";
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
	toolsProbe?: Partial<SpawnResult>;
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
		// tools-probe: `-e <probe> -p hi --no-session` — must be matched BEFORE
		// the bare `-p` fallthrough below (its argv contains both).
		if (args.includes("-e")) {
			const healthy = {
				total: 66,
				matched: 26,
				activeCount: 26,
				active: ["read", "write", "edit", "bash", "enable_tool"],
				missing: [],
				gateSeam: { activeCount: 26, totalCount: 66, coreCount: 4 },
				getActiveTools: true,
			};
			return { stdout: "", stderr: `[TOOLS] ${JSON.stringify(healthy)}\n`, exitCode: 0, ...o.toolsProbe };
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
	test("all probes pass on a healthy tree", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		expect(r.verdict).toBe("pass");
		expect(r.version).toBe(VERSION);
		expect(r.probes.map((p) => p.id)).toEqual([
			"boot",
			"ext-load",
			"tools-probe",
			"model-call",
			"file2md-ocr",
			"tool-gate-fire",
		]);
		expect(r.probes.find((p) => p.id === "file2md-ocr")?.verdict).toBe("skip"); // not in this tree's deploy set
		expect(r.probes.find((p) => p.id === "tool-gate-fire")?.verdict).toBe("skip"); // not in this tree's deploy set
		expect(
			r.probes.filter((p) => p.id !== "file2md-ocr" && p.id !== "tool-gate-fire").every((p) => p.verdict === "pass"),
		).toBe(true);
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

	test("tools-probe: missing core builtins fails naming them (the #1946 class)", async () => {
		makeTree();
		const wiped = {
			total: 66,
			matched: 26,
			activeCount: 16,
			active: ["ask_user_question", "spawn_subagent", "task_create"],
			missing: ["read", "write", "edit", "bash"],
			gateSeam: { activeCount: 16, totalCount: 66, coreCount: 0 },
			getActiveTools: true,
		};
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ toolsProbe: { stderr: `[TOOLS] ${JSON.stringify(wiped)}\n`, exitCode: 0 } }),
		});
		expect(r.verdict).toBe("fail");
		const tp = r.probes.find((p) => p.id === "tools-probe")!;
		expect(tp.verdict).toBe("fail");
		expect(tp.note).toContain("read");
		expect(tp.note).toContain("write");
		expect(tp.note).toContain("active=16/66");
	});

	test("tools-probe: an EMPTY active set fails citing the #1946 setActiveTools([]) class", async () => {
		makeTree();
		const wiped = {
			total: 66,
			matched: 0,
			activeCount: 0,
			active: [],
			missing: ["read", "write", "edit", "bash"],
			gateSeam: { activeCount: 0, totalCount: 0, coreCount: 0 },
			getActiveTools: true,
		};
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ toolsProbe: { stderr: `[TOOLS] ${JSON.stringify(wiped)}\n`, exitCode: 0 } }),
		});
		expect(r.verdict).toBe("fail");
		const tp = r.probes.find((p) => p.id === "tools-probe")!;
		expect(tp.verdict).toBe("fail");
		expect(tp.note).toContain("EMPTY");
		expect(tp.note).toContain("#1946");
	});

	test("tools-probe: a FAST provider failure (no [TOOLS] line) is a SKIP, never a fail", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({
				toolsProbe: { exitCode: 1, stdout: "", stderr: "provider lm-studio: connection refused — no api key" },
			}),
		});
		const tp = r.probes.find((p) => p.id === "tools-probe")!;
		expect(tp.verdict).toBe("skip");
		expect(tp.note).toContain("probe never fired");
	});

	test("tools-probe: no [TOOLS] line + timeout is a FAIL with diagnostics", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ toolsProbe: { exitCode: 124, timedOut: true, stdout: "", stderr: "" } }),
		});
		expect(r.verdict).toBe("fail");
		const tp = r.probes.find((p) => p.id === "tools-probe")!;
		expect(tp.verdict).toBe("fail");
		expect(tp.note).toContain("[TOOLS] line absent");
		expect(tp.note).toContain("timed out");
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
			// tools-probe also carries -p (offline exit before the request
			// completes) — only a bare -p argv is the model call.
			if (args.includes("-p") && !args.includes("-e")) placed = true;
			return fakeSpawn()( _c, args);
		};
		const r = await runDeployE2e({ versionDir, spawn, skipModelCall: true });
		expect(placed).toBe(false);
		expect(r.verdict).toBe("pass");
		expect(r.probes.find((p) => p.id === "model-call")!.verdict).toBe("skip");
	});
});

// ── one-shot runtime budget + hermes round-trip cap (2026-08-24 plan) ────────
// Baselines measured 2026-08-24 on this machine against deployed
// 0.7.1+gd6f3c0c: one-shot wall p95 10.99s over 8 runs (budget 35s — below
// the #1976 36.6s regression, above contention-era 31.7s generation); hermes
// syncMarkdownMemories 103–114 round-trips dirty-vault / 26 clean (cap 150).
describe("parseHermesStartupRoundTrips (pure)", () => {
	const BANNER = (op: string, n: number) =>
		`[hermes-memory] slow ${op}: ${n} HTTP round-trips (backend=surrealdb). See perf.jsonl.`;

	test("extracts the round-trip count from a breach banner", () => {
		expect(parseHermesStartupRoundTrips(BANNER("startup.syncMarkdownMemories", 114))).toBe(114);
	});
	test("returns the MAX across multiple startup ops", () => {
		expect(parseHermesStartupRoundTrips([BANNER("startup.syncMarkdownMemories", 60), BANNER("startup.other", 90)].join("\n"))).toBe(90);
	});
	test("matches op names with digits/underscores/nested dots", () => {
		expect(parseHermesStartupRoundTrips(BANNER("startup.backfill.needsBackfill_v2", 70))).toBe(70);
	});
	test("no banner → null (under the extension's own thresholds = pass)", () => {
		expect(parseHermesStartupRoundTrips("")).toBeNull();
		expect(parseHermesStartupRoundTrips("[hermes-memory] event consolidation.memory: …")).toBeNull();
	});
	test("ignores non-startup ops and ms-only breaches", () => {
		expect(parseHermesStartupRoundTrips(BANNER("shutdown.indexSession", 400))).toBeNull();
		expect(parseHermesStartupRoundTrips("[hermes-memory] slow startup.syncMarkdownMemories: 2596ms (backend=surrealdb).")).toBeNull();
	});
	test("survives ANSI escapes around the banner", () => {
		expect(parseHermesStartupRoundTrips(`\x1b[33m${BANNER("startup.syncMarkdownMemories", 104)}\x1b[0m`)).toBe(104);
	});
});

/** Fake clock advancing `stepMs` per now() call — every probe's ms = stepMs. */
function steppingClock(stepMs: number): { now: () => number } {
	let t = 1_000_000_000_000;
	return { now: () => (t += stepMs) };
}

describe("model-call regression budgets", () => {
	test("a completed one-shot over the wall budget FAILS citing the baseline", async () => {
		makeTree();
		const { now } = steppingClock(ONESHOT_RUNTIME_BUDGET_MS + 5_000);
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn(), now });
		expect(r.verdict).toBe("fail");
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("fail");
		expect(mc.note).toContain("40.0s");
		expect(mc.note).toContain("#1976");
	});

	test("the same breach under model contention is an inconclusive SKIP", async () => {
		makeTree();
		const { now } = steppingClock(ONESHOT_RUNTIME_BUDGET_MS + 5_000);
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn(),
			now,
			modelEndpoint: "http://127.0.0.1:1234",
			fetchImpl: fakeModelsFetch(["qwen3.8-27b", "gemma-4-12b"]),
		});
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("skip");
		expect(mc.note).toContain("contention");
	});

	test("a hermes banner over the round-trip cap FAILS even with a healthy call", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({
				modelCall: {
					stdout: "ok",
					stderr: "[hermes-memory] slow startup.syncMarkdownMemories: 240 HTTP round-trips (backend=surrealdb). See perf.jsonl.\n",
				},
			}),
		});
		expect(r.verdict).toBe("fail");
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("fail");
		expect(mc.note).toContain("240 HTTP round-trips");
		expect(mc.note).toContain(`cap ${HERMES_STARTUP_ROUNDTRIP_CAP}`);
	});

	test("a banner UNDER the cap (dirty-vault 114) does not fail", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({
				modelCall: {
					stdout: "ok",
					stderr: "[hermes-memory] slow startup.syncMarkdownMemories: 114 HTTP round-trips (backend=surrealdb). See perf.jsonl.\n",
				},
			}),
		});
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("pass");
		expect(mc.note).toContain("budget");
	});

	test("the round-trip cap holds even when the provider itself was down (skip)", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({
				modelCall: {
					exitCode: 1,
					stdout: "",
					stderr: "[hermes-memory] slow startup.syncMarkdownMemories: 240 HTTP round-trips (backend=surrealdb).\nprovider lm-studio: connection refused — no api key",
				},
			}),
		});
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("fail");
		expect(mc.note).toContain("240 HTTP round-trips");
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
