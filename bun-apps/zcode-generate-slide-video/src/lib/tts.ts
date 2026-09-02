import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./frames.ts";
import type { VideoConfig } from "./config.ts";

export interface VoiceLine {
  wavPath: string;
  duration: number;
}

/** ffprobe duration of a media file, seconds (throws on unparsable output). */
export async function probeDuration(path: string): Promise<number> {
  const out = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
    `probe ${path.split("/").pop()}`,
  );
  const duration = Number(out.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe returned no duration for ${path}`);
  }
  return duration;
}

/** Normalize any TTS output to 48 kHz stereo WAV (segments concat needs uniform audio). */
async function toWav(source: string, wavPath: string): Promise<void> {
  await run(
    "ffmpeg",
    ["-y", "-v", "error", "-i", source, "-ar", "48000", "-ac", "2", wavPath],
    `convert ${wavPath.split("/").pop()}`,
  );
}

async function synthSay(text: string, wavPath: string, cfg: VideoConfig): Promise<void> {
  const aiff = `${wavPath}.aiff`;
  await run("say", ["-v", cfg.voice, "-r", String(cfg.rate), "-o", aiff, text], `say “${text.slice(0, 40)}…”`);
  await toWav(aiff, wavPath);
  await rm(aiff, { force: true });
}

/**
 * mlx-audio (Apple-GPU TTS). One process per line — the model reloads each
 * time (a few seconds), which keeps the CLI stateless and failure-isolated.
 * Kokoro voices: zf_xiaobei/zf_xiaoni/… (zh female), zm_yunjian/… (zh male),
 * af_heart (US female). Mandarin needs lang_code "z" and misaki[zh].
 */
async function synthMlx(text: string, wavPath: string, cfg: VideoConfig, index: number): Promise<void> {
  const outDir = `${wavPath}.mlx`;
  await mkdir(outDir, { recursive: true });
  try {
    await run(
      cfg.ttsPython,
      [
        "-m", "mlx_audio.tts.generate",
        "--model", cfg.ttsModel,
        "--text", text,
        "--voice", cfg.voice,
        "--lang_code", cfg.ttsLang,
        "--speed", String(cfg.speed),
        "--output_path", outDir,
        "--audio_format", "wav",
      ],
      `mlx tts line ${index + 1}`,
    );
    // mlx-audio writes <file_prefix|audio>_NNN.wav into output_path.
    const produced = await Array.fromAsync(new Bun.Glob("*.wav").scan({ cwd: outDir }));
    if (produced.length === 0) throw new Error(`mlx-audio produced no wav for line ${index + 1}`);
    produced.sort();
    await toWav(join(outDir, produced[0]!), wavPath);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** Synthesize one narration line to a 48 kHz stereo WAV on the configured backend. */
export async function synthLine(
  index: number,
  text: string,
  wavPath: string,
  cfg: VideoConfig,
): Promise<VoiceLine> {
  if (cfg.tts === "mlx") await synthMlx(text, wavPath, cfg, index);
  else await synthSay(text, wavPath, cfg);
  return { wavPath, duration: await probeDuration(wavPath) };
}
