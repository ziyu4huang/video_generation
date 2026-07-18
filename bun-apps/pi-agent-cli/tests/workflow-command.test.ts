import { describe, it, mock, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { buildMainSpec, parseWorkflowArgs, workflowRunCommand } from "../src/commands/workflow.ts";
import type { ParsedArgs } from "../src/args.ts";

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
// stub leaks into sibling test files (notably src/__tests__/workflow-retrieval-
// quality.test.ts, which imports the real runWorkflowScript and would receive
// our fake receipt). To stay hermetic, the stub is a TRANSPARENT PASSTHROUGH by
// default: when `capturing` is false, every call is forwarded to the REAL module
// loaded by source path (bypassing the package-name mock). Only when a test sets
// `capturing = true` does runWorkflowScript short-circuit with a fake receipt
// and record `outDir`. Sibling files never toggle capturing, so they see the
// real implementation regardless of mock leakage.
const NOT_CAPTURED_YET = Symbol("not-captured");
let capturedOutDir: unknown = NOT_CAPTURED_YET;
let capturing = false;

// Direct source import bypasses the `@repo/pi-agent-ext-workflow` package-name
// mock (the source uses relative internal imports, so Bun never routes back
// through the mocked specifier).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realModulePromise: Promise<any> | null = null;
function realModule(): Promise<typeof import("@repo/pi-agent-ext-workflow")> {
	if (!realModulePromise) {
		realModulePromise = import("../../pi-agent-ext-workflow/src/index.ts");
	}
	return realModulePromise;
}

mock.module("@repo/pi-agent-ext-workflow", () => ({
	runWorkflowScript: async (opts: { name: string; outDir?: string; [k: string]: unknown }) => {
		if (capturing) {
			capturedOutDir = opts.outDir;
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
		assert.equal(buildMainSpec(args({ model: "lm-studio/google/gemma-4-26b-a4b-qat" })), "lm-studio/google/gemma-4-26b-a4b-qat");
	});
	it("prefixes provider when model has no '/'", () => {
		assert.equal(buildMainSpec(args({ model: "gemma-4-26b", provider: "lm-studio" })), "lm-studio/gemma-4-26b");
	});
	it("returns the bare model when provider is absent and model has no '/'", () => {
		assert.equal(buildMainSpec(args({ model: "gemma-4-26b" })), "gemma-4-26b");
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
