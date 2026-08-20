/**
 * tts_native.ts — Bun-native TTS adapter using `msedge-tts` instead of
 * shelling `run.py tts` (a thin Python wrapper around the SAME Microsoft
 * edge-tts cloud service — see runpy_tts.ts's header).
 *
 * Hand-rolling the edge-tts WebSocket protocol (Sec-MS-GEC HMAC signing,
 * SSML framing, binary audio-frame parsing) is a moving target — Microsoft
 * tightens anti-abuse measures periodically and every unofficial client has
 * needed repeated protocol updates to keep working. Rather than reimplement
 * and re-verify that from scratch, this wraps `msedge-tts` (MIT, actively
 * maintained — latest release 2026-07-09, days before this migration),
 * which already tracks those changes. This still removes the Python/MLX-venv
 * dependency entirely for TTS: the network call is still Microsoft's cloud
 * service (unavoidable — edge-tts has no local/offline mode), but the CALLER
 * is now pure Bun, matching this migration's "delete the Python middleman"
 * goal for every non-MLX-compute run.py surface.
 *
 * LOCAL SPAWN NO LONGER APPLIES: unlike runpy_tts.ts there is no subprocess
 * at all now — just an outbound WebSocket from this Bun process. The
 * synthesis call still goes out to Microsoft's service (needs network
 * egress, not available under --offline — same constraint as before).
 */
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export interface TtsNativeOptions {
  /** Narration text (required). */
  text: string;
  /** edge-tts voice id. Default (mirrors run.py's default): en-US-AriaNeural. */
  voice?: string;
  /** Speech rate as a signed percentage string, e.g. "-10%", "+15%". Default "+0%". */
  rate?: string;
}

export interface TtsNativeDetails {
  ok: boolean;
  command: "tts";
  output: string | null;
  sizeBytes: number | null;
  voice: string | null;
}

export interface TtsNativeOutput {
  details: TtsNativeDetails;
  summary: string;
  stderrTail: string;
}

const DEFAULT_VOICE = "en-US-AriaNeural";

/**
 * Test seam: a factory for the MsEdgeTTS client, so unit tests can inject a
 * fake client without real network egress. The real path constructs the
 * library's client directly.
 */
export type MsEdgeTtsFactory = () => Pick<MsEdgeTTS, "setMetadata" | "toStream" | "close">;

function defaultFactory(): MsEdgeTTS {
  return new MsEdgeTTS();
}

/** Synthesize `options.text` via edge-tts (msedge-tts client) and write it to `output`. */
export async function runTtsNative(
  options: TtsNativeOptions,
  output: string,
  factory: MsEdgeTtsFactory = defaultFactory,
): Promise<TtsNativeOutput> {
  const voice = options.voice ?? DEFAULT_VOICE;
  const tts = factory();
  try {
    await mkdir(dirname(output), { recursive: true });
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(options.text, options.rate ? { rate: options.rate } : undefined);
    await pipeline(audioStream, createWriteStream(output));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const details: TtsNativeDetails = { ok: false, command: "tts", output: null, sizeBytes: null, voice: null };
    return { details, summary: `tts FAILED: ${msg}`, stderrTail: msg };
  } finally {
    tts.close();
  }

  const exists = existsSync(output);
  const sizeBytes = exists ? statSync(output).size : 0;
  const ok = exists && sizeBytes > 0;
  const details: TtsNativeDetails = {
    ok,
    command: "tts",
    output: exists ? output : null,
    sizeBytes: exists ? sizeBytes : null,
    voice,
  };
  const summary = ok ? `tts ✓ edge-tts (${voice}) → ${output}` : "tts FAILED: no audio written";
  return { details, summary, stderrTail: ok ? "" : "no audio bytes written" };
}
