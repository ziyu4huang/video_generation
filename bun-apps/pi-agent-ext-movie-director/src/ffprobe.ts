/**
 * ffprobe.ts — shared ffprobe helpers for the compose tiers.
 *
 * `compose.ts` (ffmpeg straight-cut), `compose_motion.ts` (zoompan+xfade motion),
 * and `remotion.ts` (templated) each previously carried their OWN copy of the
 * exact same ffprobe-JSON parser + fps-fraction parser + duration-only probe
 * (~30 lines × 3). This module is the single source of truth: one parser, one
 * spawn signature, one failure shape (`{ duration: 0 }`, never throws — mirroring
 * the never-throws contract every compose tier already upholds).
 *
 * The spawn is injectable (`run?`) so the unit tests that mock ffmpeg keep
 * working unchanged — each tier passes its own `deps.spawnImpl ?? runSpawn`;
 * when omitted, the real child_process spawn runs (the real-silicon E2E path).
 *
 * Pure / pi-free: imports only `./spawn.ts` (itself pi-free, `node:child_process` only).
 */
import { runSpawn, type SpawnImpl } from "./spawn.ts";

export interface ProbeResult {
  duration: number;
  format?: string;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
  fps?: number;
}

/** Parse an ffmpeg avg_frame_rate fraction ("N/D") → a number; undefined when unparseable. */
export function parseFps(frac: string): number | undefined {
  const parts = frac.split("/").map(Number);
  const n = parts[0];
  const d = parts[1];
  // noUncheckedIndexedAccess: destructure values are number | undefined; guard both.
  if (n != null && d && Number.isFinite(n)) return n / d;
  return undefined;
}

/**
 * Full ffprobe of a media file: container format, video/audio codec, resolution,
 * fps, and duration. Returns `{ duration: 0 }` on any probe/parse failure
 * (never throws — the same contract the compose tiers already rely on).
 * `run` defaults to the real child_process spawn.
 */
export async function probeMedia(path: string, run?: SpawnImpl): Promise<ProbeResult> {
  const spawnImpl = run ?? runSpawn;
  const r = await spawnImpl("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  if (r.code !== 0) return { duration: 0 };
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === "video");
    const a = (j.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === "audio");
    const fps = v?.avg_frame_rate ? parseFps(String(v.avg_frame_rate)) : undefined;
    return {
      duration: Number(j.format?.duration ?? 0),
      format: j.format?.format_name ? String(j.format.format_name).split(",")[0] : undefined,
      videoCodec: v?.codec_name,
      audioCodec: a?.codec_name,
      resolution: v && v.width && v.height ? `${v.width}x${v.height}` : undefined,
      fps,
    };
  } catch {
    return { duration: 0 };
  }
}

/**
 * Lightweight duration-only probe — the helper the xfade-offset math and the
 * audio-mix pass use (they only need the seconds). `run` defaults to the real
 * child_process spawn. Returns 0 on any failure (never throws).
 */
export async function probeDuration(path: string, run?: SpawnImpl): Promise<number> {
  const spawnImpl = run ?? runSpawn;
  const r = await spawnImpl("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path]);
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}
