/**
 * verify-tool-caption.ts — deterministic proof that the `movie` TOOL captions a real
 * image via the Bun-native path (dispatch → caption_native.ts → LM Studio VLM), zero
 * run.py. Exercises a newly-ported style (photography) + a templated style (review).
 *
 * Run: bun bun-apps/s2-agent-ext-movie-director/scripts/verify-tool-caption.ts <image.png> [prompt]
 */
import { dispatch } from "../src/dispatch.ts";
import { readFileSync } from "node:fs";

const image = process.argv[2];
const prompt = process.argv[3] ?? "a vivid rainbow over a green field";
if (!image) {
  console.error("usage: verify-tool-caption.ts <image.png> [review-prompt]");
  process.exit(1);
}

console.log("image:", image, "| review prompt:", prompt);

// 1. A simple newly-ported style (photography) — no placeholder, no python.
const t1 = Date.now();
const photo = await dispatch("generate", {
  capability: "analysis",
  command: "caption",
  options: { image, style: "photography", lang: "en" },
});
console.log(`\n[photography] ok=${photo.ok} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
if (!photo.ok) {
  console.error("FAILED:", photo.error);
  process.exit(1);
}
const photoPath = image.replace(/\.[^.]+$/, ".caption.json");
const photoSaved = JSON.parse(readFileSync(photoPath, "utf8"));
console.log("  caption:", String(photoSaved.styles.photography.caption).slice(0, 200));

// 2. A templated style (review needs --prompt).
const t2 = Date.now();
const review = await dispatch("generate", {
  capability: "analysis",
  command: "caption",
  options: { image, style: "review", prompt, lang: "en" },
});
console.log(`\n[review] ok=${review.ok} (${((Date.now() - t2) / 1000).toFixed(1)}s)`);
if (!review.ok) {
  console.error("FAILED:", review.error);
  process.exit(1);
}
const reviewSaved = JSON.parse(readFileSync(photoPath, "utf8"));
const reviewCaption = reviewSaved.styles.review.caption;
console.log("  prompt_adherence:", JSON.parse(reviewCaption).prompt_adherence);

console.log("\n✓ caption Bun-native path works end-to-end (zero run.py) — both styles wrote", photoPath);
