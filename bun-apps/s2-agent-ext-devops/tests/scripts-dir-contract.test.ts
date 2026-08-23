/**
 * scripts-dir contract — every .ts/.mjs directly under a s2-agent package's
 * scripts/ dir is a RUNNABLE entry; libraries live in src/ (or scripts/lib/).
 *
 * Why: a pure-library .ts in scripts/ exits 0 silently when run —
 * `bun scripts/deploy.ts` used to do exactly that, looking like a successful
 * deploy while doing nothing. scripts/ is advertised to agents as
 * "verification + smoke entry points" (.claude/skills/using-s2-agent-skills),
 * so anything non-runnable there is a trap.
 *
 * This is a SNAPSHOT allowlist: adding a runnable entry to scripts/ requires
 * adding its path here (one line, deliberate). A library file added to
 * scripts/ fails with no allowlist escape — put it in src/ or scripts/lib/.
 * *.test.* anywhere under scripts/ and the scripts/lib/ subtree are exempt.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const BUN_APPS_DIR = join(import.meta.dir, "..", "..");

/** Allowed runnable entries, repo-relative. Sorted. Extend deliberately. */
const ALLOWED_RUNNABLE_ENTRIES = new Set([
	"bun-apps/s2-agent-ext-archify/scripts/deck.ts",
	"bun-apps/s2-agent-ext-archify/scripts/mermaid-convert.ts",
	"bun-apps/s2-agent-ext-archify/scripts/vendor-mermaid.ts",
	"bun-apps/s2-agent-ext-compact/scripts/ab.ts",
	"bun-apps/s2-agent-ext-file2md/scripts/build-bundle.ts",
	"bun-apps/s2-agent-ext-flux2/scripts/build-bundle.ts",
	"bun-apps/s2-agent-ext-flux2/scripts/check-flags.ts",
	"bun-apps/s2-agent-ext-flux2/scripts/self-improve-loop.driver.ts",
	"bun-apps/s2-agent-ext-hermes-memory/scripts/pi-memory-merge.mjs",
	"bun-apps/s2-agent-ext-hermes-memory/scripts/db-transfer.ts",
	"bun-apps/s2-agent-ext-knowledge-card/scripts/backfill-summaries.mjs",
	"bun-apps/s2-agent-ext-knowledge-card/scripts/kcard-coverage-measure.mjs",
	"bun-apps/s2-agent-ext-krea2/scripts/build-bundle.ts",
	"bun-apps/s2-agent-ext-krea2/scripts/check-flags.ts",
	"bun-apps/s2-agent-ext-krea2/scripts/e2e-smoke.ts",
	"bun-apps/s2-agent-ext-ltx/scripts/build-bundle.ts",
	"bun-apps/s2-agent-ext-ltx/scripts/check-flags.ts",
	"bun-apps/s2-agent-ext-ltx/scripts/e2e-smoke.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/caption-e2e-smoke.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/compare-ltx-native-voice.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/headline-proof.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/phase-c-fullchain.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/probe-zoompan-lanczos.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/prove-agent-routing.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/prove-remotion-overlay.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/run-captions-drawtext-smoke.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/run-clip-e2e.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/run-compose-motion-e2e.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/run-h-real.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/run-real-e2e-neuralnet-failure.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/run-real-e2e-neuralnet-v4-motion.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/run-real-e2e-neuralnet.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/run-upscale-e2e.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/run-whisper-e2e.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/runpy-image-e2e-smoke.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/smoke-e2e-pipeline.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/smoke-remotion.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/validate-data.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/verify-tool-caption.ts",
	"bun-apps/s2-agent-ext-movie-director/scripts/verify-tool-video.ts",
	"bun-apps/s2-agent-ext-obsidian/scripts/backfill-zettel-frontmatter.mjs",
	"bun-apps/s2-agent-ext-obsidian/scripts/bench-index-persistence.mjs",
	"bun-apps/s2-agent-ext-obsidian/scripts/bench-trigram-search.mjs",
	"bun-apps/s2-agent-ext-obsidian/scripts/measure-schema-tokens.mjs",
	"bun-apps/s2-agent-ext-obsidian/scripts/validate-real-vault.mjs",
	"bun-apps/s2-agent-ext-devops/scripts/ci-local.ts",
	"bun-apps/s2-agent-ext-devops/scripts/run-test.ts",
	"bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts",
	"bun-apps/s2-agent-ext-subagent/scripts/runs-stats.ts",
	"bun-apps/s2-agent-ext-superpowers/scripts/update-superpowers.ts",
	"bun-apps/s2-agent-ext-superpowers/scripts/rebaseline-upstream-skills.ts",
	"bun-apps/s2-agent-ext-superpowers/scripts/update-superpowers.ts",
	"bun-apps/s2-agent-ext-wayfind/scripts/probe-ext.ts",
	"bun-apps/s2-agent-ext-wayfind/scripts/sweep-zero-citation.ts",
	"bun-apps/s2-agent/scripts/regen-manifest.ts",
	"bun-apps/s2-agent/scripts/regen-static-extensions.ts",
	"bun-apps/s2-agent/scripts/scrub-session-env.preload.ts",
]);

function topLevelScriptEntries(): string[] {
	const out: string[] = [];
	for (const pkg of readdirSync(BUN_APPS_DIR)) {
		if (!pkg.startsWith("s2-agent")) continue;
		const scriptsDir = join(BUN_APPS_DIR, pkg, "scripts");
		let entries: string[];
		try {
			entries = readdirSync(scriptsDir);
		} catch {
			continue; // package has no scripts/ dir
		}
		for (const name of entries) {
			// Top level only — scripts/lib/** and *.test.* are exempt by contract.
			// .sh needs no guard: a shell file with no shebang still errors loudly.
			if (!(name.endsWith(".ts") || name.endsWith(".mjs")) || name.includes(".test.")) continue;
			out.push(`bun-apps/${pkg}/scripts/${name}`);
		}
	}
	return out.sort();
}

describe("scripts/ holds only runnable entries", () => {
	test("every top-level scripts/*.ts is on the runnable allowlist", () => {
		const found = topLevelScriptEntries();
		const undeclared = found.filter((p) => !ALLOWED_RUNNABLE_ENTRIES.has(p));
		const stale = [...ALLOWED_RUNNABLE_ENTRIES].filter((p) => !found.includes(p));
		if (undeclared.length > 0 || stale.length > 0) {
			throw new Error(
				[
					undeclared.length > 0
						? `Undeclared scripts/*.ts (if it is a RUNNABLE entry, add it to ALLOWED_RUNNABLE_ENTRIES in this test; if it is a LIBRARY, move it to src/ or scripts/lib/ — a library in scripts/ exits 0 silently when run):\n  ${undeclared.join("\n  ")}`
						: "",
					stale.length > 0
						? `Allowlist entries that no longer exist (delete them):\n  ${stale.join("\n  ")}`
						: "",
				]
					.filter(Boolean)
					.join("\n"),
			);
		}
		expect(found.length).toBe(ALLOWED_RUNNABLE_ENTRIES.size);
	});
});
