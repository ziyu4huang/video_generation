/**
 * voice.ts — the narration step of auto-story mode: Kokoro TTS per scene
 * (reusing s2-agent-ext-movie-director's native adapter — runtime-light,
 * node builtins only), then per-segment ffmpeg muxing of narration over
 * LTX's own generated soundtrack.
 *
 * The mux is deliberately per-segment (not one track over the final): each
 * scene's line stays aligned with its clip even when scenes have different
 * narration lengths, and the concat keeps A/V sync without re-encoding video.
 */
import { statSync } from "fs";

import { runKokoroTtsNative, defaultKokoroVoice } from "@repo/s2-agent-ext-movie-director/src/kokoro_tts_native.ts";
import { ensureBinary as ensureKokoroBinary } from "@repo/s2-agent-ext-movie-director/src/kokoro_binary.ts";

import { BED_VOLUME, NARRATION_LEAD_IN_MS } from "./narration";
import type { PipelineHandle } from "./jobs";

/** Curated Kokoro voices offered in the UI (Auto = language-aware default). */
export const VOICE_CHOICES = [
  { id: "", label: "Auto (match story language)" },
  { id: "af_heart", label: "af_heart · English female" },
  { id: "am_michael", label: "am_michael · English male" },
  { id: "zf_xiaobei", label: "zf_xiaobei · 中文 female" },
  { id: "zm_yunjian", label: "zm_yunjian · 中文 male" },
] as const;

export function isValidVoice(id: string): boolean {
  return id === "" || /^[a-z]{2}_[a-z0-9_]+$/.test(id);
}

/** Kokoro always synthesizes 24 kHz Int16 mono — enough to read duration. */
export function wavDurationSec(wavPath: string): number | null {
  try {
    const size = statSync(wavPath).size;
    // 44-byte canonical header, 24000 samples/s × 2 bytes — an estimate the
    // exact-RIFF parse in kokoro_tts_native keeps honest for chunked files.
    return Math.max(0, (size - 44) / (24000 * 2));
  } catch {
    return null;
  }
}

/**
 * ffmpeg argv: narration WAV over the segment's own LTX soundtrack.
 * Video is copied (no re-encode); audio = bed (ducked) + voice (lead-in,
 * padded, truncated at the video's end by duration=first).
 */
export function buildVoiceMixArgs(segment: string, voiceWav: string, out: string): string[] {
  const filter =
    `[0:a]volume=${BED_VOLUME}[bed];` +
    `[1:a]adelay=${NARRATION_LEAD_IN_MS}:all=1,apad[voice];` +
    `[bed][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`;
  return [
    "-y",
    "-i", segment,
    "-i", voiceWav,
    "-filter_complex", filter,
    "-map", "0:v",
    "-map", "[a]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    out,
  ];
}

/** ffmpeg concat-demuxer list body — absolute paths, single quotes escaped. */
export function concatListBody(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/**
 * Synthesize one narration line via Kokoro. Never rejects — returns
 * [wavPath, null] on success or [null, reason] on failure (the story still
 * renders, just without spoken narration; the reason lands in story.json).
 */
export async function synthesizeNarration(
  text: string,
  voice: string,
  outWav: string,
  handle: PipelineHandle,
): Promise<[string | null, string | null]> {
  if (!text.trim()) return [null, "empty narration line"];
  try {
    const result = await runKokoroTtsNative({
      options: { text, voice: voice || undefined },
      output: outWav,
      signal: handle.signal,
    });
    if (!result.details.ok || !result.details.output) {
      return [null, `${result.summary}${result.stderrTail ? ` — ${result.stderrTail}` : ""}`];
    }
    handle.log(`   ${result.summary}`);
    return [result.details.output, null];
  } catch (e) {
    return [null, e instanceof Error ? e.message : String(e)];
  }
}

/** Pre-build/bin-resolve the kokoro-tts binary once, streaming build lines. */
export async function ensureKokoro(handle: PipelineHandle): Promise<string> {
  return ensureKokoroBinary((u) => handle.log(u.text));
}

export { defaultKokoroVoice };
