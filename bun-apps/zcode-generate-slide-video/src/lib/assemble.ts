import { join } from "node:path";
import { run } from "./frames.ts";
import { probeDuration } from "./tts.ts";
import { writeFrameConcatList } from "./capture.ts";

export interface SegmentSpec {
  index: number; // 0-based
  pngPath: string;
  wavPath: string;
  outPath: string;
  duration: number;
  leadMs: number;
  width: number;
  height: number;
  fps: number;
}

/**
 * xfade offsets for a concat chain of segment durations.
 * offsets[k] (k = 1..n-1) = when transition k starts on the *output* timeline:
   offsets[0] = d[0] - t; offsets[k] = offsets[k-1] + d[k] - t.
 * Total output = Σd − (n−1)·t. Pure — tested.
 */
export function computeOffsets(durations: number[], transition: number): number[] {
  if (durations.length < 2) return [];
  const offsets: number[] = [];
  let prev = durations[0]! - transition;
  for (let k = 1; k < durations.length; k++) {
    offsets.push(Math.round(prev * 1000) / 1000);
    prev = prev + durations[k]! - transition;
  }
  return offsets;
}

export function totalDuration(durations: number[], transition: number): number {
  return durations.reduce((a, b) => a + b, 0) - transition * (durations.length - 1);
}

function zoomExpr(direction: "in" | "out", totalFrames: number): string {
  // ~8% travel over the whole segment, deterministic per output frame `on`.
  const rate = (0.08 / Math.max(totalFrames - 1, 1)).toFixed(6);
  return direction === "in"
    ? `min(1+${rate}*on,1.08)`
    : `max(1.08-${rate}*on,1.0)`;
}

/** Render one still+wav pair into an h264/aac segment with slow Ken Burns motion. */
export async function buildSegment(spec: SegmentSpec, zoom: "in" | "out"): Promise<number> {
  const totalFrames = Math.round(spec.duration * spec.fps);
  // Upscale before zoompan so the pan/zoom subpixel-shifts smoothly.
  const preW = Math.round((spec.width * 1.5) / 2) * 2;
  const preH = Math.round((spec.height * 1.5) / 2) * 2;
  const vf =
    `scale=${preW}:${preH},` +
    `zoompan=z='${zoomExpr(zoom, totalFrames)}':` +
    `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${spec.width}x${spec.height}:fps=${spec.fps},` +
    `format=yuv420p`;
  await run(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-loop", "1", "-framerate", String(spec.fps), "-t", String(spec.duration), "-i", spec.pngPath,
      "-i", spec.wavPath,
      "-filter_complex",
      `[0:v]${vf}[v];[1:a]adelay=${spec.leadMs}:all=1,apad[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", String(spec.duration),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k",
      spec.outPath,
    ],
    `segment ${spec.index + 1}`,
  );
  return probeDuration(spec.outPath);
}

/** Render a captured VFR frame sequence + narration into an h264/aac segment. */
export async function buildSegmentFromFrames(
  framesDir: string,
  frameTimes: number[],
  wavPath: string,
  outPath: string,
  spec: { duration: number; leadMs: number; fps: number; index: number },
): Promise<void> {
  const listPath = join(framesDir, "concat.txt");
  writeFrameConcatList(framesDir, frameTimes, spec.duration, listPath);
  await run(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-i", wavPath,
      "-filter_complex",
      `[0:v]fps=${spec.fps},format=yuv420p[v];[1:a]adelay=${spec.leadMs}:all=1,apad[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", String(spec.duration),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k",
      outPath,
    ],
    `segment ${spec.index + 1} (animated)`,
  );
}

/**
 * Concat segments with video crossfades (xfade) and audio crossfades
 * (acrossfade), then a global fade-in/out. Returns final duration.
 */
export async function concatSegments(
  segPaths: string[],
  durations: number[],
  transition: number,
  outPath: string,
  opts: { fadeIn: number; fadeOut: number; fps: number },
): Promise<number> {
  if (segPaths.length < 2) {
    // Degenerate single-slide deck: still goes through a fade pass.
    const total = durations[0] ?? 0;
    await run(
      "ffmpeg",
      ["-y", "-v", "error", "-i", segPaths[0]!,
        "-vf", `fade=t=in:st=0:d=${opts.fadeIn},fade=t=out:st=${Math.max(total - opts.fadeOut, 0)}:d=${opts.fadeOut}`,
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy",
        outPath],
      "final encode",
    );
    return total;
  }
  const offsets = computeOffsets(durations, transition);
  const inputArgs = segPaths.flatMap((p) => ["-i", p]);
  const chains: string[] = [];
  chains.push(`[0:v][1:v]xfade=transition=fade:duration=${transition}:offset=${offsets[0]!.toFixed(3)}[v1]`);
  chains.push(`[0:a][1:a]acrossfade=d=${transition}[a1]`);
  for (let k = 2; k < segPaths.length; k++) {
    chains.push(`[v${k - 1}][${k}:v]xfade=transition=fade:duration=${transition}:offset=${offsets[k - 1]!.toFixed(3)}[v${k}]`);
    chains.push(`[a${k - 1}][${k}:a]acrossfade=d=${transition}[a${k}]`);
  }
  const total = totalDuration(durations, transition);
  const last = segPaths.length - 1;
  chains.push(
    `[v${last}]fade=t=in:st=0:d=${opts.fadeIn},fade=t=out:st=${Math.max(total - opts.fadeOut, 0).toFixed(3)}:d=${opts.fadeOut},format=yuv420p[vout]`,
  );
  chains.push(`[a${last}]afade=t=out:st=${Math.max(total - opts.fadeOut, 0).toFixed(3)}:d=${opts.fadeOut}[aout]`);
  await run(
    "ffmpeg",
    ["-y", "-v", "error", ...inputArgs,
      "-filter_complex", chains.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      outPath],
    "final concat",
  );
  return total;
}

/** Human summary line for a finished render. */
export function describeResult(outPath: string, total: number): string {
  return `${join(outPath).split("/").pop()} — ${total.toFixed(1)}s`;
}
