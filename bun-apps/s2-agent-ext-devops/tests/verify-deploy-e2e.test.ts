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
import { join, resolve } from "node:path";
import {
	isBunShellChildSignature,
	isBunRelayWorkaround,
	isNoConsoleRelayWorkaround,
	dummyEnvForBakedCatalog,
	parseDeployJson,
	parseExtListPayload,
	parseListModelsRows,
	bakedModelPairs,
	resolveModelEndpoint,
	runDeployE2e,
	modelContentionWarning,
	parseHermesStartupRoundTrips,
	resolveE2eModelPin,
	ONESHOT_RUNTIME_BUDGET_MS,
	HERMES_STARTUP_ROUNDTRIP_CAP,
	normalizeVisionReply,
	visionErrorIsProviderDown,
	VISION_FIXTURE_NEEDLE,
	type VisionAskOutcome,
} from "../src/deploy-e2e-recipe.js";
import { parseVerifyDeployE2eArgs, runVerifyDeployE2eCli } from "../src/verify-deploy-e2e-cli.js";
import { PROVIDERS } from "../../s2-agent/src/pre-load-providers.ts";
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
	// The vision-call and file2md-ocr probes read ext/file2md/ext.json when the
	// deploy set includes file2md — the fixture only needs the JSON to parse.
	const exts = opts.extensions ?? ["task", "wayfind"];
	if (exts.includes("file2md")) {
		mkdirSync(join(versionDir, "ext", "file2md"), { recursive: true });
		writeFileSync(join(versionDir, "ext", "file2md", "ext.json"), JSON.stringify({ hostModules: [] }));
	}
	// Re-created per test — remove the previous round's link first (EEXIST).
	rmSync(join(root, "current"), { force: true });
	symlinkSync(VERSION, join(root, "current"), "dir");
	return versionDir;
}

interface FakeOpts {
	extList?: { loaded?: string[]; stdout?: string; exitCode?: number };
	/** Payload for the cwd-independence probe's OUT-of-tree --ext-list run. */
	extListForeignCwd?: { loaded?: string[]; stdout?: string; exitCode?: number };
	help?: Partial<SpawnResult>;
	toolsProbe?: Partial<SpawnResult>;
	modelCall?: Partial<SpawnResult>;
	/** providers-catalog probe payloads: patch-ON and patch-OFF --list-models stdout. */
	listModels?: { on?: string; off?: string; offExit?: number };
}

/** Render `--list-models` rows for a set of provider→model ids (column layout). */
function listModelsStdout(rows: Array<[string, string]>): string {
	return [
		"provider     model                                context  max-out  thinking  images",
		...rows.map(([p, m]) => `${p.padEnd(13)} ${m.padEnd(37)} 200K     65.5K    yes       yes   `),
	].join("\n");
}

/** The ambient (non-patch) rows: pi-ai's builtin catalog always lists these. */
const AMBIENT_ROWS: Array<[string, string]> = [
	["deepseek", "deepseek-v4-flash"],
	["deepseek", "deepseek-v4-flash-vision-exp"],
	["huggingface", "deepseek-ai/DeepSeek-V3.2"],
	["zai", "glm-5.3"],
];

function defaultListModels(): { on: string; off: string } {
	// ON: ambient + every baked PROVIDERS pair (the patch registered them).
	// OFF: ambient + ONE duplicated lm-studio lane (personal models.json
	// residue — the measured real-world case on this machine).
	return {
		on: listModelsStdout([...AMBIENT_ROWS, ...bakedModelPairs().map((p) => [p.provider, p.model] as [string, string])]),
		off: listModelsStdout([...AMBIENT_ROWS, ["lm-studio", "google/gemma-4-12b"]]),
	};
}

/** Canned parity fingerprint — identical on both sides by default so the
 *  parity probe passes through the fake spawn (dev/deploy divergence has its
 *  own suite in parity-e2e-probe.test.ts). */
const PARITY_FP = {
	marker: "PARITY_FP_v1",
	mode: "stub",
	sessionStartFired: true,
	toolCount: 2,
	tools: [
		{ n: "read", s: "builtin", p: "<builtin:read>", dh: "1", sh: "2" },
		{ n: "stub-ext-tool", s: "extension", p: "/stub/ext.cjs", dh: "3", sh: "4" },
	],
	skillCount: 1,
	skills: [{ n: "stub-skill", p: "/stub/SKILL.md", ch: "5" }],
};
const parityFpLine = `\n[PARITY-FP-START]${JSON.stringify(PARITY_FP)}[PARITY-FP-END]\n`;

/** Fake spawn keyed on the first non-flag argv — the probe identity. */
function fakeSpawn(o: FakeOpts = {}): SpawnFn {
	return async (_cmd, args, options): Promise<SpawnResult> => {
		if (args.includes("--help")) {
			return { stdout: "usage…", stderr: "", exitCode: 0, ...o.help };
		}
		if (args.includes("--ext-list")) {
			// cwd-independence runs --ext-list from OUTSIDE the tree; give it
			// its own payload so divergence is testable (default: same as
			// in-tree — a healthy tree loads identically from any cwd).
			const foreign = options?.cwd !== undefined && options.cwd !== versionDir;
			const src = foreign ? (o.extListForeignCwd ?? o.extList) : o.extList;
			if (src?.stdout !== undefined || src?.exitCode !== undefined) {
				return { stdout: src?.stdout ?? "", stderr: "", exitCode: src?.exitCode ?? 0 };
			}
			const loaded = src?.loaded ?? ["task", "wayfind"];
			return {
				stdout: JSON.stringify({ loadedCount: loaded.length, loaded, skipped: [] }),
				stderr: "",
				exitCode: 0,
			};
		}
		// tools-probe: `-e <probe> -p hi --no-session` — must be matched BEFORE
		// the bare `-p` fallthrough below (its argv contains both). The parity
		// probe uses the same `-e` shape but carries PARITY_MODE (its env
		// contract) — answer it with the fingerprint marker instead.
		if (args.includes("-e")) {
			if (options?.env?.PARITY_MODE) {
				return { stdout: "", stderr: parityFpLine, exitCode: 0 };
			}
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
		// providers-catalog probe: --list-models (ON default / OFF with the
		// patch gate) — matched before the bare `-p` fallthrough.
		if (args.includes("--list-models")) {
			const lm = { ...defaultListModels(), ...o.listModels };
		const off = options?.env?.BUN_PI_PRE_LOAD_PROVIDERS === "0";
		const src = off ? lm.off : lm.on;
		return off && lm.offExit !== undefined
			? { stdout: "", stderr: "", exitCode: lm.offExit }
			: { stdout: src, stderr: "", exitCode: 0 };
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
		const w = modelContentionWarning(["qwen3.8-27b", "bonsai-27b", "text-embedding-bge-m3"]);
		expect(w).toContain("qwen3.8-27b");
		expect(w).toContain("bonsai-27b");
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
			"cwd-independence",
			"parity",
			"tools-probe",
			"providers-catalog",
			"model-call",
			"vision-call",
			"file2md-ocr",
			"tool-gate-fire",
			"standalone-import",
		]);
		expect(r.probes.find((p) => p.id === "file2md-ocr")?.verdict).toBe("skip"); // not in this tree's deploy set
		expect(r.probes.find((p) => p.id === "vision-call")?.verdict).toBe("skip"); // not in this tree's deploy set
		expect(r.probes.find((p) => p.id === "tool-gate-fire")?.verdict).toBe("skip"); // not in this tree's deploy set
		expect(r.probes.find((p) => p.id === "standalone-import")?.verdict).toBe("skip"); // stub tree has no ext/ext-standalone.mjs
		expect(r.probes.find((p) => p.id === "parity")?.verdict).toBe("skip"); // no devLauncher — dist-only baseline
		expect(
			r.probes
				.filter(
					p => p.id !== "file2md-ocr" && p.id !== "tool-gate-fire" && p.id !== "standalone-import" && p.id !== "vision-call" && p.id !== "parity",
				)
				.every((p) => p.verdict === "pass"),
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

	test("cwd-independence: a loaded set that DIFFERS by cwd fails", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			// in-tree: healthy; foreign cwd: only one ext loads (the
			// baked-relative-path class the probe exists to catch)
			spawn: fakeSpawn({ extListForeignCwd: { loaded: ["task"] } }),
		});
		expect(r.verdict).toBe("fail");
		const p = r.probes.find((x) => x.id === "cwd-independence")!;
		expect(p.verdict).toBe("fail");
		expect(p.note).toContain("differs by cwd");
	});

	test("cwd-independence: ext-load passes in-tree but the foreign-cwd run errors → fail", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ extListForeignCwd: { stdout: "", exitCode: 1 } }),
		});
		expect(r.verdict).toBe("fail");
		const p = r.probes.find((x) => x.id === "cwd-independence")!;
		expect(p.verdict).toBe("fail");
		expect(p.note).toContain("foreign cwd");
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
			fetchImpl: fakeModelsFetch(["qwen3.8-27b", "bonsai-27b", "text-embedding-bge-m3"]),
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
		const spawn: SpawnFn = async (_c, args, options) => {
			// tools-probe also carries -p (offline exit before the request
			// completes) — only a bare -p argv is the model call.
			if (args.includes("-p") && !args.includes("-e")) placed = true;
			return fakeSpawn()(_c, args, options);
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
			fetchImpl: fakeModelsFetch(["qwen3.8-27b", "bonsai-27b"]),
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

describe("model pin (VERIFY_E2E_MODEL — the D8-style lane pin)", () => {
	// The predecessor's measured blocker (next-goal 2026-08-29-095037): with
	// only the 27b lane resident, a cold one-shot takes ~36s wall — just over
	// the 35s budget — with NO contention warning (1 model) → a FAIL that is
	// neither contention nor a tree regression. The pin (VERIFY_E2E_MODEL=
	// provider/model-id, the deploy-probe-e2e D8 env form) makes the one-shot's
	// lane deterministic so the budget has teeth again: breach on a PINNED
	// light lane IS the #1976 class.
	const PIN = "deepseek/deepseek-v4-flash-vision-exp";

	test("resolveE2eModelPin: provider/model-id parses (first-slash split)", () => {
		const r = resolveE2eModelPin({ VERIFY_E2E_MODEL: PIN });
		expect(r).toEqual({ ok: true, pin: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" } });
		// multi-segment model ids (openrouter vendor/model) keep the rest intact
		const r2 = resolveE2eModelPin({ VERIFY_E2E_MODEL: " openrouter/qwen/qwen3-235b " });
		expect(r2).toEqual({ ok: true, pin: { provider: "openrouter", model: "qwen/qwen3-235b" } });
	});

	test("resolveE2eModelPin: unset → null (default lane, behavior unchanged)", () => {
		expect(resolveE2eModelPin({})).toBeNull();
		expect(resolveE2eModelPin({ VERIFY_E2E_MODEL: "" })).toBeNull();
	});

	test("resolveE2eModelPin: a bare model id is a usage error (PI_MODEL alone is not enough — D8)", () => {
		const r = resolveE2eModelPin({ VERIFY_E2E_MODEL: "deepseek-v4-flash-vision-exp" });
		expect(r?.ok).toBe(false);
		if (r && !r.ok) expect(r.message).toContain("provider/model-id");
		const bare2 = resolveE2eModelPin({ VERIFY_E2E_MODEL: "/model" });
		expect(bare2?.ok).toBe(false);
	});

	/** fakeSpawn + a per-call env/args recording surface. */
	function recordingSpawn(): { spawn: SpawnFn; seen: Array<{ args: string[]; env?: Record<string, string> }> } {
		const seen: Array<{ args: string[]; env?: Record<string, string> }> = [];
		const base = fakeSpawn();
		const spawn: SpawnFn = async (cmd, args, options) => {
			seen.push({ args, env: options?.env });
			return base(cmd, args, options);
		};
		return { spawn, seen };
	}
	const sessionCall = (s: { args: string[] }) => s.args.includes("-p"); // one-shots: tools-probe (-e … -p) + model-call (-p)

	test("a pin reaches the one-shot spawns as PI_PROVIDER/PI_MODEL/PI_THINKING=off and only them", async () => {
		makeTree();
		const { spawn, seen } = recordingSpawn();
		const r = await runDeployE2e({ versionDir, spawn, modelEndpoint: null, modelPin: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" } });
		expect(r.probes.find((p) => p.id === "model-call")!.verdict).toBe("pass");
		const oneShots = seen.filter(sessionCall);
		expect(oneShots.length).toBe(2); // tools-probe + model-call
		for (const s of oneShots) {
			expect(s.env).toEqual({ PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-v4-flash-vision-exp", PI_THINKING: "off" });
		}
		// boot / ext-list / cwd-independence place no model call and set no env;
		// the providers-catalog runs DO set env (scratch agent-dir) by design.
		for (const s of seen.filter((x) => !sessionCall(x) && !x.args.includes("--list-models"))) {
			expect(s.env).toBeUndefined();
		}
		// the pass note names the pinned lane (receipt quality)
		expect(r.probes.find((p) => p.id === "model-call")!.note).toContain(PIN);
	});

	test("no pin (default) → no spawn env anywhere — unchanged behavior", async () => {
		makeTree();
		const { spawn, seen } = recordingSpawn();
		await runDeployE2e({ versionDir, spawn, modelEndpoint: null });
		expect(seen.length).toBeGreaterThan(0);
		for (const s of seen.filter((x) => !x.args.includes("--list-models"))) expect(s.env).toBeUndefined();
	});

	test("pinned + over budget + NO contention → deterministic FAIL naming the lane (not a skip)", async () => {
		makeTree();
		const { now } = steppingClock(ONESHOT_RUNTIME_BUDGET_MS + 1_000); // 36.0s — the measured slow-lane wall
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn(),
			now,
			modelEndpoint: "http://127.0.0.1:1234",
			fetchImpl: fakeModelsFetch(["qwen3.8-27b", "bonsai-27b"]), // WOULD contend — wrong lane though
			modelPin: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
		});
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("fail");
		expect(mc.note).toContain("36.0s");
		expect(mc.note).toContain(PIN);
		expect(mc.note).toContain("#1976");
		// the contention warning about ANOTHER endpoint's models must not
		// downgrade a pinned lane's deterministic breach to a skip
		expect(r.warnings.length).toBe(0);
	});

	test("a completed 36s one-shot is a budget breach, NEVER a hang (36s ≠ timeout)", async () => {
		makeTree();
		const { now } = steppingClock(ONESHOT_RUNTIME_BUDGET_MS + 1_000);
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn(),
			now,
			modelPin: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
		});
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("fail");
		expect(mc.note).toContain("budget");
		expect(mc.note).not.toContain("BOOT HANG");
		expect(mc.note).not.toContain("timed out");
	});

	test("a pinned TIMEOUT still fails as a hang (the 300s detector is unchanged)", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ modelCall: { stdout: "", stderr: "[spawn] KILLED", exitCode: 124, timedOut: true } }),
			modelEndpoint: null,
			modelPin: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
		});
		const mc = r.probes.find((p) => p.id === "model-call")!;
		expect(mc.verdict).toBe("fail");
		expect(mc.note).toContain("timeout");
	});

	test("the CLI honors VERIFY_E2E_MODEL from the environment", async () => {
		makeTree();
		const saved = process.env.VERIFY_E2E_MODEL;
		try {
			process.env.VERIFY_E2E_MODEL = PIN;
			const { spawn, seen } = recordingSpawn();
			const res = await runVerifyDeployE2eCli(["--deploy-root", root], { spawn, versionDir: undefined, modelEndpoint: null });
			expect(res.exitCode).toBe(0);
			const mc = seen.find((s) => s.args.includes("-p") && !s.args.includes("-e"));
			expect(mc?.env).toEqual({ PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-v4-flash-vision-exp", PI_THINKING: "off" });
		} finally {
			if (saved === undefined) delete process.env.VERIFY_E2E_MODEL;
			else process.env.VERIFY_E2E_MODEL = saved;
		}
	});

	test("a malformed VERIFY_E2E_MODEL warns and runs unpinned (never silently)", async () => {
		makeTree();
		const saved = process.env.VERIFY_E2E_MODEL;
		try {
			process.env.VERIFY_E2E_MODEL = "deepseek-v4-flash-vision-exp"; // no provider — D8: not enough
			const { spawn, seen } = recordingSpawn();
			const res = await runVerifyDeployE2eCli(["--deploy-root", root], { spawn, versionDir: undefined, modelEndpoint: null });
			expect(res.exitCode).toBe(0);
			// ran on the default lane — no pin env anywhere. The parity probe's
			// `-e` spawns are excluded: PARITY_MODE is their identity contract, not a lane pin.
			for (const s of seen.filter((x) => !x.args.includes("--list-models") && x.env?.PARITY_MODE === undefined))
				expect(s.env).toBeUndefined();
			const payload = JSON.parse(res.stdout);
			expect(payload.warnings.join("\n")).toContain("VERIFY_E2E_MODEL");
			expect(payload.warnings.join("\n")).toContain("provider/model-id");
		} finally {
			if (saved === undefined) delete process.env.VERIFY_E2E_MODEL;
			else process.env.VERIFY_E2E_MODEL = saved;
		}
	});
});

describe("providers-catalog probe (the pre-load-providers patch, verified in the FINAL tree)", () => {
	// The historical bug class this probe exists for: pre-0.80 the hook target
	// (ModelRegistry.loadModels) vanished upstream, the patch installed a method
	// nobody called, and everything stayed green ONLY because ~/.pi/agent/
	// models.json happened to duplicate the catalog. Nothing in the deploy gates
	// or E2E re-verifies the wrap against the shipped tree — this probe does:
	// --list-models twice under a SCRATCH agent-dir, patch on vs off, and the
	// OFF run MEASURES what ambient sources provide so duplication cannot mask
	// a dead patch.

	test("healthy: every baked pair listed ON, patch-only contribution ≥1 → pass", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn(), modelEndpoint: null });
		const pc = r.probes.find((p) => p.id === "providers-catalog")!;
		expect(pc.verdict).toBe("pass");
		expect(pc.note).toContain("patch-only");
	});

	test("patch dead: a baked lane missing from the ON run FAILS naming the pair", async () => {
		makeTree();
		const on = listModelsStdout([
			...AMBIENT_ROWS,
			// every baked pair EXCEPT the lm-studio lanes — the wrap died;
			// ambient pi-ai rows still list
			...bakedModelPairs().filter((p) => p.provider !== "lm-studio").map((p) => [p.provider, p.model] as [string, string]),
		]);
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ listModels: { on, off: listModelsStdout(AMBIENT_ROWS) } }),
			modelEndpoint: null,
		});
		const pc = r.probes.find((p) => p.id === "providers-catalog")!;
		expect(pc.verdict).toBe("fail");
		expect(pc.note).toContain("lm-studio");
		expect(pc.note).toContain("google/gemma-4-12b");
	});

	test("full duplication: OFF also lists every baked pair → the patch contributes nothing → FAIL", async () => {
		makeTree();
		const both = listModelsStdout([
			...AMBIENT_ROWS,
			...bakedModelPairs().map((p) => [p.provider, p.model] as [string, string]),
		]);
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ listModels: { on: both, off: both } }),
			modelEndpoint: null,
		});
		const pc = r.probes.find((p) => p.id === "providers-catalog")!;
		expect(pc.verdict).toBe("fail");
		expect(pc.note).toContain("contributes nothing");
	});

	test("both runs carry a SCRATCH agent-dir env; the OFF run carries the patch gate", async () => {
		makeTree();
		const seen: Array<{ args: string[]; env?: Record<string, string> }> = [];
		const base = fakeSpawn();
		const spawn: SpawnFn = async (cmd, args, options) => {
			if (args.includes("--list-models")) seen.push({ args, env: options?.env });
			return base(cmd, args, options);
		};
		await runDeployE2e({ versionDir, spawn, modelEndpoint: null });
		expect(seen.length).toBe(2);
		for (const s of seen) {
			// the dashed agent-dir name a bash export cannot set (deploy script
			// precedent) + the upstream spelling
			expect(s.env?.["S2-AGENT_CODING_AGENT_DIR"]).toBeTruthy();
			expect(s.env?.PI_CODING_AGENT_DIR).toBeTruthy();
		}
		const off = seen.find((s) => s.env?.BUN_PI_PRE_LOAD_PROVIDERS === "0");
		const on = seen.find((s) => s.env?.BUN_PI_PRE_LOAD_PROVIDERS !== "0");
		expect(off).toBeTruthy();
		expect(on).toBeTruthy();
	});

	test("the OFF listing itself errors → fail (it is the baseline the diff needs)", async () => {
		makeTree();
		const r = await runDeployE2e({
			versionDir,
			spawn: fakeSpawn({ listModels: { offExit: 1 } }),
			modelEndpoint: null,
		});
		const pc = r.probes.find((p) => p.id === "providers-catalog")!;
		expect(pc.verdict).toBe("fail");
		expect(pc.note).toContain("patch-off");
	});

	test("parseListModelsRows (pure): columns, header skipped, blank-safe", () => {
		const rows = parseListModelsRows(
			[
				"provider     model                                context",
				"lm-studio    google/gemma-4-12b                   200K     65.5K",
				"",
				"deepseek     deepseek-v4-flash                    1M",
			].join("\n"),
		);
		expect(rows.get("lm-studio")?.has("google/gemma-4-12b")).toBe(true);
		expect(rows.get("deepseek")?.has("deepseek-v4-flash")).toBe(true);
		expect(rows.has("provider")).toBe(false);
	});

	test("bakedModelPairs mirrors PROVIDERS §1 (catalog-true, not hardcoded)", () => {
		const pairs = bakedModelPairs();
		expect(pairs.length).toBe(
			Object.values(PROVIDERS).reduce((n, e) => n + e.models.length, 0),
		);
		expect(pairs.some((p) => p.provider === "lm-studio" && p.model === "prism-ml/bonsai-27b")).toBe(true);
	});
});

// ── vision-call probe (the #1981 follow-up — default vision lane health) ────
// The probe's contract: only a model that SAW the fixture image can produce
// its text; a silent text-model fallback (the measured broken-lane signature)
// must FAIL, provider-down must SKIP.
const visionAsk = (r: Partial<VisionAskOutcome>): ((p: string) => Promise<VisionAskOutcome>) =>
	async (imagePath: string) => {
		// The seam must receive the fixture the recipe wrote.
		if (!imagePath.endsWith("vision-e2e.png")) throw new Error(`unexpected fixture path: ${imagePath}`);
		return { ok: true, reply: "", ...r };
	};

describe("vision-call probe", () => {
	const F2MD = ["task", "wayfind", "file2md"];
	// fakeSpawn's default --ext-list payload is ["task","wayfind"] — a file2md
	// deploy set needs the loaded list to match or ext-load fails first.
	const f2mdSpawn = () => fakeSpawn({ extList: { loaded: F2MD } });

	// NOTE on these tests: the unit fixture tree carries ext/file2md/ext.json
	// but NO real ext.cjs bundle, so the file2md-ocr probe fails artifactually
	// on every F2MD tree — assertions here target the vision-call probe's OWN
	// verdict (and the other probes' pass/skip mix), not the overall verdict.

	test("a reply containing the fixture text passes and names the lane evidence", async () => {
		makeTree({ extensions: F2MD });
		const r = await runDeployE2e({
			versionDir,
			spawn: f2mdSpawn(),
			visionAsk: visionAsk({ ok: true, reply: 'The text is "FILE2MD E2E OCR".' }),
		});
		const vc = r.probes.find((p) => p.id === "vision-call")!;
		expect(vc.verdict).toBe("pass");
		expect(vc.note).toContain(VISION_FIXTURE_NEEDLE);
		expect(vc.note).toContain("fixture image");
		// every probe EXCEPT the bundle-less ocr artifact passes
		expect(
			r.probes.filter(
				p => p.id !== "file2md-ocr" && p.id !== "tool-gate-fire" && p.id !== "standalone-import" && p.id !== "parity",
			).every((p) => p.verdict === "pass"),
		).toBe(true);
	});

	test("a reply WITHOUT the fixture text fails — the image was not processed", async () => {
		makeTree({ extensions: F2MD });
		const r = await runDeployE2e({
			versionDir,
			spawn: f2mdSpawn(),
			visionAsk: visionAsk({ ok: true, reply: "I cannot see any image in this conversation." }),
		});
		expect(r.verdict).toBe("fail");
		const vc = r.probes.find((p) => p.id === "vision-call")!;
		expect(vc.verdict).toBe("fail");
		expect(vc.note).toContain("did NOT read the image");
	});

	test("empty output fails citing the text-model fallback signature (the #1981 class)", async () => {
		makeTree({ extensions: F2MD });
		const r = await runDeployE2e({
			versionDir,
			spawn: f2mdSpawn(),
			visionAsk: visionAsk({ ok: false, reply: "", error: "Subagent produced no assistant output" }),
		});
		expect(r.verdict).toBe("fail");
		const vc = r.probes.find((p) => p.id === "vision-call")!;
		expect(vc.verdict).toBe("fail");
		expect(vc.note).toContain("text-model fallback");
	});

	test("a provider-down error is a SKIP that degrades the verdict, never a fail", async () => {
		makeTree({ extensions: F2MD });
		const r = await runDeployE2e({
			versionDir,
			spawn: f2mdSpawn(),
			visionAsk: visionAsk({ ok: false, reply: "", error: "fetch failed: connection refused" }),
		});
		const vc = r.probes.find((p) => p.id === "vision-call")!;
		expect(vc.verdict).toBe("skip");
		expect(vc.note).toContain("provider down");
		// an OUTCOME-driven skip degrades the overall verdict (worst() includes
		// it) — the only fail on this tree is the bundle-less ocr artifact
		expect(r.verdict).toBe("fail"); // ocr artifact fail outranks the skip
		expect(r.probes.filter((p) => p.id !== "file2md-ocr" && p.id !== "standalone-import").every((p) => p.verdict !== "fail")).toBe(true);
	});

	test("a deadline breach is a SKIP naming the abandonment (injectable cap)", async () => {
		makeTree({ extensions: F2MD });
		const r = await runDeployE2e({
			versionDir,
			spawn: f2mdSpawn(),
			visionCallCapMs: 5,
			visionAsk: () => new Promise<VisionAskOutcome>(() => {}), // never resolves
		});
		const vc = r.probes.find((p) => p.id === "vision-call")!;
		expect(vc.verdict).toBe("skip");
		expect(vc.note).toContain("exceeded");
		expect(vc.note).toContain("abandoned");
	});

	test("a refusal phrased like connectivity is NOT provider-down (narrow regex)", async () => {
		makeTree({ extensions: F2MD });
		const r = await runDeployE2e({
			versionDir,
			spawn: f2mdSpawn(),
			visionAsk: visionAsk({ ok: false, reply: "", error: "I am not configured to see images" }),
		});
		const vc = r.probes.find((p) => p.id === "vision-call")!;
		expect(vc.verdict).toBe("fail");
	});

	test("--skip-model-call skips the vision probe without degrading the verdict", async () => {
		makeTree({ extensions: F2MD });
		let asked = false;
		const r = await runDeployE2e({
			versionDir,
			spawn: f2mdSpawn(),
			skipModelCall: true,
			visionAsk: async (p) => {
				asked = true;
				return visionAsk({})(p);
			},
		});
		expect(asked).toBe(false);
		const vc = r.probes.find((p) => p.id === "vision-call")!;
		expect(vc.verdict).toBe("skip");
		expect(vc.note).toContain("skipped by caller");
		// model-call is skip-by-caller too; nothing may FAIL outside the ocr artifact
		expect(r.probes.filter((p) => p.id !== "file2md-ocr" && p.id !== "tool-gate-fire" && p.id !== "standalone-import").every((p) => p.verdict !== "fail")).toBe(true);
	});

	test("an unreadable ext.json is a structured fail, never a throw", async () => {
		makeTree({ extensions: F2MD });
		writeFileSync(join(versionDir, "ext", "file2md", "ext.json"), "{");
		const r = await runDeployE2e({ versionDir, spawn: f2mdSpawn(), visionAsk: visionAsk({ reply: "x" }) });
		expect(r.verdict).toBe("fail");
		const vc = r.probes.find((p) => p.id === "vision-call")!;
		expect(vc.verdict).toBe("fail");
		expect(vc.note).toContain("execution failed");
	});

	// Hermeticity contract (no test): the recipe's DEFAULT visionAsk seam hits
	// the network (s2-agent patch set + a real model call) — every unit test
	// here injects; the default is exercised only by live CLI runs against a
	// real deploy root.
});

describe("vision pure helpers", () => {
	test("normalizeVisionReply collapses case/whitespace/quotes so needle matching is robust", () => {
		expect(normalizeVisionReply('  "File2md   E2E  OCR!"  ')).toContain(VISION_FIXTURE_NEEDLE);
		expect(normalizeVisionReply("file2md e2e ocr")).toBe(VISION_FIXTURE_NEEDLE);
	});
	test("visionErrorIsProviderDown matches provider smells, not model failures", () => {
		expect(visionErrorIsProviderDown("fetch failed: connection refused")).toBe(true);
		expect(visionErrorIsProviderDown("request timed out after 30000ms")).toBe(true);
		expect(visionErrorIsProviderDown("401 unauthorized")).toBe(true);
		expect(visionErrorIsProviderDown("Subagent produced no assistant output")).toBe(false);
		expect(visionErrorIsProviderDown("model not found in the provided modelRuntime")).toBe(false);
		// narrow by design: a refusal phrased like connectivity must FAIL, not skip
		expect(visionErrorIsProviderDown("I am not configured to see images")).toBe(false);
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
	test("--dev-launcher <path> parses to devLauncher", () => {
		const r = parseVerifyDeployE2eArgs(["--dev-launcher", "/w/s2-agent.sh", "--deploy-root", "/d"]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.args.devLauncher).toBe("/w/s2-agent.sh");
	});
	test("--dev-launcher without a value is a usage error", () => {
		const r = parseVerifyDeployE2eArgs(["--dev-launcher"]);
		expect(r.ok).toBe(false);
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

	test("--dev-launcher flows through: parity runs against the given launcher", async () => {
		makeTree();
		const seen: string[] = [];
		const spawn: SpawnFn = async (cmd, args, options) => {
			if (args.includes("-e") && options?.env?.PARITY_MODE) seen.push(`${options.env.PARITY_MODE}:${cmd}`);
			return fakeSpawn()(cmd, args, options);
		};
		const res = await runVerifyDeployE2eCli(["--deploy-root", root, "--dev-launcher", "/w/dev-s2-agent.sh"], {
			spawn,
			versionDir: undefined,
			modelEndpoint: null,
		});
		expect(res.exitCode).toBe(0);
		const parity = JSON.parse(res.stdout).probes.find((p: { id: string }) => p.id === "parity");
		expect(parity.verdict).toBe("pass");
		expect(seen).toContain("dev:/w/dev-s2-agent.sh");
	});

	test("no --dev-launcher flag: repo-root s2-agent.sh is the default baseline", async () => {
		makeTree();
		const seen: string[] = [];
		const spawn: SpawnFn = async (cmd, args, options) => {
			if (args.includes("-e") && options?.env?.PARITY_MODE) seen.push(cmd);
			return fakeSpawn()(cmd, args, options);
		};
		const res = await runVerifyDeployE2eCli(["--deploy-root", root], { spawn, versionDir: undefined, modelEndpoint: null });
		expect(res.exitCode).toBe(0);
		// s2-agent.sh is tracked in git → present in every checkout/worktree,
		// so the default deterministically resolves wherever tests run.
		expect(seen).toContain(resolve(import.meta.dir, "..", "..", "..", "s2-agent.sh"));
	});
});

/** A win32 tree: s2-agent.cmd + .ps1 (the .cmd's real target) and deploy.json
 *  runtime facts naming win32; the recipe must boot it through `cmd /c`. */
function makeWin32Tree(): string {
	rmSync(join(root, "current"), { force: true });
	rmSync(versionDir, { recursive: true, force: true });
	mkdirSync(versionDir, { recursive: true });
	writeFileSync(join(versionDir, "s2-agent.cmd"), "@echo off\r\n");
	writeFileSync(join(versionDir, "s2-agent.ps1"), "# ps1\n");
	writeFileSync(
		join(versionDir, "deploy.json"),
		JSON.stringify({
			version: VERSION,
			sourceSha: "deadbee",
			config: { extensions: [{ name: "task", enabled: true }] },
			runtime: { platform: "win32", arch: "x64" },
		}),
	);
	symlinkSync(VERSION, join(root, "current"), "dir");
	return versionDir;
}

describe("crossos t06 — platform-aware launcher", () => {

	test("launcherInvocation (pure): win32 → cmd /c s2-agent.cmd; else ./s2-agent.sh", async () => {
		const { launcherInvocation } = await import("../src/deploy-e2e-recipe.js");
		expect(launcherInvocation("win32")).toEqual({
			file: "s2-agent.cmd",
			command: "cmd",
			prefix: ["/c", "s2-agent.cmd"],
		});
		expect(launcherInvocation("darwin")).toEqual({ file: "s2-agent.sh", command: "./s2-agent.sh", prefix: [] });
		expect(launcherInvocation("linux")).toEqual({ file: "s2-agent.sh", command: "./s2-agent.sh", prefix: [] });
		// pre-t05 tree: no runtime facts → the sh launcher, unchanged behavior
		expect(launcherInvocation(undefined)).toEqual({ file: "s2-agent.sh", command: "./s2-agent.sh", prefix: [] });
	});

	test("a win32 tree boots through cmd /c (command + prefix recorded at every probe)", async () => {
		makeWin32Tree();
		const seen: Array<{ cmd: string; args: string[] }> = [];
		const spawn: SpawnFn = async (cmd, args, options) => {
			seen.push({ cmd, args });
			if (args.includes("--help")) return { stdout: "usage…", stderr: "", exitCode: 0 };
			if (args.includes("--list-models")) {
				const lm = defaultListModels();
				return { stdout: options?.env?.BUN_PI_PRE_LOAD_PROVIDERS === "0" ? lm.off : lm.on, stderr: "", exitCode: 0 };
			}
			if (args.includes("--ext-list"))
				return { stdout: JSON.stringify({ loadedCount: 1, loaded: ["task"], skipped: [] }), stderr: "", exitCode: 0 };
			if (args.includes("-e"))
				return {
					stdout: "",
					stderr: `[TOOLS] ${JSON.stringify({
						total: 66,
						matched: 26,
						activeCount: 26,
						active: ["read", "write", "edit", "bash", "enable_tool"],
						missing: [],
						gateSeam: { activeCount: 26, totalCount: 66, coreCount: 4 },
						getActiveTools: true,
					})}\n`,
					exitCode: 0,
				};
			return { stdout: "ok", stderr: "", exitCode: 0 };
		};
		const r = await runDeployE2e({ versionDir, spawn, modelEndpoint: null });
		expect(r.verdict).toBe("pass");
		expect(seen.length).toBe(7); // boot, ext-load, cwd-independence, tools-probe, providers-catalog×2 (on/off), model-call
		for (const s of seen) {
			expect(s.cmd).toBe("cmd");
			expect(s.args[0]).toBe("/c");
			// cwd-independence absolutizes the .cmd path (it runs from
			// outside the tree); every other probe uses the relative form.
			expect(s.args[1] === "s2-agent.cmd" || s.args[1].endsWith("/s2-agent.cmd")).toBe(true);
		}
	});

	test("a win32 tree WITHOUT s2-agent.cmd fails fast naming the cmd launcher", async () => {
		makeWin32Tree();
		rmSync(join(versionDir, "s2-agent.cmd"), { force: true });
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		expect(r.verdict).toBe("fail");
		expect((r as { note?: string }).note).toContain("s2-agent.cmd missing");
	});
});

describe("crossos t06 review — env skip + ps1 presence", () => {
	test("S2_AGENT_E2E_SKIP_MODEL_CALL=1 is honored by the CLI (one opt-out surface with deploy-cli)", async () => {
		makeTree();
		const saved = process.env.S2_AGENT_E2E_SKIP_MODEL_CALL;
		try {
			process.env.S2_AGENT_E2E_SKIP_MODEL_CALL = "1";
			const res = await runVerifyDeployE2eCli(["--deploy-root", root], {
				spawn: fakeSpawn(),
				versionDir: undefined,
				modelEndpoint: null,
			});
			expect(res.exitCode).toBe(0);
			const payload = JSON.parse(res.stdout);
			expect(payload.verdict).toBe("pass"); // caller-skip never fails
			const model = payload.probes.find((p: { id: string }) => p.id === "model-call");
			expect(model.verdict).toBe("skip");
			expect(model.note).toContain("S2_AGENT_E2E_SKIP_MODEL_CALL");
		} finally {
			if (saved === undefined) delete process.env.S2_AGENT_E2E_SKIP_MODEL_CALL;
			else process.env.S2_AGENT_E2E_SKIP_MODEL_CALL = saved;
		}
	});

	test("a win32 tree missing s2-agent.ps1 (the .cmd's real target) fails fast naming it", async () => {
		makeWin32Tree();
		rmSync(join(versionDir, "s2-agent.ps1"), { force: true });
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		expect(r.verdict).toBe("fail");
		expect((r as { note?: string }).note).toContain("s2-agent.ps1 missing");
	});
});

describe("isBunShellChildSignature (win32 upstream-block classification)", () => {
	// The measured windows-latest signature (bun 1.4.0 = latest, 2026-08-28):
	// bun-direct delivers, cmd's own echo delivers, bun as cmd's child and
	// the .cmd shim deliver nothing. Exactly this → SKIP, never FAIL.
	test("the measured signature classifies as the upstream bug", () => {
		expect(
			isBunShellChildSignature({ "bun-direct": 1299, "cmd-echo": 22, "cmd-bun": 0, "cmd-shim": 0, "ps1-direct": 0 }),
		).toBe(true);
	});

	test("a genuine launcher defect does NOT classify (bun-direct broken too)", () => {
		expect(
			isBunShellChildSignature({ "bun-direct": 0, "cmd-echo": 22, "cmd-bun": 0, "cmd-shim": 0 }),
		).toBe(false);
	});

	test("a cmd-only defect does NOT classify (cmd's own echo lost as well)", () => {
		expect(
			isBunShellChildSignature({ "bun-direct": 1299, "cmd-echo": 0, "cmd-bun": 0, "cmd-shim": 0 }),
		).toBe(false);
	});

	test("the launcher suddenly delivering output does NOT classify (bug fixed → probes pass)", () => {
		expect(
			isBunShellChildSignature({ "bun-direct": 1299, "cmd-echo": 22, "cmd-bun": 1299, "cmd-shim": 1299 }),
		).toBe(false);
	});
});

describe("isNoConsoleRelayWorkaround (win32 ticket-02 relay-route signature)", () => {
	// The route ticket 02 wants to prove on windows-latest: the full
	// launcher-shaped chain (cmd → powershell relay → CREATE_NO_WINDOW bun)
	// delivers bun's bytes while the direct .cmd shim still loses them.
	test("relay delivers through cmd while the direct shim loses → WORKS", () => {
		expect(
			isNoConsoleRelayWorkaround({ "cmd-shim": 0, "cmd-ps1-nw-relay": 1299, "ps1-nw-relay": 1299 }),
		).toBe(true);
	});

	test("relay losing through cmd does NOT classify (shipped-shim rewrite would be blind)", () => {
		expect(
			isNoConsoleRelayWorkaround({ "cmd-shim": 0, "cmd-ps1-nw-relay": 0, "ps1-nw-relay": 1299 }),
		).toBe(false);
	});

	test("missing relay measurement does NOT classify (absent is unknown, not works)", () => {
		expect(isNoConsoleRelayWorkaround({ "cmd-shim": 0 })).toBe(false);
	});

	test("a fixed launcher does NOT need the route (shim already speaks)", () => {
		expect(
			isNoConsoleRelayWorkaround({ "cmd-shim": 1299, "cmd-ps1-nw-relay": 1299 }),
		).toBe(false);
	});
});

describe("isBunRelayWorkaround (win32 ticket-02 bun-relay signature, diag iteration 2)", () => {
	// The iteration-2 candidate: cmd → bun -e relay (stdout dead as cmd's
	// child, alive otherwise) spawns the core directly and writes the file
	// ITSELF — the receipt is the relay file, keyed `cmd-bun-relay-file-file`.
	test("relay file nonzero while the direct shim loses → WORKS", () => {
		expect(
			isBunRelayWorkaround({ "cmd-shim": 0, "cmd-bun-relay-file": 0, "cmd-bun-relay-file-file": 1299 }),
		).toBe(true);
	});

	test("empty relay file does NOT classify", () => {
		expect(
			isBunRelayWorkaround({ "cmd-shim": 0, "cmd-bun-relay-file": 0, "cmd-bun-relay-file-file": 0 }),
		).toBe(false);
	});

	test("missing relay-file measurement does NOT classify (absent is unknown)", () => {
		expect(isBunRelayWorkaround({ "cmd-shim": 0, "cmd-bun-relay-file": 0 })).toBe(false);
	});

	test("a fixed launcher does NOT need the route (shim already speaks)", () => {
		expect(
			isBunRelayWorkaround({ "cmd-shim": 1299, "cmd-bun-relay-file-file": 1299 }),
		).toBe(false);
	});
});

describe("dummyEnvForBakedCatalog (providers-catalog runner contract)", () => {
	// The first crossos exposure (run 33385015007, 2026-08-31): env-keyed
	// baked providers never list on keyless runners, so the probe failed
	// 10/14 on BOTH rows. The dummy seeds must cover exactly the `$VAR`
	// references — literal keys contribute nothing.
	test("extracts $VAR apiKeys as dummy values", () => {
		expect(
			dummyEnvForBakedCatalog({
				deepseek: { apiKey: "$DEEPSEEK_API_KEY" },
				zai: { apiKey: "$ZAI_API_KEY" },
			}),
		).toEqual({ DEEPSEEK_API_KEY: "e2e-dummy-key", ZAI_API_KEY: "e2e-dummy-key" });
	});

	test("literal-string apiKeys contribute nothing", () => {
		expect(dummyEnvForBakedCatalog({ "lm-studio": { apiKey: "lm-studio" } })).toEqual({});
	});

	test("the REAL baked catalog yields at least one env var (deepseek lane)", () => {
		expect(Object.keys(dummyEnvForBakedCatalog()).length).toBeGreaterThan(0);
	});
});
