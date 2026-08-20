/**
 * remotion.ts — the templated-compose stage (movie-director iteration 4, G-full).
 *
 * Whereas `compose.ts` is the ffmpeg straight-cut foundation (trim + concat,
 * no animation), this module renders edit_decisions through a Remotion
 * composition (`../remotion/src/Explainer.tsx`): per-cut ken-burns/zoom/pan
 * motion, crossfade transitions between cuts, a section_title overlay layer,
 * and narration/music audio — the "full compose" tier.
 *
 * The contract between this TS orchestrator and the TSX composition is the
 * `RemotionProps` JSON written to disk and passed to `remotion render --props`.
 * Remotion itself is NOT imported into the extension (heavy React + Chromium
 * dep tree) — it is spawned as a Node subprocess. The binary is resolved, in
 * order: `REMOTION_BIN` env → `remotion` on PATH → `bunx remotion` fallback.
 *
 * `renderRemotion()` returns the same `RenderReport` shape as the ffmpeg
 * foundation so the `movie compose` caller can treat both uniformly. The spawn
 * is injectable (`deps.spawnImpl`) so tests verify the props JSON + argv + report
 * assembly without a real Remotion/Chromium install; the real-silicon smoke is
 * opt-in via `REMOTION_SMOKE=1`.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RenderReport } from "./compose.ts";
import { buildRenderOutput } from "./compose.ts";
import { probeMedia } from "./ffprobe.ts";
import { runSpawn, type SpawnImpl, type SpawnResult } from "./spawn.ts";

export type { SpawnImpl, SpawnResult } from "./spawn.ts";

export interface RemotionDeps {
  spawnImpl?: SpawnImpl;
}

// ─── props model (mirrors ../remotion/src/Explainer.tsx ExplainerProps) ──────

export type Animation = "static" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "ken-burns";

export interface RemotionCut {
  id: string;
  /** Image/video path or URL. Optional for text cuts (no media). */
  source?: string;
  in_seconds: number;
  out_seconds: number;
  type?: "media" | "text";
  animation?: Animation;
  text?: string;
  subtitle?: string;
  source_in_seconds?: number;
  backgroundColor?: string;
}

export interface RemotionOverlay {
  type: "section_title";
  in_seconds: number;
  out_seconds: number;
  text: string;
  subtitle?: string;
  accentColor?: string;
  position?: "top-left" | "bottom-center" | "center";
}

export interface RemotionAudio {
  narration?: { src: string; volume?: number };
  music?: {
    src: string;
    volume?: number;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
    offsetSeconds?: number;
    loop?: boolean;
  };
}

export interface RemotionEditDecisions {
  version: string;
  cuts: RemotionCut[];
  /**
   * Locked at proposal stage (edit_decisions.schema.json requires this).
   * "ffmpeg" is compose_motion.ts's tier — cuts concatenate in array order
   * using each cut's own (out_seconds - in_seconds) as a RELATIVE window
   * duration, so total runtime is the SUM of per-cut windows, not
   * max(out_seconds). "remotion"/"hyperframes" place cuts on one shared
   * absolute timeline (Root.tsx: durationInFrames = max(out_seconds)), so
   * max(out_seconds) is correct there. Optional (not "string") so existing
   * callers/tests that don't know their render tier keep the prior
   * absolute-timeline behavior unchanged.
   */
  render_runtime?: "remotion" | "hyperframes" | "ffmpeg";
  /** Overlay layer (section titles, stat reveals). */
  overlays?: RemotionOverlay[];
  /** Narration + music layers (absolute paths or URLs). */
  audio?: RemotionAudio;
  /** Transition between cuts. Default "crossfade". */
  transition?: "none" | "crossfade";
  /** Crossfade duration in seconds. Default 0.5. */
  transitionSeconds?: number;
  /** Palette. Default "dark". */
  theme?: "dark" | "light";
}

export interface RemotionProps extends RemotionEditDecisions {
  width: number;
  height: number;
  fps: number;
}

export interface RemotionComposeOptions {
  /** Working dir for the props JSON + the rendered output. */
  workDir: string;
  /** Output mp4 path (absolute). Defaults to <workDir>/compose_remotion_<ts>.mp4. */
  output?: string;
  /** Target width. Default 1920. */
  width?: number;
  /** Target height. Default 1080. */
  height?: number;
  /** Target fps. Default 30. */
  fps?: number;
}

// ─── binary resolution ───────────────────────────────────────────────────────

/** Absolute path to the Remotion entry (this file → ../remotion/src/index.tsx). */
const REMOTION_ENTRY = join(import.meta.dir, "..", "remotion", "src", "index.tsx");
/** Absolute path to the Remotion project dir (cwd for the spawn — where node_modules live). */
const REMOTION_DIR = join(import.meta.dir, "..", "remotion");

interface BinCmd {
  cmd: string;
  pre: string[]; // leading argv prepended before "render ..."
}

let remotionCached: BinCmd | null | undefined;

/**
 * The bundled local install's `remotion` binary, if `bun install` was run in the
 * shipped `../remotion/` project (NOT a workspace member — its node_modules are
 * gitignored). Present iff the user opted into the install-and-probe path; absent
 * on a fresh clone. This is what makes a real Remotion render callable WITHOUT
 * PATH/REMOTION_BIN gymnastics — the install the extension ships resolves itself.
 */
const BUNDLED_REMOTION_BIN = join(REMOTION_DIR, "node_modules", ".bin", "remotion");
/** @internal — exported for the resolution-order test (machine-portable). */
export const _BUNDLED_REMOTION_BIN_FOR_TEST = BUNDLED_REMOTION_BIN;

/**
 * Locate a usable `remotion` binary. Resolution order:
 *   1. `REMOTION_BIN` env (absolute path, used verbatim with no prefix),
 *   2. `remotion` on PATH (probe `remotion --version`),
 *   3. the bundled local install at <EXT_ROOT>/remotion/node_modules/.bin/remotion
 *      (present after `bun install` in ../remotion/; probed by existence),
 *   4. `bunx remotion` fallback (assumed available — not probed; render will
 *      surface the error if bunx/remotion are both missing).
 * Cached after first resolution. Returns null if REMOTION_BIN is set but the
 * file does not exist (explicit-but-broken beats silent fallback).
 */
export async function resolveRemotionBin(run: SpawnImpl = runSpawn): Promise<BinCmd | null> {
  if (remotionCached !== undefined) return remotionCached;
  const envBin = process.env.REMOTION_BIN;
  if (envBin) {
    remotionCached = existsSync(envBin) ? { cmd: envBin, pre: [] } : null;
    return remotionCached;
  }
  // Probe PATH: `remotion --version` exits 0 if installed.
  const probe = await run("remotion", ["--version"]);
  if (probe.code === 0) {
    remotionCached = { cmd: "remotion", pre: [] };
    return remotionCached;
  }
  // Probe the bundled local install (the shipped `../remotion/` project, if
  // installed). Running its .bin/remotion with cwd=REMOTION_DIR resolves the
  // sibling node_modules — the install is self-contained, no PATH needed.
  if (existsSync(BUNDLED_REMOTION_BIN)) {
    remotionCached = { cmd: BUNDLED_REMOTION_BIN, pre: [] };
    return remotionCached;
  }
  // Last resort: bunx remotion (not probed — let the render surface a clear error).
  remotionCached = { cmd: "bunx", pre: ["remotion"] };
  return remotionCached;
}

export function _resetRemotionBinCacheForTest(): void {
  remotionCached = undefined;
}

/** Synchronous availability flag for the extension's preflight surface. */
let availableCached: boolean | undefined;
export async function remotionAvailable(): Promise<boolean> {
  if (availableCached !== undefined) return availableCached;
  const bin = await resolveRemotionBin();
  availableCached = bin !== null && bin.cmd !== "bunx"; // bunx fallback = "not really installed"
  return availableCached;
}
// ─── render ──────────────────────────────────────────────────────────────────

/**
 * Build the RemotionProps JSON from edit_decisions + options, write it to
 * <workDir>/remotion-props.json, spawn `remotion render`, and return a
 * render_report. Returns an empty report (with warnings) if Remotion is not
 * resolvable or the render exits non-zero — never throws.
 */
export async function renderRemotion(
  edit: RemotionEditDecisions,
  opts: RemotionComposeOptions,
  deps: RemotionDeps = {},
): Promise<RenderReport> {
  const warnings: string[] = [];
  const notes: string[] = [];
  const run = deps.spawnImpl ?? runSpawn;
  const t0 = Date.now();

  if (!edit.cuts || edit.cuts.length === 0) {
    return { version: "1.0", outputs: [], warnings: ["edit_decisions has no cuts"], verification_notes: ["remotion compose skipped: empty cut list"] };
  }

  const bin = await resolveRemotionBin(run);
  if (!bin) {
    return { version: "1.0", outputs: [], warnings: ["remotion binary not found (set REMOTION_BIN or install remotion on PATH)"], verification_notes: ["remotion compose failed: binary unavailable"] };
  }

  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const fps = opts.fps ?? 30;

  // Warn (don't crash) on missing sources — Remotion would error mid-render;
  // better to report up front. We still attempt render with surviving cuts.
  const valid = edit.cuts.filter((c) => {
    if (c.type === "text") return true; // text cuts have no source file
    if (c.source && existsSync(c.source)) return true;
    warnings.push(`cut "${c.id}" source missing: ${c.source ?? "(none)"}`);
    return false;
  });
  if (valid.length === 0) {
    return { version: "1.0", outputs: [], warnings, verification_notes: ["remotion compose failed: no cut sources existed"] };
  }
  if (valid.length < edit.cuts.length) {
    notes.push(`rendered ${valid.length}/${edit.cuts.length} cuts (missing sources dropped)`);
  }

  // Stage every validated source into a per-render public dir and rewrite the
  // props to reference the bare relative name. Remotion's <Img>/<OffthreadVideo>
  // block `file://` (CSP), so assets must be served via staticFile() against the
  // --public-dir we pass to the renderer. Symlinks avoid copying large videos.
  const publicDir = join(opts.workDir, "remotion-public");
  mkdirSync(publicDir, { recursive: true });
  const stage = (absOrUrl: string | undefined, label: string): string | undefined => {
    if (!absOrUrl) return undefined;
    if (/^(https?:|data:)/.test(absOrUrl)) return absOrUrl; // pass URLs through
    if (!existsSync(absOrUrl)) return undefined;
    const base = `${label}__${basename(absOrUrl)}`.replace(/[^\w.-]/g, "_");
    const link = join(publicDir, base);
    try { rmSync(link, { force: true }); } catch { /* ignore */ }
    // Prefer a hard link (zero-copy, same filesystem) — Remotion's public-dir
    // bundler enumerates files and does NOT follow symlinks, so a hardlink (a real
    // directory entry) is the cheapest artifact it will pick up. Fall back to a
    // copy when hardlinking fails (cross-device) — a render-time cost worth noting
    // for large source videos.
    try {
      linkSync(absOrUrl, link);
    } catch {
      try { copyFileSync(absOrUrl, link); } catch { /* leave; render will warn */ }
    }
    return base;
  };

  const stagedCuts = valid.map((c) =>
    c.source ? { ...c, source: stage(c.source, c.id) ?? c.source } : c,
  );
  const stagedAudio: RemotionProps["audio"] = edit.audio ? {
    narration: edit.audio.narration ? { ...edit.audio.narration, src: stage(edit.audio.narration.src, "narration") ?? edit.audio.narration.src } : undefined,
    music: edit.audio.music ? { ...edit.audio.music, src: stage(edit.audio.music.src, "music") ?? edit.audio.music.src } : undefined,
  } : undefined;

  const props: RemotionProps = {
    version: edit.version,
    cuts: stagedCuts,
    overlays: edit.overlays,
    audio: stagedAudio,
    transition: edit.transition ?? "crossfade",
    transitionSeconds: edit.transitionSeconds ?? 0.5,
    theme: edit.theme ?? "dark",
    width,
    height,
    fps,
  };

  // Write the props JSON (the single contract with the composition).
  const propsPath = join(opts.workDir, "remotion-props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 2));

  const output = opts.output ?? join(opts.workDir, `compose_remotion_${Math.floor(Date.now() / 1000)}.mp4`);
  const argv = [
    ...bin.pre,
    "render",
    REMOTION_ENTRY,
    "Explainer",
    output,
    `--props=${propsPath}`,
    `--public-dir=${publicDir}`,
    "--codec=h264",
    "--pixel-format=yuv420p",
    "--log=error",
  ];
  const r = await run(bin.cmd, argv, { cwd: REMOTION_DIR });
  if (r.code !== 0 || !existsSync(output)) {
    return {
      version: "1.0",
      outputs: [],
      warnings: [...warnings, `remotion render failed (exit ${r.code})`],
      verification_notes: [`remotion compose failed: ${(r.stderr || r.stdout).slice(-600)}`, `cmd: ${bin.cmd} ${argv.join(" ")}`],
    };
  }

  const probe = await probeMedia(output, run);
  notes.push(`rendered via Remotion (${bin.cmd}${bin.pre.length ? " " + bin.pre.join(" ") : ""})`);
  return {
    version: "1.0",
    outputs: [buildRenderOutput(output, probe)],
    render_time_seconds: (Date.now() - t0) / 1000,
    warnings,
    verification_notes: notes,
    render_grammar: "remotion",
  };
}

// ffprobe (probeMedia) lives in the shared ./ffprobe.ts module — the three
// compose tiers share one parser. Kept this comment where the local copy was.

// ─── ffprobe (local, mirrors compose.ts) — REMOVED, see ./ffprobe.ts ────────
