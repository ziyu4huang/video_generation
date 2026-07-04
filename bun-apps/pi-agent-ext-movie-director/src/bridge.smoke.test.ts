/**
 * bridge.smoke.test.ts — REAL-SILICON wiring proof.
 *
 * Default-skipped (no spawn in CI / unit runs). Set MLX_SMOKE=1 to run a real
 * krea2 t2i generation through the full selector → adapter → director path and
 * assert the bridge actually produces a file. This is the iteration-2 wiring
 * proof demanded by the goal; re-run after any bridge/registry change.
 *
 *   MLX_SMOKE=1 bun test src/bridge.smoke.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { selectAndGenerate } from "./bridge.ts";

const SMOKE = process.env.MLX_SMOKE === "1";

describe.skipIf(!SMOKE)("bridge real-silicon smoke (MLX_SMOKE=1)", () => {
  test("selectAndGenerate image_generation:t2i produces a real PNG via krea2", async () => {
    const { entry, result } = await selectAndGenerate(
      "image_generation",
      {
        command: "t2i",
        options: {
          prompt: "a single red apple on a white table, product photo",
          width: 512,
          height: 512,
          steps: 4,
          seed: 7,
        },
      },
      {},
    );

    expect(entry.provider).toBe("krea2");
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.artifacts.length).toBeGreaterThanOrEqual(1);

    const art = result.artifacts[0]!;
    expect(art.kind).toBe("image");
    expect(art.path).toBeTruthy();
    expect(existsSync(art.path)).toBe(true);
    expect(statSync(art.path).size).toBeGreaterThan(1000);
    expect(result.seed).toBe(7);
    expect(result.duration_seconds).not.toBeNull();
    expect(result.duration_seconds!).toBeGreaterThan(0);
  }, 120_000);
});
