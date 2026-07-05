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
 * Verdict: any `fail` → fail (don't render); else any `warn` → warn (render but
 * flag); else pass. Pure functions → fully unit-testable without Remotion/ffmpeg.
 */
import { existsSync } from "node:fs";
import type { RemotionEditDecisions } from "./remotion.ts";

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
export function preComposeGate(edit: RemotionEditDecisions, opts: PreComposeGateOptions = {}): PreComposeGateResult {
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

  const verdict: PreComposeGateResult["verdict"] = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";
  return { verdict, checks };
}
