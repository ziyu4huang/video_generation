import { describe, it, mock, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMainSpec, parseWorkflowArgs, workflowRunCommand } from "../commands/workflow.ts";
import type { ParsedArgs } from "../args.ts";

function args(partial: Partial<ParsedArgs>): ParsedArgs {
	// Only model/provider matter for buildMainSpec; spread a minimal base.
	return { verbose: 0, positionals: [], json: false, ...partial } as ParsedArgs;
}

// ─── D4-1: --out-dir > PI_WORKFLOWS_OUT_DIR > default precedence ───────────
//
// `workflow.ts` computes `const outDir = parsed.outDir ?? process.env.PI_WORKFLOWS_OUT_DIR;`
// and forwards it to `runWorkflowScript({ outDir, ... })`. We stub the engine
// entrypoint with mock.module so we can capture the exact `outDir` value the
// CLI layer forwards, then drive `workflowRunCommand.run()` under three env/flag
// matrices.
//
// mock.module is process-global in Bun and mock.restore() does NOT invalidate
// the cached binding for modules that already resolved to the mock — so a plain
// stub leaks into sibling test files (notably src/cli/__tests__/workflow-retrieval-
// quality.test.ts, which imports the real runWorkflowScript and would receive
// our fake receipt). To stay hermetic, the stub is a TRANSPARENT PASSTHROUGH by
// default: when `capturing` is false, every call is forwarded to the REAL module
// loaded by source path (bypassing the package-name mock). Only when a test sets
// `capturing = true` does runWorkflowScript short-circuit with a fake receipt
// and record `outDir`. Sibling files never toggle capturing, so they see the
// real implementation regardless of mock leakage.
const NOT_CAPTURED_YET = Symbol("not-captured");
let capturedOutDir: unknown = NOT_CAPTURED_YET;
// Captured model-resolution inputs (Task 3): the CLI layer must forward
// callerModel (from --model/--provider), envModel (from PI_MODEL), and
// piDefaultModel (from resolveLLM + user settings) so the engine can apply
// its 4-tier precedence. Asserted in the D4-3 cases below.
let capturedCallerModel: unknown = NOT_CAPTURED_YET;
let capturedEnvModel: unknown = NOT_CAPTURED_YET;
let capturedPiDefaultModel: unknown = NOT_CAPTURED_YET;
// Fake receipt fields the stub returns when capturing — lets the CLI's
// receipt-printing branch render `model` + `modelSource` deterministically.
let fakeModel: string | undefined = undefined;
let fakeModelSource: string = "pi-default";
let capturing = false;

// Direct source import bypasses the `@repo/pi-agent-ext-workflow` package-name
// mock (the source uses relative internal imports, so Bun never routes back
// through the mocked specifier).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realModulePromise: Promise<any> | null = null;
function realModule(): Promise<typeof import("@repo/pi-agent-ext-workflow")> {
	if (!realModulePromise) {
		realModulePromise = import("../../../../pi-agent-ext-workflow/src/index.ts");
	}
	return realModulePromise;
}

mock.module("@repo/pi-agent-ext-workflow", () => ({
	runWorkflowScript: async (opts: { name: string; outDir?: string; [k: string]: unknown }) => {
		if (capturing) {
			capturedOutDir = opts.outDir;
			capturedCallerModel = opts.callerModel;
			capturedEnvModel = opts.envModel;
			capturedPiDefaultModel = opts.piDefaultModel;
			return {
				meta: { name: "echo", description: "d" },
				result: { validated: true },
				logs: [],
				phases: [],
				agentCount: 0,
				durationMs: 0,
				scriptPath: "/x",
				source: "path",
				dryRun: true,
				model: fakeModel,
				modelSource: fakeModelSource,
			};
		}
		const real = await realModule();
		return real.runWorkflowScript(opts);
	},
	listWorkflows: async (...a: unknown[]) => {
		const real = await realModule();
		// Passthrough shim — forward varargs verbatim. Cast through any because
		// listWorkflows/findRepoRoot have specific positional types that unknown[]
		// can't satisfy structurally, and we don't want to duplicate their signatures.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (real.listWorkflows as any)(...a);
	},
	findRepoRoot: async (...a: unknown[]) => {
		const real = await realModule();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (real.findRepoRoot as any)(...a);
	},
}));

afterAll(() => {
	capturing = false;
	mock.restore();
});

describe("buildMainSpec — provider/model composition", () => {
	it("returns undefined when no model is set", () => {
		assert.equal(buildMainSpec(args({})), undefined);
	});
	it("keeps an already-qualified model (contains '/') verbatim", () => {
		assert.equal(buildMainSpec(args({ model: "lm-studio/google/gemma-4-12b" })), "lm-studio/google/gemma-4-12b");
	});
	it("prefixes provider when model has no '/'", () => {
		assert.equal(buildMainSpec(args({ model: "gemma-4-12b", provider: "lm-studio" })), "lm-studio/gemma-4-12b");
	});
	it("returns the bare model when provider is absent and model has no '/'", () => {
		assert.equal(buildMainSpec(args({ model: "gemma-4-12b" })), "gemma-4-12b");
	});
});

describe("parseWorkflowArgs — JSON parsing", () => {
	it("returns undefined for undefined / empty input", () => {
		assert.equal(parseWorkflowArgs(undefined), undefined);
		assert.equal(parseWorkflowArgs(""), undefined);
	});
	it("parses valid JSON", () => {
		assert.deepEqual(parseWorkflowArgs('{"a":1}'), { a: 1 });
	});
	it("throws a clear, prefixed error on bad JSON (not an opaque parse error)", () => {
		assert.throws(() => parseWorkflowArgs("{not json}"), /workflow: --args must be valid JSON/);
	});
});

describe("workflowRunCommand.run — --out-dir > PI_WORKFLOWS_OUT_DIR > default precedence (D4-1)", () => {
	const ENV_KEY = "PI_WORKFLOWS_OUT_DIR";

	/**
	 * Build a minimal ParsedArgs sufficient to drive workflowRunCommand.run() up
	 * to the runWorkflowScript call. positionals[0] is the workflow name; dryRun
	 * keeps the stub receipt shape; json:false exercises the non-JSON print path.
	 */
	function buildParsed(overrides: Partial<ParsedArgs>): ParsedArgs {
		return args({
			positionals: ["echo"],
			dryRun: true,
			...overrides,
		});
	}

	/** Snapshot + restore PI_WORKFLOWS_OUT_DIR around each case. */
	function withEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
		const prev = process.env[ENV_KEY];
		if (value === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = value;
		return fn().finally(() => {
			if (prev === undefined) delete process.env[ENV_KEY];
			else process.env[ENV_KEY] = prev;
		});
	}

	it("--out-dir flag wins over PI_WORKFLOWS_OUT_DIR env", async () => {
		await withEnv("/env/dir", async () => {
			capturedOutDir = NOT_CAPTURED_YET;
			capturing = true;
			try {
				await workflowRunCommand.run(buildParsed({ outDir: "/flag/dir" }));
				assert.equal(capturedOutDir, "/flag/dir", "flag value must override env");
			} finally {
				capturing = false;
			}
		});
	});

	it("PI_WORKFLOWS_OUT_DIR env is used when --out-dir is absent", async () => {
		await withEnv("/env/dir", async () => {
			capturedOutDir = NOT_CAPTURED_YET;
			capturing = true;
			try {
				await workflowRunCommand.run(buildParsed({ outDir: undefined }));
				assert.equal(capturedOutDir, "/env/dir", "env value must be forwarded");
			} finally {
				capturing = false;
			}
		});
	});

	it("undefined is forwarded when neither flag nor env is set (engine default applies downstream)", async () => {
		await withEnv(undefined, async () => {
			capturedOutDir = NOT_CAPTURED_YET;
			capturing = true;
			try {
				await workflowRunCommand.run(buildParsed({ outDir: undefined }));
				assert.equal(capturedOutDir, undefined, "absence must propagate as undefined");
			} finally {
				capturing = false;
			}
		});
	});
});

// ─── Task 3: pi-default model resolution + receipt rendering ───────────────
//
// `workflow.ts run()` must compute a pi-default model spec (provider/modelId)
// from resolveLLM({userDefaults: readUserDefaults()}) — with NO --model /
// PI_MODEL override — and forward three explicit inputs to the engine:
// callerModel (--model/--provider), envModel (PI_MODEL), piDefaultModel.
//
// Hermeticity for readUserDefaults: we point PI_CODING_AGENT_DIR at an empty
// temp dir (the same technique passthrough.test.ts uses), so no real
// ~/.pi/agent/settings.json is read. With empty settings + no PI_PROVIDER /
// PI_MODEL env, resolveLLM falls back to the hardcoded zai/glm-5.3 — giving a
// deterministic piDefaultModel without depending on the user's machine.
describe("workflowRunCommand.run — pi-default model + receipt (Task 3)", () => {
	const ENV_KEYS = ["PI_MODEL", "PI_PROVIDER", "PI_THINKING", "PI_CODING_AGENT_DIR"] as const;
	let saved: Record<string, string | undefined>;
	let agentDir: string;

	function withCleanEnv(fn: () => Promise<void>): Promise<void> {
		saved = {};
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		agentDir = mkdtempSync(join(tmpdir(), "wf-task3-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		return fn().finally(() => {
			for (const k of ENV_KEYS) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
			rmSync(agentDir, { recursive: true, force: true });
		});
	}

	function buildParsed(overrides: Partial<ParsedArgs>): ParsedArgs {
		return args({
			positionals: ["echo"],
			dryRun: true,
			...overrides,
		});
	}

	function resetCaptures(): void {
		capturedCallerModel = NOT_CAPTURED_YET;
		capturedEnvModel = NOT_CAPTURED_YET;
		capturedPiDefaultModel = NOT_CAPTURED_YET;
	}

	it("forwards callerModel=undefined + piDefaultModel=zai/glm-5.3 when no --model / no PI_MODEL", async () => {
		await withCleanEnv(async () => {
			resetCaptures();
			fakeModel = "zai/glm-5.3";
			fakeModelSource = "pi-default";
			capturing = true;
			try {
				await workflowRunCommand.run(buildParsed({ model: undefined }));
				assert.equal(capturedCallerModel, undefined, "callerModel must be undefined without --model");
				assert.equal(capturedEnvModel, undefined, "envModel must be undefined without PI_MODEL");
				assert.equal(
					capturedPiDefaultModel,
					"zai/glm-5.3",
					"piDefaultModel must resolve to the fallback spec",
				);
			} finally {
				capturing = false;
			}
		});
	});

	it("renders `model: <spec> [source]` in the text receipt", async () => {
		await withCleanEnv(async () => {
			resetCaptures();
			fakeModel = "zai/glm-5.3";
			fakeModelSource = "pi-default";
			capturing = true;
			const out: string[] = [];
			const origLog = console.log;
			console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
			try {
				await workflowRunCommand.run(buildParsed({ model: undefined }));
			} finally {
				console.log = origLog;
				capturing = false;
			}
			const line = out.find((l) => l.includes("✓"));
			assert.ok(line, "a receipt one-liner must be printed");
			assert.ok(
				line.includes("model: zai/glm-5.3 [pi-default]"),
				`receipt must include the model tag; got: ${line}`,
			);
		});
	});

	it("forwards callerModel=lm-studio/x when --model is given (rendered source --model)", async () => {
		await withCleanEnv(async () => {
			resetCaptures();
			fakeModel = "lm-studio/x";
			fakeModelSource = "--model";
			capturing = true;
			const out: string[] = [];
			const origLog = console.log;
			console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
			try {
				await workflowRunCommand.run(buildParsed({ model: "lm-studio/x" }));
			} finally {
				console.log = origLog;
				capturing = false;
			}
			assert.equal(capturedCallerModel, "lm-studio/x");
			assert.equal(capturedPiDefaultModel, "zai/glm-5.3", "piDefault is still computed");
			const line = out.find((l) => l.includes("✓"));
			assert.ok(line, "receipt printed");
			assert.ok(
				line.includes("model: lm-studio/x [--model]"),
				`receipt must reflect --model source; got: ${line}`,
			);
		});
	});

	it("forwards envModel when PI_MODEL is set and no --model given", async () => {
		await withCleanEnv(async () => {
			process.env.PI_MODEL = "env/spec";
			resetCaptures();
			fakeModel = "env/spec";
			fakeModelSource = "env";
			capturing = true;
			try {
				await workflowRunCommand.run(buildParsed({ model: undefined }));
				assert.equal(capturedEnvModel, "env/spec");
				assert.equal(capturedCallerModel, undefined);
			} finally {
				capturing = false;
			}
		});
	});

	it("renders no model tag when receipt.model is undefined (source none)", async () => {
		await withCleanEnv(async () => {
			resetCaptures();
			fakeModel = undefined;
			fakeModelSource = "none";
			capturing = true;
			const out: string[] = [];
			const origLog = console.log;
			console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
			try {
				await workflowRunCommand.run(buildParsed({ model: undefined }));
			} finally {
				console.log = origLog;
				capturing = false;
			}
			const line = out.find((l) => l.includes("✓"));
			assert.ok(line, "receipt printed");
			assert.ok(
				!line.includes("model:"),
				`no model tag when model is undefined; got: ${line}`,
			);
		});
	});
});
