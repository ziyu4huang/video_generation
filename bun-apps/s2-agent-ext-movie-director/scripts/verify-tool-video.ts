/**
 * verify-tool-video.ts — deterministic proof that the `movie` TOOL produces a
 * real video via the same dispatch path the agent's `movie generate` lands on.
 * Zero LLM: calls dispatch("generate", {video_generation, native-i2v}) directly.
 *
 * Run: MLX_MODELS_DIR=$(pwd)/mlx-models \
 *      bun bun-apps/s2-agent-ext-movie-director/scripts/verify-tool-video.ts
 */
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { dispatch } from "../src/dispatch.ts";

// sandbox requires output under repo root or its parent — use the external
// models-output sibling store (repo parent).
const outDir = mkdtempSync(resolve(process.env.HOME!, "proj/video_generation__output/movie-tool-video-"));
console.log("outputDir:", outDir);

const t0 = Date.now();
const res = await dispatch(
  "generate",
  {
    capability: "video_generation",
    command: "native-i2v",
    options: { prompt: "a vivid rainbow over a green field after rain, gentle wind, cinematic", seconds: 1 },
    outputDir: outDir,
  },
);
const dt = ((Date.now() - t0) / 1000).toFixed(1);

console.log("ok:", res.ok, `(dispatch ${dt}s)`);
if (!res.ok) {
  console.error("FAILED:", res.error);
  process.exit(1);
}
// Narrowed to the ok:true variant of DispatchResult here.
console.log("text:", res.text.slice(0, 600));
