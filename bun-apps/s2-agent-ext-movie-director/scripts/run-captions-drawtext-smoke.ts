/**
 * run-captions-drawtext-smoke.ts — real-silicon proof that the drawtext tier of
 * the captions ladder HARD-BURNS a cue into a video frame (not a soft sidecar).
 *
 * On macOS stock `ffmpeg` (no libass AND no drawtext) the ladder legitimately
 * ends at sidecar — so this smoke uses `ffmpeg-full` (libass + drawtext) on PATH
 * and FORCES the drawtext tier by pinning the libass probe false. That isolates
 * the drawtext code path: it proves (a) the argv `captions.ts` builds is a valid
 * ffmpeg filtergraph that actually renders text, and (b) the burned text is
 * present in a mid-cue frame and ABSENT in a pre-cue control frame.
 *
 * Run (with ffmpeg-full first on PATH):
 *   PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH" \
 *     bun bun-apps/s2-agent-ext-movie-director/scripts/run-captions-drawtext-smoke.ts
 *
 * Exits 0 only if: drawtext tier ran, the mid-cue frame differs from the control
 * (pixels changed), and both frames decode. Writes a JSON receipt to stdout.
 */
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { composeVideo, _setFfmpegAvailableForTest } from "../src/compose.ts";
import {
  _setSubtitlesFilterForTest,
  _setDrawtextFilterForTest,
  _setCaptionFontForTest,
  drawtextFilterAvailable,
  subtitlesFilterAvailable,
} from "../src/captions.ts";

function run(cmd: string, argv: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", () => res({ code: -1, stderr }));
    p.on("exit", (c) => res({ code: c ?? -1, stderr }));
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "md-cap-drawtext-smoke-"));
  try {
    // Preflight: the drawtext filter MUST be present (use ffmpeg-full).
    if (!drawtextFilterAvailable()) {
      console.error("SKIP: ffmpeg on PATH lacks the `drawtext` filter — run with ffmpeg-full on PATH.");
      process.exit(2);
    }
    // FORCE the drawtext tier: pretend libass is absent even though ffmpeg-full
    // has it, so the ladder skips libass and exercises drawtext on real silicon.
    _setFfmpegAvailableForTest(true);
    _setSubtitlesFilterForTest(false);
    _setDrawtextFilterForTest(true);
    _setCaptionFontForTest(undefined); // let it resolve the real macOS Arial

    // 1. A 4s solid-color test clip (clean background so caption text is the
    //    only thing that changes between frames).
    const src = join(dir, "src.mp4");
    let r = await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=4:r=30",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
    ]);
    if (r.code !== 0 || !existsSync(src)) throw new Error(`source gen failed: ${r.stderr.slice(-300)}`);

    // 2. An SRT with one cue at 1.0–3.0s. Distinctive text so OCR/VLM can confirm.
    const srt = join(dir, "captions.srt");
    const fs = await import("node:fs");
    fs.writeFileSync(srt, "1\n00:00:01,000 --> 00:00:03,000\nSMOKE DRAWTEXT BURN\n");

    // 3. Compose (single cut) with burn:true → the ladder hits drawtext.
    const out = join(dir, "composed.mp4");
    const report = await composeVideo(
      { version: "1.0", cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 4 }] },
      { workDir: dir, output: out, captions: { srtPath: srt, burn: true } },
    );
    if (report.outputs.length === 0) throw new Error(`compose produced no output: ${JSON.stringify(report.warnings)}`);
    const burned = report.outputs[0]!.path;
    const tierMatch = report.verification_notes.some((n) => n.includes("burned (drawtext)"));
    if (!tierMatch) {
      throw new Error(`expected drawtext tier, got notes: ${JSON.stringify(report.verification_notes)} / warnings: ${JSON.stringify(report.warnings)}`);
    }

    // 4. Extract a MID-cue frame (t=2.0s, inside [1,3]) and a PRE-cue control (t=0.5s).
    const midPng = join(dir, "frame_mid.png");
    const prePng = join(dir, "frame_pre.png");
    await run("ffmpeg", ["-y", "-ss", "2.0", "-i", burned, "-frames:v", "1", midPng]);
    await run("ffmpeg", ["-y", "-ss", "0.5", "-i", burned, "-frames:v", "1", prePng]);
    if (!existsSync(midPng) || !existsSync(prePng)) throw new Error("frame extract failed");

    // 5. Pixel proof: the mid-cue frame must contain non-black pixels (the
    //    burned text) while the pre-cue control is all-black. ffmpeg's
    //    `blackframe` reports `pblack:<pct>` — percent of pixels that are black.
    //    A burned cue drops mid below 100; the control stays at 100.
    const midBlack = await frameBlackPct(midPng);
    const preBlack = await frameBlackPct(prePng);
    const delta = preBlack - midBlack;
    const pixelsChanged = delta >= 1.0; // ≥1% of pixels became non-black = text burned

    const receipt = {
      tier: "drawtext",
      burned_output: burned,
      bytes: statSync(burned).size,
      mid_frame_bytes: statSync(midPng).size,
      pre_frame_bytes: statSync(prePng).size,
      mid_black_pct: midBlack,
      pre_black_pct: preBlack,
      nonblack_delta_pct: Number(delta.toFixed(2)),
      pixels_changed: pixelsChanged,
      notes: report.verification_notes,
      warnings: report.warnings,
      ffmpeg_full_drawtext: drawtextFilterAvailable(),
      ffmpeg_full_libass: subtitlesFilterAvailable(),
    };
    console.log(JSON.stringify(receipt, null, 2));
    if (!pixelsChanged) {
      console.error(`FAIL: mid-cue frame did not differ from control (nonblack_delta_pct=${delta.toFixed(2)}); drawtext did not burn visible text.`);
      process.exit(1);
    }
    console.error(`OK: drawtext hard-burned a cue into the mid-cue frame (mid_black=${midBlack}% < pre_black=${preBlack}%).`);
    process.exit(0);
  } finally {
    // Keep the frames for VLM inspection iff MD_KEEP_SMOKE=1; else clean up.
    if (process.env.MD_KEEP_SMOKE !== "1") rmSync(dir, { recursive: true, force: true });
  }
}

/** Percent of black pixels in a frame via ffmpeg's blackframe (pblack). */
async function frameBlackPct(png: string): Promise<number> {
  const r = await run("ffmpeg", ["-hide_banner", "-i", png, "-vf", "blackframe=amount=0", "-f", "null", "-"]);
  const m = r.stderr.match(/pblack:(\d+)/);
  return m ? parseInt(m[1]!, 10) : 100;
}

main().catch((err) => {
  console.error("SMOKE ERROR:", err);
  process.exit(1);
});
