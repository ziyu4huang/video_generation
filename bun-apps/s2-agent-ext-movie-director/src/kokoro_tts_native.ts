/**
 * kokoro_tts_native.ts — the Bun-native Kokoro TTS adapter, calling the
 * compiled `kokoro-tts` Swift binary (swift/musicgen-director's KokoroTTSCLI
 * target) — wiring mlx-audio-swift's already-implemented Kokoro model, NOT a
 * from-scratch port (see .planning/specs/2026-08-01-kokoro-tts-swift-
 * native-port-design.md). Same shape as music_native.ts's ensureBinary()/
 * spawn pattern.
 *
 * Reuses runpy_tts.ts's RunPyTtsDetails/RunPyTtsOutput shapes exactly (same
 * fields, command:"tts") so bridge.ts's existing adaptRunPyTts-style artifact
 * shape stays consistent across all three tts providers (runpy/edge-tts/
 * kokoro) — but KokoroTtsOptions is its OWN new type: Kokoro's voice
 * namespace (af_heart, am_michael, zf_xiaobei, zm_yunjian, etc.) and --speed
 * float are unrelated to edge-tts's RunPyTtsOptions (voice id +
 * rate-as-percentage-string), so
 * reusing that options type would misrepresent the contract.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { ensureBinary, resolveRepoRoot } from "./kokoro_binary.ts";
import type { RunPyTtsDetails, RunPyTtsOutput } from "./runpy_tts.ts";

export interface KokoroTtsOptions {
  /** Narration text (required). */
  text: string;
  /** Kokoro voice id, e.g. af_heart, am_michael, zf_xiaobei, zm_yunjian.
   *  Optional since 2026-08-21 (kokoro is the bare-tts default now): omitted →
   *  language-aware default via defaultKokoroVoice (CJK-dominant → zf_xiaobei,
   *  else af_heart). */
  voice?: string;
  /** Speech speed multiplier (Kokoro's native parameter — NOT edge-tts's rate-as-percentage-string). */
  speed?: number;
  /** mlx-audio-swift model repo id. Default (the CLI's own default): mlx-community/Kokoro-82M-bf16. */
  modelRepo?: string;
}

// ─── defaults + long-text chunking (2026-08-21 TTS A/B) ─────────────────────
// Kokoro's g2p front-end caps input at 510 tokens; a ~110-char Mandarin
// narration measured 540 tokens (≈3.4 tokens/char), a ~450-char English one
// passed. Conservative per-chunk char limits: 120 CJK / 400 latin.

export const KOKORO_DEFAULT_VOICE_EN = "af_heart";
export const KOKORO_DEFAULT_VOICE_ZH = "zf_xiaobei";
const CHUNK_CHAR_LIMIT = { cjk: 120, other: 400 } as const;

/** Language-aware default voice: CJK-dominant text gets the Mandarin voice. */
export function defaultKokoroVoice(text: string): string {
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  return cjk * 5 > text.length ? KOKORO_DEFAULT_VOICE_ZH : KOKORO_DEFAULT_VOICE_EN;
}

/** True when the text reads as CJK-dominant (drives the chunk char limit). */
export function isCjkDominant(text: string): boolean {
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  return cjk * 5 > text.length;
}

/** Split narration into chunks under the char limit, breaking at sentence
 *  boundaries (。！？…!? and . ; \n — delimiter stays with its sentence) and
 *  greedily packing. A single over-limit sentence is hard-split. Always
 *  returns ≥1 chunk; empty/whitespace-only input returns []. */
export function chunkNarration(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const limit = isCjkDominant(trimmed) ? CHUNK_CHAR_LIMIT.cjk : CHUNK_CHAR_LIMIT.other;
  const sentences = trimmed.match(/[^。！？!?….;;\n]*[。！？!?….;;\n]+|[^。！？!?….;;\n]+$/g) ?? [trimmed];
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      // Over-limit single sentence: flush what we have, then hard-split it.
      pushCurrent();
      for (let i = 0; i < sentence.length; i += limit) {
        const piece = sentence.slice(i, i + limit).trim();
        if (piece.length > 0) chunks.push(piece);
      }
      continue;
    }
    if (current.length + sentence.length > limit) pushCurrent();
    current += sentence;
  }
  pushCurrent();
  return chunks;
}

/** Minimal RIFF/WAVE PCM reader: returns the data-chunk payload + the raw fmt
 *  chunk (copied verbatim into the concatenated output). Kokoro always writes
 *  24kHz Int16 mono PCM, so all parts share one fmt. */
function readWavParts(
	path: string,
): { pcm: Buffer; fmtChunk: Buffer } {
	const buf = Buffer.from(readFileSync(path));
	if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error(`kokoro tts: not a RIFF/WAVE file: ${path}`);
	}
	let offset = 12;
	let pcm: Buffer | null = null;
	let fmtChunk: Buffer | null = null;
	while (offset + 8 <= buf.length) {
		const id = buf.toString("ascii", offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		const body = buf.subarray(offset + 8, offset + 8 + size);
		if (id === "fmt ") fmtChunk = Buffer.from(body);
		else if (id === "data") pcm = Buffer.from(body);
		offset += 8 + size + (size % 2); // chunks are word-aligned
	}
	if (!pcm || !fmtChunk) throw new Error(`kokoro tts: WAVE file missing fmt/data chunk: ${path}`);
	return { pcm, fmtChunk };
}

/** Concatenate same-format WAV parts into one PCM WAV at `out`. */
export function concatWavFiles(parts: string[], out: string): void {
	const first = readWavParts(parts[0]!);
	const pcmTotal = Buffer.concat([
		first.pcm,
		...parts.slice(1).map((p) => readWavParts(p).pcm),
	]);
	const fmtPadded = first.fmtChunk.length % 2 === 0 ? first.fmtChunk : Buffer.concat([first.fmtChunk, Buffer.from([0])]);
	const header = Buffer.alloc(12);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(4 + 8 + fmtPadded.length + 8 + pcmTotal.length, 4);
	header.write("WAVE", 8, "ascii");
	const fmtHeader = Buffer.alloc(8);
	fmtHeader.write("fmt ", 0, "ascii");
	fmtHeader.writeUInt32LE(fmtPadded.length, 4);
	const dataHeader = Buffer.alloc(8);
	dataHeader.write("data", 0, "ascii");
	dataHeader.writeUInt32LE(pcmTotal.length, 4);
	writeFileSync(out, Buffer.concat([header, fmtHeader, fmtPadded, dataHeader, pcmTotal]));
}

export interface KokoroTtsInput {
  options: KokoroTtsOptions;
  /** Output audio path (required — always passed as --output for a deterministic asset path). */
  output: string;
  signal?: AbortSignal;
  /** Test seam: inject a canned spawn result so unit tests don't need a built binary. */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Build the argv tail for `kokoro-tts generate` from KokoroTtsOptions.
 *  An omitted/blank voice resolves to the language-aware default here, so the
 *  argv is always complete regardless of caller. */
export function buildKokoroTtsArgs(opts: KokoroTtsOptions, output: string): string[] {
  const voice = opts.voice?.trim() || defaultKokoroVoice(opts.text);
  const args: string[] = ["generate", "--text", opts.text, "--voice", voice, "--output", output];
  if (opts.speed != null) args.push("--speed", String(opts.speed));
  if (opts.modelRepo != null) args.push("--model-repo", opts.modelRepo);
  return args;
}

async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bin = await ensureBinary();
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    cwd: resolveRepoRoot(),
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Run `kokoro-tts generate` and normalize into the RunPyTtsDetails/Output shape.
 *  Long text (over the g2p 510-token cap) is chunked at sentence boundaries,
 *  synthesized per chunk, and the PCM WAVs are concatenated into one output. */
export async function runKokoroTtsNative(input: KokoroTtsInput): Promise<RunPyTtsOutput> {
  const voice = input.options.voice?.trim() || defaultKokoroVoice(input.options.text);
  const chunks = chunkNarration(input.options.text);
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  const fail = (summary: string, stderrTail = "", exitCode = 1): RunPyTtsOutput => ({
    details: { ok: false, command: "tts" as const, exitCode, aborted: false, output: null, sizeBytes: null, voice: null, stdout: "" },
    summary,
    stderrTail,
  });

  if (chunks.length === 0) return fail("kokoro tts: empty text");

  // Synthesize each chunk to its own temp file next to the final output
  // (single chunk writes straight to the final path — no copy).
  const partPaths = chunks.map((_, i) => (chunks.length === 1 ? input.output : `${input.output}.part${i}.wav`));
  const results: Array<{ stdout: string; stderr: string; exitCode: number }> = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const args = buildKokoroTtsArgs({ ...input.options, text: chunks[i]!, voice }, partPaths[i]!);
      try {
        results.push(await spawnFn(args));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(`kokoro tts spawn failed: ${msg}`, msg);
      }
    }
    const bad = results.find((r) => r.exitCode !== 0);
    if (bad) {
      const stderrTail = bad.stderr.split("\n").filter((l) => l.trim()).slice(-5).join("\n");
      return fail(`kokoro tts FAILED (exit ${bad.exitCode}${chunks.length > 1 ? `, chunked x${chunks.length}` : ""})`, stderrTail, bad.exitCode);
    }
    if (chunks.length > 1) {
      try {
        concatWavFiles(partPaths, input.output);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(`kokoro tts: failed to concatenate ${chunks.length} chunks: ${msg}`, msg);
      }
    }
  } finally {
    for (const p of partPaths) {
      if (p === input.output) continue; // single-chunk path writes straight to output
      try {
        rmSync(p, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }

  const exists = existsSync(input.output);
  const sizeBytes = exists ? statSync(input.output).size : 0;
  const ok = exists && sizeBytes > 0;
  const details: RunPyTtsDetails = {
    ok,
    command: "tts",
    exitCode: 0,
    aborted: false,
    output: exists ? input.output : null,
    sizeBytes: exists ? sizeBytes : null,
    voice,
    stdout: results.at(-1)?.stdout ?? "",
  };
  const summary = ok
    ? `kokoro ✓ ${voice} (Swift native, local${chunks.length > 1 ? `, ${chunks.length} chunks` : ""}) → ${input.output}`
    : "kokoro tts FAILED: no audio written";
  return { details, summary, stderrTail: "" };
}
