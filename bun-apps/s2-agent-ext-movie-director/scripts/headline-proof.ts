/**
 * headline-proof.ts — Phase B: prove the frozen-frame fix on REAL GPU.
 *
 * Pre-supplies the 4 creative artifacts (research_brief/proposal_packet/script/
 * scene_plan) so the driver skips the LLM waypoints and drives straight to the
 * assets stage on real MLX (T2I2V), then PAUSES at `edit` (requireHumanApproval).
 * The scene_plan has a 4s scene (single clip) + a 10s scene (>8s → chained into
 * 8s + 2s with the last-frame continuation). Fully LLM-free.
 *
 * Run: MLX_VENV_PYTHON=<ltx venv python> bun scripts/headline-proof.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../src/dispatch.ts";

// Reuse the compatible MLX venv from the __ltx worktree (no fresh install).
process.env.MLX_VENV_PYTHON ??= "/Users/huangziyu/proj/video_generation__ltx/python/venv/bin/python";

const fixtureDir = join(import.meta.dir, "..", "data", "fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));

const projectId = "headline-rainbows-form";
const t0 = Date.now();
const res = await dispatch("run-pipeline", {
	projectId,
	topic: "how rainbows form",
	pipeline: "animated-explainer",
	requireHumanApproval: "edit", // pause AFTER assets (LLM-free proof)
	preSuppliedArtifacts: {
		research_brief: load("research_brief"),
		proposal_packet: load("proposal_packet"),
		script: load("script"),
		scene_plan: load("scene_plan"),
	},
});
const dt = ((Date.now() - t0) / 1000).toFixed(0);
if (!res.ok) {
	console.error(`FAILED after ${dt}s: ${res.error}`);
	process.exit(1);
}
const result = JSON.parse(res.text);
console.log(`=== headline-proof completed in ${dt}s ===`);
console.log("status:", result.status, "| stage:", result.stage);
console.log("completed:", JSON.stringify(result.completedStages ?? result.stages));
