/**
 * Regression test: the sh entry must pass the default-model-env splice to
 * main() — sh mode's built-in default model (zai/glm-5.3) has to actually
 * REACH pi.
 *
 * THE BUG THIS LOCKS OUT (2026-08-20): cli-sh.ts sliced `process.argv` into
 * `argv` at module top (before applyPatches()), then built `mainArgv` from
 * that stale copy. The default-model-env patch splices
 * `--model glm-5.3 --provider zai --thinking high` into process.argv at
 * import time DURING applyPatches() — after the copy was taken — and main()
 * consumes only the array it is handed (it does not re-read process.argv;
 * src/cli.ts documents the same trap at its own main() call). Net effect:
 * every sh deploy silently dropped the built-in default, and pi's
 * findInitialModel() provider-order fallback (deepseek precedes zai in
 * defaultModelPerProvider) picked deepseek instead.
 *
 * HOW THIS IS TESTED: a subprocess runs the REAL src/cli-sh.ts under
 * `bun --preload <stub>`, where the stub mock.modules
 * @earendil-works/pi-coding-agent so main() records the argv it received and
 * exits. Every patch except default-model-env is disabled via its env gate
 * (derived from PATCH_TABLE, so new patches stay isolated here too), and
 * PI_CODING_AGENT_DIR / PI_AGENT_SH_EXT_DIR point at throwaway dirs — no
 * ~/.pi state, no network, no model call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATCH_TABLE } from "../patches/index.ts";
import { BUILTIN_MODEL_DEFAULT } from "../pre-load-providers.ts";

const PKG_ROOT = join(import.meta.dir, "..", "..");

/** Preload stub: mock pi's main() to capture the argv it receives. */
const STUB = `
import { mock } from "bun:test";
import * as real from "@earendil-works/pi-coding-agent";
mock.module("@earendil-works/pi-coding-agent", () => ({
	...real,
	main: async (args: string[]) => {
		await Bun.write(process.env.CAPTURE!, JSON.stringify(args));
	},
}));
`;

interface RunResult {
	exitCode: number;
	argv: string[];
	stderr: string;
}

/**
 * Run src/cli-sh.ts in a subprocess with the mocked main. Patch gates are
 * derived from PATCH_TABLE: everything OFF except the named keep-list.
 */
async function runCliSh(
	userArgs: string[],
	opts: { settings?: Record<string, unknown>; keepPatches?: string[] } = {},
): Promise<RunResult> {
	const tmp = mkdtempSync(join(tmpdir(), "cli-sh-argv-"));
	const capture = join(tmp, "cap.json");
	const stubPath = join(tmp, "stub.ts");
	const piHome = join(tmp, "pi-home");
	const extRoot = join(tmp, "ext");
	writeFileSync(stubPath, STUB);
	mkdirSync(piHome, { recursive: true });
	mkdirSync(extRoot, { recursive: true });
	if (opts.settings) {
		writeFileSync(join(piHome, "settings.json"), JSON.stringify(opts.settings));
	}

	const keep = new Set(opts.keepPatches ?? ["default-model-env"]);
	const env: Record<string, string> = {
		// Isolated harness: no ~/.pi state, no repo run-dir, throwaway HOME.
		PI_CODING_AGENT_DIR: piHome,
		PI_AGENT_SH_EXT_DIR: extRoot,
		HOME: tmp,
		CAPTURE: capture,
		// sh mode disables run-dir resolution by default; pin it so the test
		// does not depend on the `??=` in cli-sh.ts.
		BUN_PI_LOAD_RUN_DIR: "0",
	};
	for (const p of PATCH_TABLE) {
		env[p.env] = keep.has(p.name) ? "1" : "0";
	}

	const proc = Bun.spawn([process.execPath, "--preload", stubPath, join(PKG_ROOT, "src", "cli-sh.ts"), ...userArgs], {
		env,
		stdout: "pipe",
		stderr: "pipe",
		cwd: PKG_ROOT,
	});
	const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

	let argv: string[] = [];
	try {
		argv = JSON.parse(await Bun.file(capture).text()) as string[];
	} catch {
		// main() never ran — leave argv empty so the assertions fail with the
		// subprocess stderr attached.
	}
	return { exitCode: proc.exitCode ?? -1, argv, stderr };
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

describe("cli-sh main() argv — default-model-env splice must reach pi", () => {
	test("built-in default (zai/glm-5.3) is spliced into the argv main() receives", async () => {
		const r = await runCliSh(["--print", "hi"]);
		expect(r.stderr).toBe("");
		const i = r.argv.indexOf("--model");
		expect(i).toBeGreaterThanOrEqual(0);
		expect(r.argv[i + 1]).toBe(BUILTIN_MODEL_DEFAULT.model);
		const p = r.argv.indexOf("--provider");
		expect(r.argv[p + 1]).toBe(BUILTIN_MODEL_DEFAULT.provider);
		const t = r.argv.indexOf("--thinking");
		expect(r.argv[t + 1]).toBe(BUILTIN_MODEL_DEFAULT.thinking);
		// User args survive alongside the splice.
		expect(r.argv).toContain("--print");
		expect(r.argv).toContain("hi");
	});

	test("fill-gaps: personal defaults in settings.json suppress the splice (per flag)", async () => {
		// Per-bridge fill-gaps: only the flags whose settings key is present are
		// suppressed. A full personal default (all three keys) suppresses all
		// three splices; a partial one (defaultModel only) suppresses --model
		// but still splices --provider/--thinking — same semantics as the
		// cli.ts path.
		const full = await runCliSh(["--print", "hi"], {
			settings: {
				defaultModel: "deepseek/deepseek-v4-flash",
				defaultProvider: "deepseek",
				defaultThinkingLevel: "high",
			},
		});
		expect(full.stderr).toBe("");
		expect(full.argv).not.toContain("--model");
		expect(full.argv).not.toContain("--provider");
		expect(full.argv).not.toContain("--thinking");
		expect(full.argv).toContain("--print");

		const partial = await runCliSh(["--print", "hi"], { settings: { defaultModel: "deepseek/deepseek-v4-flash" } });
		expect(partial.stderr).toBe("");
		expect(partial.argv).not.toContain("--model");
		expect(partial.argv).toContain("--provider");
		expect(partial.argv).toContain("--thinking");
	});

	test("an explicit --model flag on the command line wins over the built-in", async () => {
		const r = await runCliSh(["--print", "hi", "--model", "deepseek/deepseek-v4-flash"]);
		expect(r.stderr).toBe("");
		// Exactly one --model, and it is the user's.
		const hits = r.argv.filter((a) => a === "--model");
		expect(hits.length).toBe(1);
		expect(r.argv[r.argv.indexOf("--model") + 1]).toBe("deepseek/deepseek-v4-flash");
	});
});
