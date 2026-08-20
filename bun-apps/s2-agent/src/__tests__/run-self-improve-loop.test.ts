import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "run-self-improve-loop.sh");

function dryRunArgs(promptText: string): unknown {
	const proc = spawnSync("bash", [SCRIPT, "--prompt", promptText, "--dry-run"], { encoding: "utf8" });
	expect(proc.status).toBe(0);
	const argsLine = proc.stdout.split("\n").find((l) => l.startsWith("   args:   "));
	expect(argsLine).toBeDefined();
	const jsonText = argsLine!.slice("   args:   ".length);
	return JSON.parse(jsonText);
}

// Spawns `bash` as a real subprocess (portability P2: host-binary probe — see
// .github/TEST-PORTABILITY.md). --dry-run is offline/pure (flag-parsing + jq
// JSON construction, no GPU/model calls), and bash+jq are always present on
// GitHub-hosted ubuntu-latest runners, but this repo's convention gates every
// P2 spawn hit behind process.env.CI regardless — run locally to exercise it.
describe.skipIf(!!process.env.CI)("run-self-improve-loop.sh --dry-run", () => {
	test("a plain prompt round-trips", () => {
		const parsed = dryRunArgs("a red apple") as { prompts: string[] };
		expect(parsed.prompts).toEqual(["a red apple"]);
	});

	test("a prompt containing double quotes produces valid JSON", () => {
		const parsed = dryRunArgs('a "red" apple') as { prompts: string[] };
		expect(parsed.prompts).toEqual(['a "red" apple']);
	});

	test("a prompt containing a backslash produces valid JSON", () => {
		const parsed = dryRunArgs("a\\red apple") as { prompts: string[] };
		expect(parsed.prompts).toEqual(["a\\red apple"]);
	});
});
