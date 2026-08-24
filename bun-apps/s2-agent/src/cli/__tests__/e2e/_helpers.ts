/**
 * Offline subprocess e2e harness for s2-agent's non-interactive CLI.
 *
 * Spawns `bun src/cli.ts cli <args>` in the package dir with a hermetic env and
 * returns { exitCode, stdout, stderr }. Mirrors boot-smoke's `runCanary()`
 * pattern but generalised for the whole dispatch / error / exit-code surface.
 *
 * Hermeticity: PI_SKIP_MODELS_JSON=1 is set to shrink the model registry. The
 * tested surface (meta / dispatch-errors / arg-validation) short-circuits
 * BEFORE any model call, so no API key / LM Studio is needed and no network is
 * touched. Model-dependent paths (chat/agent/passthrough/zk-* happy paths) are
 * deliberately NOT tested here — they belong to the live verify workflow.
 *
 * NOTE: do NOT use this to drive a bare unknown command — that falls through to
 * passthrough and would need a model (risk of hang). Test only the reserved-
 * namespace error paths that `die()` before any model resolution.
 */
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnCaptureSync } from "../../../__tests__/test-utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// _helpers.ts lives at <pkg>/src/cli/__tests__/e2e/ → up FOUR levels to pkg root.
const pkgDir = join(__dirname, "..", "..", "..", "..");

/**
 * The version `cli version` must print — read from package.json (the file
 * version-bump-cli.ts edits), never a hardcoded literal: a literal pin goes
 * stale the moment the version is bumped and turns every bump into a test
 * chase. dispatch.ts's VERSION const is kept in lockstep by the same tool.
 */
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string };
export const VERSION: string = pkg.version;


export interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Run the CLI in source mode with the given argv. Extra env entries overlay
 * process.env (PI_SKIP_MODELS_JSON=1 and BUN_PI_HERMES_MEMORY=0 are always
 * set); pass `undefined` to unset.
 */
export function runCli(
	args: string[],
	opts: { env?: Record<string, string | undefined> } = {},
): CliResult {
	// The CLI is reached through s2-agent's own entry under the `cli`
	// namespace token — there is no standalone s2-agent-cli binary any more.
	// BUN_PI_HERMES_MEMORY=0: the tested surface (meta / dispatch-errors /
	// arg-validation / exit codes) never touches the memory layer, but every
	// boot would otherwise pay hermes-memory's startup syncMarkdownMemories
	// against surrealdb — measured 5.6 s COLD per boot (2026-08-23), ~34
	// boots across these files. boot-smoke.test.ts is the test that asserts
	// hermes actually loads; it spawns its own boots with hermes ON.
	return spawnCaptureSync([process.execPath, "src/cli.ts", "cli", ...args], {
		cwd: pkgDir,
		env: { ...process.env, PI_SKIP_MODELS_JSON: "1", BUN_PI_HERMES_MEMORY: "0", ...opts.env },
	});
}
