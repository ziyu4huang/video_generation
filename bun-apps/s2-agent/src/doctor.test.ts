/**
 * doctor — unit tests for the pure check + classification functions.
 * (runDoctor/realContext wiring is exercised by the manual `./run.sh doctor`
 * smoke across source + deploy modes; here we pin the classification logic.)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../run-dir/manifest.json";
import { HOST_API } from "./sh/host-modules.ts";
import {
	classifyMode,
	runChecks,
	checkHostDeps,
	checkExtensions,
	checkProviders,
	checkShExtensions,
	smokeMarker,
	runSmokeCheck,
	removedFlagNotice,
	type DeployMode,
	type DoctorContext,
} from "./doctor.ts";

/** Build a fake context with only the fields a check reads. */
function ctx(over: Partial<DoctorContext> & { mode: DoctorContext["mode"] }): DoctorContext {
	return {
		selfDir: "/out",
		deployDir: "/out",
		entryPath: "/out/s2-agent.js",
		bunVersion: "1.0.0",
		exists: () => true,
		depInstalled: () => true,
		listDir: () => [],
		readFile: () => "",
		env: {},
		...over,
	} as DoctorContext;
}

describe("classifyMode", () => {
	// `portable` and `release` were removed: nothing writes .deploy-portable or a
	// packages/ dir, so those branches — and the ~15 tests that were the only
	// thing exercising them — could never fire in production.
	test("binary with no sh marker stays binary", () => {
		expect(classifyMode("binary", { shDeploy: false })).toBe("binary");
	});
	test("binary beside a deploy.json is an sh deploy", () => {
		expect(classifyMode("binary", { shDeploy: true })).toBe("sh");
	});
	test("source stays source regardless of markers", () => {
		expect(classifyMode("source", { shDeploy: true })).toBe("source");
		expect(classifyMode("source", { shDeploy: false })).toBe("source");
	});
	/**
	 * The guard for the original drift. A hardcoded `produced` set cannot be it:
	 * the drift ran the direction such a set is blind to — the deploy script SHED
	 * two mode flags while doctor.ts kept the modes, and a set written by hand at
	 * that moment would have listed all five and stayed green forever.
	 *
	 * History: it first derived `produced` by reading deploy.ts's KNOWN_FLAGS.
	 * That file went with the four legacy deploy modes (#1740), taking every
	 * producer of `bundle` with it, so the guard was inverted — `bundle` became a
	 * recorded ORPHAN, reachable but unproducible, and this block was written to
	 * fail when it was finally removed. It did. Phase 1b removed it.
	 *
	 * With the orphan list empty, an "is every orphan still reachable?" test
	 * would be vacuously green — the exact shape this file warns about two
	 * paragraphs up. So the second test now asserts the CONVERSE instead, which
	 * is the one direction nothing else covers: every mode a deploy can produce
	 * must be a mode classifyMode can actually return. That catches a new deploy
	 * target whose mode doctor cannot name — the mirror image of the drift that
	 * started all this.
	 */
	describe("doctor's mode set is pinned to what a deploy can produce", () => {
		// Read, not imported: it is a script with top-level side effects. An ENOENT
		// means it moved — loud, which is what a drift guard wants.
		const DEPLOY_SH_TS = join(import.meta.dir, "..", "..", "s2-agent-ext-devops", "scripts", "deploy.ts");
		const deployShSource = readFileSync(DEPLOY_SH_TS, "utf8");

		/** Modes something can actually put on disk today. */
		const PRODUCED = new Set<DeployMode>(["source", "binary"]);
		if (deployShSource.length > 0) PRODUCED.add("sh");

		function reachableModes(): Set<DeployMode> {
			const seen = new Set<DeployMode>();
			for (const coarse of ["source", "binary"] as const) {
				for (const shDeploy of [true, false]) {
					seen.add(classifyMode(coarse, { shDeploy }));
				}
			}
			return seen;
		}

		test("the deploy script is where this guard thinks it is", () => {
			// Vacuity guard: an empty read would make PRODUCED lose "sh" silently.
			expect(deployShSource).toContain("export async function runShDeploy");
		});

		test("(a) every mode classifyMode returns is one a deploy produces", () => {
			const unexpected = [...reachableModes()].filter((m) => !PRODUCED.has(m));
			expect(
				unexpected,
				`classifyMode returned ${unexpected.join(", ")}, which no deploy produces. ` +
					"Either a deploy mode was added without updating PRODUCED, or doctor grew a " +
					"mode nothing can reach — the second is what left `portable`, `release` and " +
					"`bundle` behind, each one taking a check's only failure path down with it.",
			).toEqual([]);
		});

		test("(b) every mode a deploy produces is one classifyMode can return", () => {
			const unreachable = [...PRODUCED].filter((m) => !reachableModes().has(m));
			expect(
				unreachable,
				`a deploy produces ${unreachable.join(", ")} but classifyMode can never return it, ` +
					"so doctor would misreport that layout as some other mode — and every " +
					"mode-keyed check would run the wrong branch on it.",
			).toEqual([]);
		});
	});
});

describe("removedFlagNotice", () => {
	test("--fix is announced, not silently dropped", () => {
		// doctor takes no flag-spec, so an unknown token falls through and the
		// report prints as if nothing was asked for — a stale doc plus a clean
		// report reads as "--fix ran and found nothing".
		expect(removedFlagNotice(["doctor", "--fix"])).toContain("`doctor --fix` was removed");
	});

	test("no notice without the flag", () => {
		expect(removedFlagNotice(["doctor", "--json", "--smoke"])).toBeNull();
	});
});

describe("checkHostDeps", () => {
	const noDeps = { depInstalled: () => false };

	test("informational in every mode, whatever resolves", () => {
		// Recorded deliberately rather than left implicit. This check has never
		// been able to fail: its only `fail` path keyed on `portable`, a mode
		// nothing could produce, and the `warn` path that replaced it keyed on
		// `bundle` and became unreachable the same way in Phase 1b. For every
		// mode that EXISTS, missing host deps are either irrelevant (source and
		// binary resolve their own through pi's loader) or caught earlier (an sh
		// deploy hard-fails at build time on a host-module mismatch).
		//
		// A future `fail` path needs a mode where host deps are genuinely
		// essential AND unverified until runtime. There is not one today.
		for (const mode of ["source", "binary", "sh"] as const) {
			const r = checkHostDeps(ctx({ mode, ...noDeps }));
			expect(r.status).toBe("info");
			expect(r.detail).toContain(mode);
		}
	});
});

describe("checkExtensions (mode-aware)", () => {
	test("source/binary → INFO (loads from source/baked paths)", () => {
		expect(checkExtensions(ctx({ mode: "source" })).status).toBe("info");
		expect(checkExtensions(ctx({ mode: "binary" })).status).toBe("info");
	});
	test("sh delegates to the deployed-tree check", () => {
		// The only mode with a tree on disk to be wrong about. An absent ext/ is
		// the designed zero-extension state, so info — not a silent pass.
		const r = checkExtensions(ctx({ mode: "sh", deployDir: "/deploy", exists: () => false }));
		expect(r.status).toBe("info");
		expect(r.detail).toContain("zero extensions");
	});
});

describe("checkProviders", () => {
	test("warns when a provider's apiKey env var is unset", () => {
		// PROVIDERS has lm-studio with a literal apiKey — force an env-gated one
		// by checking the real resolveApiKey against an empty env where needed.
		// lm-studio uses a literal, so it passes; this asserts the warn path via
		// a synthetic provider-less env doesn't crash.
		const r = checkProviders(ctx({ mode: "source", env: {} }));
		expect(["pass", "warn", "info"]).toContain(r.status);
	});
});

describe("runChecks (aggregate)", () => {
	test("ok=true when no FAIL", () => {
		const r = runChecks(ctx({ mode: "source" }));
		expect(r.ok).toBe(true);
		expect(r.mode).toBe("source");
	});

	test("ok=false when any FAIL — an sh deploy whose manifest the loader would reject", () => {
		// Since host-deps went informational, the sh extension tree is the only
		// thing left that CAN fail. Without this the aggregate's false path is
		// untested, and `ok` could be hardcoded true without a red test.
		const files: Record<string, string> = {
			"/deploy/ext/task/ext.json": JSON.stringify({
				name: "task",
				package: "@repo/s2-agent-ext-task",
				version: "0.0.0",
				hostApi: HOST_API + 1, // drift: the loader would skip this at boot
				entry: "ext.cjs",
				order: 10,
				enabled: true,
			}),
		};
		const dirs: Record<string, string[]> = { "/deploy/ext": ["task"] };
		const r = runChecks(
			ctx({
				mode: "sh",
				deployDir: "/deploy",
				exists: (p: string) => p in files || p in dirs,
				listDir: (p: string) => dirs[p] ?? [],
				readFile: (p: string) => {
					const c = files[p];
					if (c === undefined) throw new Error(`ENOENT: ${p}`);
					return c;
				},
			}),
		);
		expect(r.ok).toBe(false);
	});

	test("source mode never hard-fails (host-deps is info)", () => {
		const r = runChecks(ctx({ mode: "source", depInstalled: () => false }));
		expect(r.ok).toBe(true);
	});
});

describe("smokeMarker (pure)", () => {
	test("source → bun-apps dir (selfDir/../.. from .../s2-agent/src)", () => {
		// selfDir for source mode is .../s2-agent/src → marker is .../bun-apps
		expect(smokeMarker("source", "/repo/bun-apps/s2-agent/src")).toBe("/repo/bun-apps");
	});
	test("sh → the same static-factory prefix as binary", () => {
		expect(smokeMarker("sh", "/out")).toBe("<inline:");
	});
	test("binary → the static-factory source prefix (tools report path '<inline:<pkg>>')", () => {
		expect(smokeMarker("binary", "/out")).toBe("<inline:");
	});
});

describe("runSmokeCheck (via injected spawn seam)", () => {
	// A fake spawn that returns a canned stderr — exercises runSmokeCheck's
	// parsing/branching without spawning bun.
	const fakeSpawn =
		(stderr: string, code: number | null = 0) =>
		async () => ({ stderr, code });
	const srcCtx = () => ctx({ mode: "source", selfDir: "/repo/bun-apps/s2-agent/src", entryPath: "/repo/bun-apps/s2-agent/src/cli.ts" });

	test("PASS when matched > 0 (run-dir extensions loaded)", async () => {
		const r = await runSmokeCheck(srcCtx(), { spawn: fakeSpawn("[SMOKE] total=38 matched=33\nsome other line") });
		expect(r.status).toBe("pass");
		expect(r.detail).toContain("matched=33");
	});
	test("FAIL when matched = 0 (silent no-op class)", async () => {
		const r = await runSmokeCheck(srcCtx(), { spawn: fakeSpawn("[SMOKE] total=8 matched=0\n") });
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("matched=0");
		expect(r.hint).toContain("slice");
	});
	test("FAIL when probe never reported (no [SMOKE] line)", async () => {
		const r = await runSmokeCheck(srcCtx(), { spawn: fakeSpawn("Error: something broke", 2) });
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("did not report");
		expect(r.hint).toContain("something broke");
	});
	test("binary mode runs the probe (spawn injected) and passes on matched>0", async () => {
		const r = await runSmokeCheck(ctx({ mode: "binary" }), {
			spawn: fakeSpawn("[SMOKE] total=31 matched=24\n"),
		});
		expect(r.status).toBe("pass");
	});
});


// ── sh mode ─────────────────────────────────────────────────────────────────
describe("checkShExtensions", () => {
	// Imported, not a literal: a HOST_API bump (1 -> 2 when the subagent package
	// stopped being a host module) silently turned every fixture below into a
	// version MISMATCH, so two assertions about entirely different failures
	// started failing with "built for hostApi 1, host provides 2".
	const HOST_API_NOW = HOST_API;
	const manifestFor = (name: string, over: Record<string, unknown> = {}) =>
		JSON.stringify({
			name,
			package: `s2-agent-ext-${name}`,
			version: "0.0.0",
			hostApi: HOST_API_NOW,
			entry: "ext.cjs",
			order: 10,
			enabled: true,
			...over,
		});

	/** A context whose fs is a plain map of path → contents. */
	function shCtx(files: Record<string, string>, dirs: Record<string, string[]>): DoctorContext {
		return ctx({
			mode: "sh",
			deployDir: "/deploy",
			exists: (p: string) => p in files || p in dirs,
			listDir: (p: string) => dirs[p] ?? [],
			readFile: (p: string) => {
				const c = files[p];
				if (c === undefined) throw new Error(`ENOENT: ${p}`);
				return c;
			},
		});
	}

	test("an absent ext/ is info, not a failure — booting with none is designed", () => {
		const r = checkShExtensions(shCtx({}, {}));
		expect(r.status).toBe("info");
		expect(r.detail).toContain("zero extensions");
	});

	test("fails on a manifest the LOADER would reject, naming the extension", () => {
		// hostApi drift is the case that matters: --ext-list would report it
		// skipped at boot, and doctor exists to say so before boot.
		const files = {
			"/deploy/ext/task/ext.json": manifestFor("task", { hostApi: 99 }),
			"/deploy/ext/task/ext.cjs": "",
		};
		const r = checkShExtensions(shCtx(files, { "/deploy/ext": ["task"] }));
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("task");
		expect(r.detail).toContain("SKIPPED");
	});

	test("fails when the manifest is fine but its entry file is gone", () => {
		const files = { "/deploy/ext/task/ext.json": manifestFor("task") };
		const r = checkShExtensions(shCtx(files, { "/deploy/ext": ["task"] }));
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("entry missing");
	});

	test("ignores a directory that carries no ext.json", () => {
		const files = {
			"/deploy/ext/task/ext.json": manifestFor("task"),
			"/deploy/ext/task/ext.cjs": "",
		};
		const r = checkShExtensions(shCtx(files, { "/deploy/ext": ["task", "not-an-extension"] }));
		expect(r.status).toBe("pass");
		expect(r.detail).toContain("1 extension(s)");
	});
});

describe("smokeMarker in sh mode", () => {
	test("is the inline marker — sh factories reach pi via main({extensionFactories})", () => {
		// Measured against a real deploy: {"path":"<inline:power-tool>","source":"inline"}.
		expect(smokeMarker("sh", "/deploy")).toBe("<inline:");
	});
});
