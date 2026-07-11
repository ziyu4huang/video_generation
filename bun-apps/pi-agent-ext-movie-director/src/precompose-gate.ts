/**
 * precompose-gate.ts — the pre-compose gate (movie-director iteration 4, G-full).
 *
 * A deterministic, spawn-free gate run BEFORE the (expensive) Remotion render.
 * It checks two families:
 *
 *   1. **Delivery promise** — can a shippable mp4 come out of this edit at all?
 *      (cuts present, total duration > 0, non-text sources exist, audio layer or
 *      a video source present so the result isn't silent.)
 *
 *   2. **Slideshow risk** — the templated composer's whole point is motion; an
 *      edit that is mostly static images with no animation/transition would
 *      render as a flat slideshow, wasting a multi-minute Chromium render on a
 *      result the ffmpeg straight-cut path could have produced. The gate warns
 *      when the static-image fraction exceeds a threshold and suggests ken-burns
 *      or a crossfade transition.
 *
 *   3. **Cut duration vs. source duration** — a video-source cut whose
 *      `out_seconds - in_seconds` exceeds what the source clip actually has left
 *      renders fine (no ffmpeg error) but `compose-motion`/ffmpeg silently holds
 *      the last frame for the remainder — a mostly-frozen "video" that looks
 *      like real motion in a thumbnail. This bit a real agent-driven run (a 32s
 *      cut from a 4.04s I2V source) with no error at any stage; catch it here,
 *      before the expensive render, via one ffprobe call per video cut.
 *
 * Verdict: any `fail` → fail (don't render); else any `warn` → warn (render but
 * flag); else pass. Delivery-promise + slideshow checks are pure (fs existence
 * only); the duration check needs one ffprobe per video source, so the gate as
 * a whole is async.
 */
import { existsSync } from "node:fs";
import type { RemotionEditDecisions } from "./remotion.ts";
import { probeDuration } from "./ffprobe.ts";
import type { SpawnImpl } from "./spawn.ts";

// Re-export so consumers of the gate get the input type from one import.
export type { RemotionEditDecisions } from "./remotion.ts";

export interface GateCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface PreComposeGateResult {
  verdict: "pass" | "warn" | "fail";
  checks: GateCheck[];
}

export interface PreComposeGateOptions {
  /** Fraction of static-image cuts above which slideshow risk warns. Default 0.6. */
  staticImageThreshold?: number;
  /** Minimum absolute count of static-image cuts before the risk fires. Default 2. */
  staticImageMinCount?: number;
  /**
   * Fraction of a cut's requested duration that would be a frozen-frame
   * extension (beyond the source's real remaining length) above which the
   * check hard-fails instead of warning. Default 0.5 (more than half frozen).
   */
  freezeExtensionFailFraction?: number;
  /** Injectable ffprobe spawn (tests mock this instead of shelling to real ffprobe). */
  spawnImpl?: SpawnImpl;
}

const VIDEO_EXT = [".mp4", ".mov", ".webm", ".avi", ".mkv"];
function isVideo(src: string | undefined): boolean {
  const l = (src || "").toLowerCase();
  return VIDEO_EXT.some((e) => l.endsWith(e));
}

/**
 * Inspect edit_decisions for delivery-promise failures and slideshow risk.
 * Deterministic — reads the filesystem only to check source existence.
 */
export async function preComposeGate(edit: RemotionEditDecisions, opts: PreComposeGateOptions = {}): Promise<PreComposeGateResult> {
  const checks: GateCheck[] = [];
  const cuts = edit.cuts ?? [];
  const threshold = opts.staticImageThreshold ?? 0.6;
  const minCount = opts.staticImageMinCount ?? 2;

  // ── delivery promise ──────────────────────────────────────────────────────
  if (cuts.length === 0) {
    checks.push({ name: "cuts_present", status: "fail", detail: "edit_decisions has no cuts" });
    return { verdict: "fail", checks }; // nothing else to check
  }
  checks.push({ name: "cuts_present", status: "pass", detail: `${cuts.length} cut(s)` });

  const lastOut = Math.max(0, ...cuts.map((c) => c.out_seconds ?? 0));
  checks.push({
    name: "total_duration_positive",
    status: lastOut > 0 ? "pass" : "fail",
    detail: `total duration=${lastOut.toFixed(2)}s`,
  });

  const missing = cuts.filter((c) => c.type !== "text" && c.source && !existsSync(c.source));
  checks.push({
    name: "sources_exist",
    status: missing.length === 0 ? "pass" : missing.length === cuts.length ? "fail" : "warn",
    detail: missing.length === 0
      ? "all non-text sources present"
      : `${missing.length}/${cuts.length} source(s) missing: ${missing.map((m) => m.id).join(", ")}`,
  });

  const hasVideoSource = cuts.some((c) => c.type !== "text" && isVideo(c.source));
  const hasAudioLayer = !!(edit.audio?.narration?.src || edit.audio?.music?.src);
  checks.push({
    name: "audio_present",
    status: hasVideoSource || hasAudioLayer
      ? "pass"
      : "warn",
    detail: hasVideoSource || hasAudioLayer
      ? hasAudioLayer ? "audio layer present" : "video source carries audio"
      : "no audio layer and no video source — result will be silent",
  });

  // ── slideshow risk ─────────────────────────────────────────────────────────
  const mediaCuts = cuts.filter((c) => c.type !== "text");
  const imageCuts = mediaCuts.filter((c) => !isVideo(c.source));
  const staticImages = imageCuts.filter((c) => !c.animation || c.animation === "static");
  const frac = imageCuts.length > 0 ? staticImages.length / imageCuts.length : 0;
  const transitionNone = (edit.transition ?? "crossfade") === "none";

  let slideshowStatus: GateCheck["status"] = "pass";
  let detail = `static-image ${staticImages.length}/${imageCuts.length} (frac ${frac.toFixed(2)})`;
  if (imageCuts.length > 0 && staticImages.length >= minCount && frac > threshold) {
    slideshowStatus = transitionNone ? "fail" : "warn";
    detail += ` — ${transitionNone ? "slideshow risk (no motion + no transition)" : "slideshow risk (no motion; transition set)"}`;
    detail += "; add ken-burns/zoom/pan animation or lower the static-image count";
  } else if (transitionNone && imageCuts.length >= 2) {
    slideshowStatus = "warn";
    detail += ` — transition=none with multiple image cuts; consider "crossfade"`;
  }
  checks.push({ name: "slideshow_risk", status: slideshowStatus, detail });

  // ── cut duration vs. source duration (frozen-frame extension) ─────────────
  const freezeFailFrac = opts.freezeExtensionFailFraction ?? 0.5;
  const videoCuts = mediaCuts.filter((c) => isVideo(c.source) && c.source && existsSync(c.source));
  const mismatches: { id: string; requested: number; available: number; frozenSeconds: number }[] = [];
  for (const c of videoCuts) {
    const requested = (c.out_seconds ?? 0) - (c.in_seconds ?? 0);
    if (requested <= 0) continue;
    const sourceDuration = await probeDuration(c.source!, opts.spawnImpl);
    if (sourceDuration <= 0) continue; // probe failed — can't judge, don't false-positive
    const available = Math.max(0, sourceDuration - (c.in_seconds ?? 0));
    const frozenSeconds = requested - available;
    if (frozenSeconds > 0.2) { // 200ms tolerance for probe/encode rounding
      mismatches.push({ id: c.id, requested, available, frozenSeconds });
    }
  }
  if (mismatches.length > 0) {
    const worstFrac = Math.max(...mismatches.map((m) => m.frozenSeconds / m.requested));
    checks.push({
      name: "cut_duration_vs_source",
      status: worstFrac > freezeFailFrac ? "fail" : "warn",
      detail: `${mismatches.length} cut(s) request more duration than their source has left — ` +
        `compose-motion will silently freeze-extend the last frame: ` +
        mismatches.map((m) => `"${m.id}" requests ${m.requested.toFixed(2)}s, source has ${m.available.toFixed(2)}s left (${m.frozenSeconds.toFixed(2)}s would be frozen)`).join("; "),
    });
  } else {
    checks.push({
      name: "cut_duration_vs_source",
      status: "pass",
      detail: videoCuts.length > 0 ? `${videoCuts.length} video cut(s) within their source's duration` : "no video cuts to check",
    });
  }

  const verdict: PreComposeGateResult["verdict"] = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";
  return { verdict, checks };
}
