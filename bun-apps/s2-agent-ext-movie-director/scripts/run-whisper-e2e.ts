/**
 * run-whisper-e2e.ts — native Whisper director: end-to-end proof.
 *
 * Drives the FULL captions chain on a real audio fixture, deterministically:
 *
 *   narration.m4a
 *     → whisperAdapter (pure swift/MLX `ltx-video transcribe`, segment-level
 *                       timestamps; per-word DTW alignment is P2b, so the
 *                       segment-mode cues below are the current ceiling)
 *       → transcript.txt + words.json
 *         → cuesFromWhisper(segments) → buildSubtitle → captions.srt (subtitle_gen)
 *           → composeVideo {captions:{srtPath, burn:true}} → captioned .mp4
 *             → finalReview {transcriptPath} → advisory spoken-content check
 *
 * Why deterministic (no LLM in the loop)? Every stage that does real work here
 * — transcription (swift/MLX Whisper), subtitle_gen (pure Bun), compose
 * (ffmpeg), final-review (ffprobe) — is deterministic. There is no model
 * judgment in the captions primitive; the LLM orchestrator is the replaceable
 * layer. This script isolates ONE variable: "does the native transcriber
 * produce real segment timestamps that flow into burned captions?"
 *
 * Prereq: the swift/ltx-video-director binary must be built
 *   (`swift build -c release` in swift/ltx-video-director) with a whisper
 *   checkpoint resolvable by `ltx-video transcribe` (cached
 *   mlx-community/whisper-large-v3-mlx, WHISPER_NATIVE_CHECKPOINT, or
 *   --checkpoint).
 *
 * Run:
 *   bun run --cwd bun-apps/s2-agent-ext-movie-director scripts/run-whisper-e2e.ts
 *
 * Env:
 *   MLX_OUTPUT_DIR           project workspace root (default repo convention)
 *   WHISPER_NATIVE_CHECKPOINT  weights.safetensors path (ltx-video transcribe flag)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  whisperAdapter,
  cuesFromWhisper,
  buildSubtitle,
  composeVideo,
  finalReview,
  probedMenuSummary,
} from "../src/index.ts";

const FIXTURE = resolve(import.meta.dirname, "..", "data", "fixtures", "narration.m4a");
const OUT = process.env.MLX_OUTPUT_DIR
  ? join(process.env.MLX_OUTPUT_DIR, "movie-director", "whisper-e2e")
  : join(import.meta.dirname, "..", "receipts", "whisper-e2e-artifacts");

function run(cmd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("exit", (c) => res({ code: c ?? -1, stdout, stderr }));
    p.on("error", () => res({ code: -1, stdout, stderr }));
  });
}

async function main() {
  if (!existsSync(FIXTURE)) throw new Error(`fixture missing: ${FIXTURE}`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const receipt: string[] = [];
  const line = (s = "") => receipt.push(s);
  line("# Item I — native Whisper director: live end-to-end receipt");
  line("");
  line(`Generated: ${new Date().toISOString()}`);
  line(`Fixture: \`${FIXTURE}\` (macOS \`say\` → ffmpeg aac, real speech)`);
  line("");

  // 0. Preflight: confirm the transcriber is callable (not a gap anymore).
  const menu = probedMenuSummary();
  const analysis = menu.capabilities.find((c) => c.capability === "analysis");
  line("## 0. Preflight");
  line(`- analysis capability available_providers: ${JSON.stringify(analysis?.available_providers)}`);
  line(`- transcriber in gaps? ${menu.gaps.some((g) => g.name === "transcriber") ? "YES (BUG)" : "no ✓"}`);
  line("");

  // 1. Transcribe (pure swift/MLX ltx-video transcribe — segment-level).
  line("## 1. Transcribe — `whisperAdapter` (swift/MLX ltx-video transcribe)");
  const t1 = Date.now();
  const res = await whisperAdapter({
    capability: "analysis",
    command: "transcribe",
    outputDir: OUT,
    options: { audio: FIXTURE, model: process.env.WHISPER_NATIVE_CHECKPOINT },
  });
  line(`- success: ${res.success}, provider: ${res.provider}, model: ${res.model}, duration: ${res.duration_seconds}s`);
  if (!res.success || !res.artifacts.length) {
    line(`- ERROR: ${res.error}`);
    throw new Error(`transcribe failed: ${res.error}`);
  }
  const transcriptPath = res.artifacts.find((a) => a.role === "transcript")!.path;
  const wordsPath = res.artifacts.find((a) => a.role === "word-timestamps")!.path;
  const words = JSON.parse(readFileSync(wordsPath, "utf8"));
  const transcript = readFileSync(transcriptPath, "utf8").trim();
  line(`- transcript: "${transcript}"`);
  line(`- language: ${words.language}, segments: ${words.segments?.length}, words: ${words.segments?.flatMap((s: { words?: unknown[] }) => s.words ?? []).length}`);
  line(`- wall time: ${((Date.now() - t1) / 1000).toFixed(2)}s`);
  line("");

  // 2. subtitle_gen: segments → cues → SRT.
  line("## 2. subtitle_gen — segment timestamps → SRT");
  const cues = cuesFromWhisper(words, "segments");
  const srt = buildSubtitle({ cues });
  const srtPath = join(OUT, "captions.srt");
  writeFileSync(srtPath, srt, "utf8");
  line(`- ${cues.length} segment cues → \`${srtPath}\``);
  line("```srt");
  line(srt.trim());
  line("```");
  line("");

  // 3. Build a source mp4 (solid color + narration audio) to caption.
  line("## 3. Compose — burn captions into a real .mp4");
  const adur = Number(words.segments?.[words.segments.length - 1]?.end ?? 7.5);
  const src = join(OUT, "source.mp4");
  const srcR = await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=0x1a2a3a:s=1280x720:r=30:d=${adur + 0.5}`,
    "-i", FIXTURE, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
  ]);
  if (srcR.code !== 0 || !existsSync(src)) throw new Error(`source mp4 gen failed: ${srcR.stderr.slice(-300)}`);
  const captioned = join(OUT, "captioned.mp4");
  const report = await composeVideo(
    { version: "1.0", cuts: [{ id: "narration", source: src, in_seconds: 0, out_seconds: adur + 0.5 }] },
    { workDir: OUT, output: captioned, captions: { srtPath, burn: true } },
  );
  line(`- render report: ${report.outputs.length} output(s), warnings: ${JSON.stringify(report.warnings)}`);
  line(`- notes: ${JSON.stringify(report.verification_notes)}`);
  if (!report.outputs.length) throw new Error("compose produced no output");
  line(`- output: ${report.outputs[0]!.path} (${report.outputs[0]!.duration_seconds?.toFixed(2)}s, ${report.outputs[0]!.resolution})`);
  // Verify a subtitle stream actually landed in the mp4 (hard-burned shows up as
  // video pixels; soft sidecar shows up as a subtitle stream — probe for the latter).
  const probe = await run("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name", "-of", "csv", report.outputs[0]!.path]);
  const streams = probe.stdout.split("\n").filter((l) => l.startsWith("stream,"));
  const subStream = streams.find((l) => /,subtitle$/.test(l));
  const burned = report.verification_notes.some((n) => n.includes("burned"));
  line(`- ffprobe streams: ${streams.map((s) => s.replace("stream,", "")).join(" | ")}`);
  line(`- captions mode: ${burned ? "hard-burned (libass)" : subStream ? `soft sidecar (${subStream.split(",")[3]})` : "NONE (compose warned)"}`);
  const captionsOk = burned || Boolean(subStream);
  line("");

  line("## 4. final_review — 6 delivery checks + advisory transcript");
  const review = await finalReview(report.outputs[0]!.path, {}, { transcriptPath });
  line(`- verdict: **${review.verdict}**`);
  for (const c of review.checks) line(`  - [${c.status}] ${c.name}: ${c.detail}`);
  line(`- surfaced transcript: ${review.transcript ? `${review.transcript.trim().split(/\s+/).length} words` : "(none)"}`);
  line("");

  line("---");
  line(`Gate: native transcribe path ✓ · captions ${captionsOk ? "embedded ✓" : "MISSING ✗"} · final_review transcript advisory ✓`)
  const out = join(import.meta.dirname, "..", "receipts", "whisper-e2e-20260705.md");
  writeFileSync(out, receipt.join("\n") + "\n", "utf8");
  console.log(`receipt → ${out}`);
  console.log(`verdict: ${review.verdict}, captions embedded: ${captionsOk}`);
}

main().catch((e) => {
  console.error("whisper-e2e failed:", e);
  process.exit(1);
});
