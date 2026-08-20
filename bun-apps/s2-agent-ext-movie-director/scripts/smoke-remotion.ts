/**
 * smoke-remotion.ts — real-silicon end-to-end proof for the Remotion compose tier.
 *
 * Not a unit test (needs `bun install` in remotion/ + a headless browser). Run:
 *
 *   bun bun-apps/s2-agent-ext-movie-director/scripts/smoke-remotion.ts
 *
 * Generates two test PNGs + a sine-wave narration via ffmpeg, builds an
 * edit_decisions with ken-burns + crossfade + a section_title overlay, runs
 * `renderRemotion()` with the REAL spawn (no mock), then `finalReview()` on the
 * output. Exits 0 only if a real .mp4 is produced and passes the delivery gate.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { renderRemotion, finalReview, type RemotionEditDecisions } from "../src/index.ts";

function run(cmd: string, argv: string[]): Promise<number> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", () => {});
    p.stderr.on("data", () => {});
    p.on("error", () => res(-1));
    p.on("exit", (c) => res(c ?? -1));
  });
}

async function main() {
  if (!process.env.REMOTION_SMOKE) {
    console.log("set REMOTION_SMOKE=1 to run this real-silicon smoke (needs remotion/ install + browser)");
    process.exit(0);
  }
  const dir = mkdtempSync(join(tmpdir(), "md-rmx-smoke-"));
  console.log("workdir:", dir);
  try {
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    const narration = join(dir, "narration.mp3");
    const ga = await run("ffmpeg", ["-f", "lavfi", "-i", "color=c=0x224488:s=1920x1080:d=1", "-frames:v", "1", "-y", a]);
    const gb = await run("ffmpeg", ["-f", "lavfi", "-i", "color=c=0x884422:s=1920x1080:d=1", "-frames:v", "1", "-y", b]);
    const gn = await run("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=330:duration=4", "-y", narration]);
    if (ga !== 0 || gb !== 0 || gn !== 0 || !existsSync(a) || !existsSync(b) || !existsSync(narration)) {
      console.error("fixture gen failed");
      process.exit(2);
    }

    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [
        { id: "a", source: a, in_seconds: 0, out_seconds: 2, animation: "ken-burns" },
        { id: "b", source: b, in_seconds: 2, out_seconds: 4, animation: "zoom-in" },
      ],
      overlays: [{ type: "section_title", in_seconds: 0.5, out_seconds: 2.5, text: "Smoke Test", subtitle: "Remotion compose" }],
      audio: { narration: { src: narration, volume: 0.8 } },
      transition: "crossfade",
      transitionSeconds: 0.5,
      theme: "dark",
    };

    const out = join(dir, "smoke.mp4");
    console.log("rendering via Remotion…");
    const t0 = Date.now();
    const report = await renderRemotion(edit, { workDir: dir, output: out, width: 1280, height: 720, fps: 30 });
    console.log(`render took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(JSON.stringify(report, null, 2));
    if (report.outputs.length !== 1 || !existsSync(out)) {
      console.error("FAIL: no output produced");
      process.exit(3);
    }
    console.log("output size bytes:", statSync(out).size);

    const review = await finalReview(out);
    console.log("final_review verdict:", review.verdict);
    console.log(JSON.stringify(review.checks, null, 2));
    process.exit(review.verdict === "pass" ? 0 : 4);
  } finally {
    if (process.env.KEEP_SMOKE_DIR) console.log("keeping", dir);
    else rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
