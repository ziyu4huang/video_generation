/**
 * phase-c-fullchain.ts — Phase C: deterministic edit → compose → publish.
 *
 * Pre-supplies ALL artifacts through asset_manifest (reusing the real GPU clips
 * from the Phase B run), so no MLX/LLM is needed: the driver runs edit
 * (deterministic — probes each clip's real duration), compose-motion (ffmpeg),
 * and publish (final-review) → a real final.mp4.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../src/dispatch.ts";

const fixtureDir = join(import.meta.dir, "..", "data", "fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));

const projectId = "headline-rainbows-fc4";
const t0 = Date.now();
const res = await dispatch("run-pipeline", {
	projectId,
	topic: "how rainbows form",
	pipeline: "animated-explainer",
	preSuppliedArtifacts: {
		research_brief: load("research_brief"),
		proposal_packet: load("proposal_packet"),
		script: load("script"),
		scene_plan: load("scene_plan"),
		asset_manifest: load("asset_manifest"),
	},
});
const dt = ((Date.now() - t0) / 1000).toFixed(0);
if (!res.ok) {
	console.error(`FAILED after ${dt}s: ${res.error}`);
	process.exit(1);
}
const result = JSON.parse(res.text);
console.log(`=== phase-c fullchain completed in ${dt}s ===`);
console.log("status:", result.status);
console.log("stages:", JSON.stringify(result.completedStages ?? result.stages));
