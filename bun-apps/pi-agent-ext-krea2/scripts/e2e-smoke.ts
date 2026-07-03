/**
 * e2e-smoke.ts — drive runKrea2() directly (the pure core the tool wraps) for a
 * real t2i → i2i round-trip. No LLM, no agent runtime — exercises binary
 * resolution + metallib staging + path validation + spawn + result parsing.
 *
 *   bun scripts/e2e-smoke.ts
 */
import { runKrea2, PathSafetyError } from "../src/index.ts";

const OUT = "/tmp/krea2_pi_e2e";

async function main() {
  console.log("=== krea2 t2i (native) ===");
  const t2i = await runKrea2({
    command: "t2i",
    options: {
      prompt: "a red apple on a wooden table, studio lighting, photorealistic",
      width: 1024,
      height: 1024,
      steps: 8,
      seed: 42,
      out: `${OUT}/t2i_apple.png`,
    },
    outputDir: OUT,
    onProgress: (u) => console.log(`  … ${u.text}`),
  });
  console.log("summary:", t2i.summary);
  console.log("details.output:", t2i.details.output);
  console.log("details.ok:", t2i.details.ok);
  if (!t2i.details.ok || !t2i.details.output) {
    console.error("FAIL: t2i did not produce an output");
    process.exit(1);
  }

  console.log("\n=== krea2 i2i (native, strength 0.9) chaining on t2i output ===");
  const i2i = await runKrea2({
    command: "i2i",
    options: {
      input: t2i.details.output,
      prompt: "a green apple on a white marble table, bright sunlight",
      strength: 0.9,
      seed: 7,
      out: `${OUT}/i2i_green.png`,
    },
    outputDir: OUT,
    onProgress: (u) => console.log(`  … ${u.text}`),
  });
  console.log("summary:", i2i.summary);
  console.log("details.output:", i2i.details.output);
  if (!i2i.details.ok || !i2i.details.output) {
    console.error("FAIL: i2i did not produce an output");
    process.exit(1);
  }

  console.log("\n=== path-safety guard (should reject) ===");
  try {
    await runKrea2({
      command: "i2i",
      options: { input: "/etc/passwd", prompt: "x" },
      outputDir: OUT,
    });
    console.error("FAIL: /etc/passwd was NOT rejected");
    process.exit(1);
  } catch (err) {
    if (err instanceof PathSafetyError) {
      console.log("  ✓ rejected outside-root input:", err.message.split("\n")[0]);
    } else {
      throw err;
    }
  }

  console.log("\n=== ALL E2E CHECKS PASSED ===");
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(1);
});
