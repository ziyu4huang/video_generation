/**
 * hyperframes_native.ts — the HyperFrames templated-compose tier (movie-director).
 *
 * A third composition runtime alongside compose.ts (straight-cut ffmpeg, no
 * animation) and remotion.ts (React/Chromium templated composer): renders
 * edit_decisions through a generated HyperFrames HTML composition
 * (github.com/heygen-com/hyperframes) — a GSAP-driven, deterministically
 * seekable HTML timeline, rendered headlessly via the vendor CLI's bundled
 * Puppeteer + Chrome and muxed with ffmpeg. `render_runtime: "hyperframes"`
 * was already reserved on `RemotionEditDecisions` (remotion.ts) for exactly
 * this tier.
 *
 * Unlike remotion.ts (one fixed TSX composition fed a props JSON), this module
 * GENERATES a fresh composition HTML per render — `buildHyperframesComposition`
 * is a pure function (no fs/spawn), unit-testable on its own. It is a
 * deliberately simplified, non-pixel-identical port of
 * `../remotion/src/Explainer.tsx`'s scene/crossfade/overlay semantics (same
 * palette, same per-animation scale/pan curves, same "fade at cut boundaries"
 * transition model) — see that file's comments for the React original this
 * mirrors.
 *
 * v1 scope: cuts (media ken-burns/zoom/pan + text cuts), overlays
 * (section_title), and `edit.audio.narration` (a single static-volume
 * `<audio>` element, staged like any other source). `edit.audio.music`
 * (loop/fade/offset) is NOT wired — HyperFrames has no native loop
 * equivalent to Remotion's `<Audio loop>` and the framework forbids driving
 * media playback directly, so looping would require tiling multiple
 * `<audio>` clips across the timeline (future work). Same documented-gap
 * pattern as compose_motion.ts dropping edit.overlays; a warning is emitted
 * rather than silently ignored.
 *
 * The HyperFrames CLI is resolved, in order: HYPERFRAMES_BIN env → `hyperframes`
 * on PATH → `bunx hyperframes` fallback (mirrors remotion.ts's resolveRemotionBin
 * ladder).
 *
 * Asset staging (confirmed by manual probe against the real CLI, 2026-08-08):
 * an absolute/`file://` <img>/<video src> pointing OUTSIDE the composition's
 * own directory silently fails to load in the render sandbox (no error — the
 * element just never paints, so the frame renders whatever background sits
 * behind it, e.g. solid black). Only a path RELATIVE to the composition file
 * loads reliably. So every cut source is staged (hardlink, falling back to
 * copy) into `<workDir>/hyperframes-assets/` and referenced by its relative
 * name — the same hardlink-staging pattern remotion.ts uses for its
 * `--public-dir`, for the same underlying reason (the renderer's browser
 * context won't fetch arbitrary external file paths).
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RenderReport } from "./compose.ts";
import { buildRenderOutput } from "./compose.ts";
import { probeMedia } from "./ffprobe.ts";
import { runSpawn, type SpawnImpl, type SpawnResult } from "./spawn.ts";
import type { Animation, RemotionAudio, RemotionCut, RemotionEditDecisions, RemotionOverlay } from "./remotion.ts";

export type { SpawnImpl, SpawnResult } from "./spawn.ts";
export type { RemotionEditDecisions, RemotionCut, RemotionOverlay, RemotionAudio, Animation } from "./remotion.ts";

export interface HyperframesDeps {
  /** Inject a spawn impl (tests mock the hyperframes CLI). Defaults to real child_process.spawn. */
  spawnImpl?: SpawnImpl;
}

export interface HyperframesComposeOptions {
  /** Working dir for the generated composition HTML + the rendered output. */
  workDir: string;
  /** Output mp4 path (absolute). Defaults to <workDir>/compose_hyperframes_<ts>.mp4. */
  output?: string;
  /** Target width. Default 1920. */
  width?: number;
  /** Target height. Default 1080. */
  height?: number;
}

// ─── palette (mirrors ../remotion/src/Explainer.tsx PALETTE) ─────────────────

const PALETTE = {
  dark: { bg: "#0F172A", text: "#F8FAFC", accent: "#22D3EE", surface: "#1E293B" },
  light: { bg: "#FFFFFF", text: "#1F2937", accent: "#2563EB", surface: "#F9FAFB" },
};

const VIDEO_EXT = [".mp4", ".mov", ".webm", ".avi", ".mkv"];
function isVideoSource(src: string): boolean {
  const l = src.toLowerCase();
  return VIDEO_EXT.some((e) => l.endsWith(e));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Sanitize a cut/overlay id into a safe HTML id fragment + CSS selector. */
function safeId(prefix: string, raw: string, index: number): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${prefix}-${cleaned || index}`;
}

/** scale/x/y keyframes for a cut's ken-burns/zoom/pan animation (mirrors ImageScene). */
function animationKeyframes(animation: Animation | undefined): { from: { scale: number; x: number; y: number }; to: { scale: number; x: number; y: number } } {
  switch (animation) {
    case "zoom-in":
      return { from: { scale: 1, x: 0, y: 0 }, to: { scale: 1.18, x: 0, y: 0 } };
    case "zoom-out":
      return { from: { scale: 1.18, x: 0, y: 0 }, to: { scale: 1, x: 0, y: 0 } };
    case "pan-left":
      return { from: { scale: 1.15, x: 40, y: 0 }, to: { scale: 1.15, x: -40, y: 0 } };
    case "pan-right":
      return { from: { scale: 1.15, x: -40, y: 0 }, to: { scale: 1.15, x: 40, y: 0 } };
    case "ken-burns":
      return { from: { scale: 1, x: 0, y: 0 }, to: { scale: 1.22, x: -25, y: -15 } };
    case "static":
    default:
      return { from: { scale: 1, x: 0, y: 0 }, to: { scale: 1, x: 0, y: 0 } };
  }
}

/**
 * Default (test-only) src resolver: passes URLs/data: through, otherwise just
 * prefixes `file://` — NOT what a real render uses (see the staging note
 * above the imports). `renderHyperframes` always supplies a real `resolveSrc`
 * that stages the source relative to the composition's own directory.
 */
function resolveAssetSrc(src: string): string {
  if (/^(https?:|data:)/.test(src)) return src;
  return src.startsWith("/") ? `file://${src}` : src;
}

export interface BuildHyperframesResult {
  html: string;
  warnings: string[];
  /** Root composition duration in seconds (max(out_seconds) across surviving cuts). */
  durationSeconds: number;
}

/**
 * HTML/GSAP composition generator — deterministic given the same edit + opts
 * (no spawn). `opts.resolveSrc` maps a validated cut's absolute source path to
 * the string actually embedded in `src=`; defaults to `resolveAssetSrc` (fine
 * for unit tests, WRONG for a real render — see the staging note above the
 * imports). Existence validation still runs against the cut's ORIGINAL
 * absolute path, independent of what resolveSrc returns.
 */
export function buildHyperframesComposition(
  edit: RemotionEditDecisions,
  opts: { width: number; height: number; resolveSrc?: (absOrUrl: string, label: string) => string },
): BuildHyperframesResult {
  const resolveSrc = opts.resolveSrc ?? ((s: string) => resolveAssetSrc(s));
  const warnings: string[] = [];
  const valid = (edit.cuts ?? []).filter((c) => {
    if (c.type === "text") return true;
    if (c.source && (existsSync(c.source) || /^(https?:|data:)/.test(c.source))) return true;
    warnings.push(`cut "${c.id}" source missing: ${c.source ?? "(none)"}`);
    return false;
  });
  if (valid.length === 0) {
    return { html: "", warnings, durationSeconds: 0 };
  }

  const palette = PALETTE[edit.theme ?? "dark"] ?? PALETTE.dark;
  const transition = edit.transition ?? "crossfade";
  const transitionSeconds = edit.transitionSeconds ?? 0.5;
  const useXfade = transition === "crossfade" && valid.length > 1;
  const ordered = [...valid].sort((a, b) => a.in_seconds - b.in_seconds);
  const overlays = edit.overlays ?? [];
  const durationSeconds = Math.max(...ordered.map((c) => c.out_seconds), ...overlays.map((o) => o.out_seconds));

  const cutBlocks: string[] = [];
  const tweenLines: string[] = [];

  ordered.forEach((cut: RemotionCut, i: number) => {
    const id = safeId("cut", cut.id, i);
    const isText = cut.type === "text";
    const isVideo = !isText && cut.source != null && isVideoSource(cut.source);
    const start = cut.in_seconds;
    const duration = Math.max(0.01, cut.out_seconds - cut.in_seconds);

    let mediaHtml: string;
    if (isText) {
      const bg = cut.backgroundColor || palette.surface;
      const subtitleHtml = cut.subtitle
        ? `<div class="text-subtitle" style="margin-top:28px;font-size:40px;color:${palette.accent};font-weight:600;text-align:center;">${escapeHtml(cut.subtitle)}</div>`
        : "";
      mediaHtml = `<div style="position:absolute;inset:0;background:${bg};display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 12%;">
        <div style="font-size:96px;font-weight:800;color:${palette.text};text-align:center;line-height:1.1;max-width:100%;">${escapeHtml(cut.text || cut.id)}</div>
        ${subtitleHtml}
      </div>`;
    } else if (isVideo) {
      mediaHtml = `<video src="${escapeHtml(resolveSrc(cut.source!, id))}" muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"></video>`;
    } else {
      mediaHtml = `<img src="${escapeHtml(resolveSrc(cut.source!, id))}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" />`;
    }

    cutBlocks.push(`<div class="clip" id="${id}" data-start="${start}" data-duration="${duration}" data-track-index="0">
      <div class="cut-inner" id="${id}-inner" style="position:absolute;inset:0;overflow:hidden;background:#000;">
        <div class="cut-media" id="${id}-media" style="position:absolute;inset:0;transform-origin:center;">${mediaHtml}</div>
      </div>
    </div>`);

    // Ken-burns/zoom/pan sweep across the cut's own window (scale/x/y — allowlisted).
    const kf = animationKeyframes(isText ? undefined : cut.animation);
    tweenLines.push(
      `tl.fromTo("#${id}-media", { scale: ${kf.from.scale}, x: ${kf.from.x}, y: ${kf.from.y} }, { scale: ${kf.to.scale}, x: ${kf.to.x}, y: ${kf.to.y}, duration: ${duration}, ease: "none" }, ${start});`,
    );

    // Crossfade-style fade at cut boundaries (fades the wrapper, never the .clip
    // itself — mirrors Explainer.tsx's <Crossfade> AbsoluteFill wrapper). Head/tail
    // cuts skip the fade on the side with no neighbor to cross into.
    if (useXfade) {
      const isHead = i === 0;
      const isTail = i === ordered.length - 1;
      if (!isHead) {
        tweenLines.push(`tl.fromTo("#${id}-inner", { opacity: 0 }, { opacity: 1, duration: ${transitionSeconds}, ease: "none" }, ${start});`);
      }
      if (!isTail) {
        tweenLines.push(`tl.fromTo("#${id}-inner", { opacity: 1 }, { opacity: 0, duration: ${transitionSeconds}, ease: "none" }, ${Math.max(start, cut.out_seconds - transitionSeconds)});`);
      }
    }
  });

  const overlayBlocks: string[] = [];
  overlays.forEach((ov: RemotionOverlay, i: number) => {
    const id = safeId("overlay", `${i}`, i);
    const accent = ov.accentColor || palette.accent;
    const pos = ov.position || "top-left";
    const anchorStyle =
      pos === "center" ? "top:50%;left:50%;transform:translate(-50%,-50%);"
      : pos === "bottom-center" ? "bottom:12%;left:50%;transform:translateX(-50%);"
      : "top:10%;left:8%;";
    const subtitleHtml = ov.subtitle
      ? `<div style="margin-top:14px;font-size:34px;font-weight:600;color:${accent};">${escapeHtml(ov.subtitle)}</div>`
      : "";
    const start = ov.in_seconds;
    const duration = Math.max(0.01, ov.out_seconds - ov.in_seconds);
    const fin = Math.min(0.4, duration / 2);

    overlayBlocks.push(`<div class="clip" id="${id}" data-start="${start}" data-duration="${duration}" data-track-index="1">
      <div class="overlay-inner" id="${id}-inner" style="position:absolute;${anchorStyle}max-width:70%;pointer-events:none;">
        <div style="font-size:72px;font-weight:800;color:${palette.text};line-height:1.1;text-shadow:0 4px 24px rgba(0,0,0,0.6);">${escapeHtml(ov.text)}</div>
        ${subtitleHtml}
        <div style="margin-top:18px;width:96px;height:6px;background:${accent};border-radius:3px;"></div>
      </div>
    </div>`);

    tweenLines.push(`tl.fromTo("#${id}-inner", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: ${fin}, ease: "power2.out" }, ${start});`);
    tweenLines.push(`tl.fromTo("#${id}-inner", { opacity: 1 }, { opacity: 0, duration: ${fin}, ease: "power2.out" }, ${Math.max(start, ov.out_seconds - fin)});`);
  });

  // Narration audio: a single static-volume <audio> element on its own
  // reserved track (0=cuts, 1=overlays, 2=narration). No data-duration (plays
  // its full intrinsic length, clipped by the root's data-duration, mirroring
  // Remotion's <Audio> being bounded by the composition's own frame count)
  // and no GSAP tween (RemotionAudio.narration has no fade fields). Same
  // failure-tolerant pattern as a cut with a missing source: warn and skip,
  // never fail the whole composition.
  let audioBlock = "";
  const narration = edit.audio?.narration;
  if (narration) {
    if (narration.src && (existsSync(narration.src) || /^(https?:|data:)/.test(narration.src))) {
      audioBlock = `<audio id="narration" src="${escapeHtml(resolveSrc(narration.src, "narration"))}" data-start="0" data-track-index="2" data-volume="${narration.volume ?? 1}"></audio>`;
    } else {
      warnings.push(`narration source missing: ${narration.src ?? "(none)"}`);
    }
  }

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${opts.width}, height=${opts.height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${opts.width}px; height: ${opts.height}px; overflow: hidden; background: ${palette.bg}; font-family: "Inter", sans-serif; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="edit" data-start="0" data-duration="${durationSeconds}" data-width="${opts.width}" data-height="${opts.height}">
      ${cutBlocks.join("\n      ")}
      ${overlayBlocks.join("\n      ")}
      ${audioBlock}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      ${tweenLines.join("\n      ")}
      window.__timelines["edit"] = tl;
    </script>
  </body>
</html>
`;

  return { html, warnings, durationSeconds };
}

// ─── binary resolution (mirrors remotion.ts's resolveRemotionBin ladder) ─────

interface BinCmd {
  cmd: string;
  pre: string[];
}

let hyperframesCached: BinCmd | null | undefined;

/**
 * Locate a usable `hyperframes` CLI. Resolution order:
 *   1. `HYPERFRAMES_BIN` env (absolute path, used verbatim with no prefix),
 *   2. `hyperframes` on PATH (probe `hyperframes --version`),
 *   3. `bunx hyperframes` fallback (not probed — bunx caches the package after
 *      first resolution; render surfaces a clear error if bunx/network are
 *      both unavailable).
 * Cached after first resolution. Returns null if HYPERFRAMES_BIN is set but
 * the file does not exist (explicit-but-broken beats silent fallback).
 */
export async function resolveHyperframesBin(run: SpawnImpl = runSpawn): Promise<BinCmd | null> {
  if (hyperframesCached !== undefined) return hyperframesCached;
  const envBin = process.env.HYPERFRAMES_BIN;
  if (envBin) {
    hyperframesCached = existsSync(envBin) ? { cmd: envBin, pre: [] } : null;
    return hyperframesCached;
  }
  const probe = await run("hyperframes", ["--version"]);
  if (probe.code === 0) {
    hyperframesCached = { cmd: "hyperframes", pre: [] };
    return hyperframesCached;
  }
  hyperframesCached = { cmd: "bunx", pre: ["hyperframes"] };
  return hyperframesCached;
}

export function _resetHyperframesBinCacheForTest(): void {
  hyperframesCached = undefined;
}

let availableCached: boolean | undefined;
/** Synchronous-ish availability flag for the extension's preflight surface. */
export async function hyperframesAvailable(): Promise<boolean> {
  if (availableCached !== undefined) return availableCached;
  const bin = await resolveHyperframesBin();
  availableCached = bin !== null; // unlike remotion, the bunx fallback IS the vendor's supported invocation path
  return availableCached;
}
// ─── render ────────────────────────────────────────────────────────────────

/**
 * Generate the composition HTML, write it to <workDir>/hyperframes-composition.html,
 * spawn `hyperframes render -c <file> -o <output>`, and return a RenderReport.
 * Never throws.
 */
export async function renderHyperframes(
  edit: RemotionEditDecisions,
  opts: HyperframesComposeOptions,
  deps: HyperframesDeps = {},
): Promise<RenderReport> {
  const warnings: string[] = [];
  const notes: string[] = [];
  const run = deps.spawnImpl ?? runSpawn;
  const t0 = Date.now();

  if (!edit.cuts || edit.cuts.length === 0) {
    return { version: "1.0", outputs: [], warnings: ["edit_decisions has no cuts"], verification_notes: ["hyperframes compose skipped: empty cut list"] };
  }

  const bin = await resolveHyperframesBin(run);
  if (!bin) {
    return { version: "1.0", outputs: [], warnings: ["hyperframes binary not found (set HYPERFRAMES_BIN or install hyperframes on PATH)"], verification_notes: ["hyperframes compose failed: binary unavailable"] };
  }

  if (edit.audio?.music) {
    warnings.push("hyperframes compose tier does not support edit.audio.music (loop/fade) — use compose-remotion when music is required");
  }

  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;

  mkdirSync(opts.workDir, { recursive: true });
  // Stage every cut source into an assets dir alongside the composition HTML,
  // referenced by its relative name — required by the render sandbox (see the
  // staging note above the imports); prefer a hardlink (zero-copy, same
  // filesystem), falling back to a copy for cross-device sources. Mirrors
  // remotion.ts's `stage()` for its --public-dir.
  const assetsDir = join(opts.workDir, "hyperframes-assets");
  mkdirSync(assetsDir, { recursive: true });
  const stage = (absOrUrl: string, label: string): string => {
    if (/^(https?:|data:)/.test(absOrUrl)) return absOrUrl;
    const base = `${label}__${basename(absOrUrl)}`.replace(/[^\w.-]/g, "_");
    const link = join(assetsDir, base);
    try { rmSync(link, { force: true }); } catch { /* ignore */ }
    try {
      linkSync(absOrUrl, link);
    } catch {
      try { copyFileSync(absOrUrl, link); } catch { /* leave; render will 404 and surface the failure */ }
    }
    return `hyperframes-assets/${base}`;
  };

  const built = buildHyperframesComposition(edit, { width, height, resolveSrc: stage });
  warnings.push(...built.warnings);
  if (!built.html) {
    return { version: "1.0", outputs: [], warnings, verification_notes: ["hyperframes compose failed: no cut sources existed"] };
  }
  if (built.warnings.length > 0) {
    notes.push(`rendered ${edit.cuts.length - built.warnings.length}/${edit.cuts.length} cuts (missing sources dropped)`);
  }

  const compositionFilename = "hyperframes-composition.html";
  const compositionPath = join(opts.workDir, compositionFilename);
  writeFileSync(compositionPath, built.html, "utf8");

  const output = opts.output ?? join(opts.workDir, `compose_hyperframes_${Math.floor(Date.now() / 1000)}.mp4`);
  // `-c` MUST be relative to `cwd` (opts.workDir), never absolute: hyperframes@0.7.100's
  // CLI naively concatenates cwd + the `-c` value instead of resolving it, so an
  // absolute `-c` path always 404s as "Entry file not found: <cwd><-c value>" — even
  // when cwd already equals the file's own directory. `-o` has no such bug and is
  // passed absolute (confirmed by manual probe against the real CLI, 2026-08-08).
  const argv = [...bin.pre, "render", "-c", compositionFilename, "-o", output];
  const r = await run(bin.cmd, argv, { cwd: opts.workDir });
  if (r.code !== 0 || !existsSync(output)) {
    return {
      version: "1.0",
      outputs: [],
      warnings: [...warnings, `hyperframes render failed (exit ${r.code})`],
      verification_notes: [`hyperframes compose failed: ${(r.stderr || r.stdout).slice(-600)}`, `cmd: ${bin.cmd} ${argv.join(" ")}`],
    };
  }

  const probe = await probeMedia(output, run);
  notes.push(`rendered via HyperFrames (${bin.cmd}${bin.pre.length ? " " + bin.pre.join(" ") : ""})`);
  return {
    version: "1.0",
    outputs: [buildRenderOutput(output, probe)],
    render_time_seconds: (Date.now() - t0) / 1000,
    warnings,
    verification_notes: notes,
    render_grammar: "hyperframes",
  };
}
