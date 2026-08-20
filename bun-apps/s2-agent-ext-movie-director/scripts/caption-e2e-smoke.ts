// Real e2e: drive `movie generate {analysis, caption}` through the bridge.
// Run: MLX_E2E=1 bun run bun-apps/s2-agent-ext-movie-director/scripts/caption-e2e-smoke.ts <img>
import { selectAndGenerate } from "../src/bridge.ts";

const img = process.argv[2] ?? "../video_generation__output/ab_klein.png";
const { entry, result } = await selectAndGenerate(
  "analysis",
  { command: "caption", options: { image: img, style: "score", lang: "en" } },
  { command: "caption" },
);
console.log("entry:", entry.name, "| invoke:", entry.invoke);
console.log("success:", result.success, "| provider:", result.provider, "| model:", result.model);
console.log("artifacts:", JSON.stringify(result.artifacts));
console.log("cost_usd:", result.cost_usd);
if (result.error) console.log("error:", result.error);
