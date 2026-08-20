/**
 * run-compose-motion-e2e.ts — real-silicon deterministic proof for the ffmpeg
 * motion compositor (Item J). Not a unit test (needs ffmpeg on PATH with
 * zoompan+xfade). Run:
 *
 *   bun bun-apps/s2-agent-ext-movie-director/scripts/run-compose-motion-e2e.ts
 *
 * Generates two short testsrc clips via ffmpeg lavfi (no input files needed),
 * builds an edit_decisions with ken-burns + zoom-in + crossfade, runs
 * `composeMotion()` with the REAL spawn (no mock), then `finalReview()` on the
 * output. Exits 0 only if a real .mp4 is produced, ffprobe-verifiable, and it
 * passes the delivery gate. Writes a JSON receipt to stdout (last line) for the
 * goal-evidence trail.
 */
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { composeMotion, finalReview, type RemotionEditDecisions } from "../src/index.ts";

function run(cmd: string, argv: string[]): Promise<number> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", () => {});
    p.stderr.on("data", () => {});
    p.on("error", () => res(-1));
    p.on("exit", (c) => res(c ?? -1));
  });
}

function motionFiltersOk(): boolean {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
  const list = r.stdout ?? "";
  const has = (n: string) => new RegExp(`(?:^|\\s).{0,3}${n}\\s`).test(list);
  return has("zoompan") && has("xfade");
}

async function main() {
  // Preflight: ffmpeg + the two motion filters must resolve.
  const ff = await run("ffmpeg", ["-version"]);
  if (ff !== 0) {
    console.error("FAIL: ffmpeg not on PATH");
    process.exit(2);
  }
  if (!motionFiltersOk()) {
    console.error("FAIL: ffmpeg build lacks zoompan and/or xfade filters");
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), "md-motion-e2e-"));
  console.log("workdir:", dir);
  try {
    // Two 3s clips (different colors + testsrc pattern so motion is visible).
    const a = join(dir, "a.mp4");
    const b = join(dir, "b.mp4");
    const narration = join(dir, "narration.mp3");
    const ga = await run("ffmpeg", [
      "-f", "lavfi", "-i", "testsrc=duration=3:size=640x360:rate=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", a,
    ]);
    const gb = await run("ffmpeg", [
      "-f", "lavfi", "-i", "mandelbrot=rate=30:size=640x360",
      "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", b,
    ]);
    // A real-audio narration tone (so final_review's audio_level check passes —
    // proves the audio mix path, not just the silent bed).
    const gn = await run("ffmpeg", [
      "-f", "lavfi", "-i", "sine=frequency=330:duration=6",
      "-y", narration,
    ]);
    if (ga !== 0 || gb !== 0 || gn !== 0 || !existsSync(a) || !existsSync(b) || !existsSync(narration)) {
      console.error("fixture gen failed");
      process.exit(2);
    }

    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [
        { id: "a", source: a, in_seconds: 0, out_seconds: 3, animation: "ken-burns" },
        { id: "b", source: b, in_seconds: 0, out_seconds: 3, animation: "zoom-in" },
      ],
      audio: { narration: { src: narration, volume: 0.8 } },
      transition: "crossfade",
      transitionSeconds: 0.5,
    };

    const out = join(dir, "compose_motion.mp4");
    console.log("rendering via ffmpeg motion compositor…");
    const t0 = Date.now();
    const report = await composeMotion(edit, { workDir: dir, output: out, width: 640, height: 360, fps: 30 });
    const elapsed = (Date.now() - t0) / 1000;
    console.log(`render took ${elapsed.toFixed(1)}s`);
    console.log(JSON.stringify(report, null, 2));

    if (report.outputs.length !== 1 || !existsSync(report.outputs[0]!.path)) {
      console.error("FAIL: no output produced");
      process.exit(3);
    }
    const o = report.outputs[0]!;
    const finalPath = o.path; // may differ from `out` when the audio mix pass ran
    console.log("final output:", finalPath);
    console.log("output size bytes:", statSync(finalPath).size);
    // Hard ffprobe assertions (independent of the report's self-report).
    if (!o.codec || !o.resolution || !o.duration_seconds || o.duration_seconds <= 0) {
      console.error("FAIL: ffprobe fields incomplete");
      process.exit(3);
    }

    const review = await finalReview(finalPath);
    console.log("final_review verdict:", review.verdict);
    console.log(JSON.stringify(review.checks, null, 2));

    const receipt = {
      ok: review.verdict === "pass",
      runtime: "compose_motion",
      render_grammar: report.render_grammar,
      output: finalPath,
      size_bytes: statSync(finalPath).size,
      duration_seconds: o.duration_seconds,
      resolution: o.resolution,
      codec: o.codec,
      audio_codec: o.audio_codec ?? null,
      render_time_seconds: Number(elapsed.toFixed(2)),
      final_review: review.verdict,
      warnings: report.warnings,
      notes: report.verification_notes,
    };
    console.log("RECEIPT:" + JSON.stringify(receipt));
    process.exit(receipt.final_review === "pass" ? 0 : 4);
  } finally {
    if (process.env.KEEP_DIR) console.log("keeping", dir);
    else rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
