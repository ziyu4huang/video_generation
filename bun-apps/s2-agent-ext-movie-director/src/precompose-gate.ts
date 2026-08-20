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
 *      before the expensive render, via one ffprobe call per video cut. Judged
 *      per-cut (not by the single worst cut across the whole edit) against two
 *      independent fail bars — frozen fraction of the cut AND absolute frozen
 *      seconds — so one bad cut isn't diluted by clean ones, and a long freeze
 *      at a low fraction still fails. `in_seconds` itself landing at/past the
 *      source's end (the whole span reads as empty) always hard-fails.
 *
 *   4. **Narrative duration vs. script duration** — a *different* mismatch
 *      from #3: every individual cut can be well within its own source clip
 *      (so `cut_duration_vs_source` passes clean) while the edit's *total*
 *      runtime is still far shorter than the narrative it's supposed to
 *      carry. This bit a real run (`optical-hall-detective`, 2026-07-11): a
 *      120s/7-section script with 162.9s of synthesized narration got
 *      composed into a flat 7x8s = 56.28s video (every scene capped at a
 *      uniform "~8-10s of motion" with no reconciliation against the much
 *      longer, variable-length script sections) — the delivered video
 *      couldn't possibly narrate its own story, and nothing caught it
 *      before publish. Only checked when the caller supplies
 *      `opts.narrativeDurationSeconds` (the script's planned runtime, or the
 *      synthesized narration audio's actual probed duration — whichever the
 *      caller has); silently skipped (not even a `pass` entry) when absent,
 *      so existing callers/tests that don't know about the story's duration
 *      are unaffected.
 *
 *   5. **Motion coverage vs. scene** — the loophole `narrative_duration_vs_script`
 *      (#4) doesn't close: an edit can satisfy the total-duration bar while
 *      being mostly still-image filler, because a still cut with any
 *      `animation` (even a trivial pan) already reads as "has motion" to
 *      `slideshow_risk` (#2), and `cut_duration_vs_source` (#3) only looks at
 *      video-source cuts. This bit the very rerun that verified #4's fix
 *      (`optical-hall-effect-150yr`, 2026-07-11): each scene generated one
 *      real ~8s I2V clip, then covered the rest of its script-planned
 *      duration with a Ken-Burns-panned freeze-frame still extracted from
 *      that clip's own last frame — SSIM confirmed the real clips read as
 *      motion (~0.45) and the "filler" stills read as static (~0.985), and
 *      ~72% of the delivered runtime was filler. This check sums real
 *      video-cut seconds vs. total composed seconds and warns/fails when
 *      real motion is a small fraction of the runtime — the fix on the
 *      generation side is to chain multiple real I2V clips per scene
 *      (last-frame reseed) instead of padding with a panned still; this gate
 *      just makes the shortcut visible before publish instead of silent.
 *
 *   6. **Total-duration formula branches on render_runtime.** #1/#4/#5 above
 *      all depend on one "total composed seconds" number, and that number
 *      means different things on different render tiers: compose-remotion
 *      places cuts on a shared absolute timeline (max(out_seconds) is the
 *      true total), but compose-motion (render_runtime="ffmpeg" — the tier
 *      every real e2e run in this project has actually used) concatenates
 *      cuts in array order using each cut's own (out_seconds - in_seconds)
 *      as a RELATIVE window (sum of per-cut windows is the true total). Using
 *      max() unconditionally silently reported an ~78s compose-motion video's
 *      duration as one clip's ~8s length — confirmed in the saturn-young-rings
 *      run (2026-07-12); see output/next-goal-20260712_081500.md. Unset/
 *      non-"ffmpeg" `render_runtime` keeps the original max()-based behavior.
 *
 * Verdict: any `fail` → fail (don't render); else any `warn` → warn (render but
 * flag); else pass. Delivery-promise + slideshow + motion-coverage checks are
 * pure (fs existence only); the duration checks need ffprobe calls (per video
 * source) or a caller-supplied narrative duration, so the gate as a whole is
 * async.
 */
import { existsSync } from "node:fs";
import type { RemotionEditDecisions } from "./remotion.ts";
import { probeDuration } from "./ffprobe.ts";
import type { SpawnImpl } from "./spawn.ts";
import type { GateResult } from "./gate.ts";

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
   * Per-cut fraction of requested duration that would be a frozen-frame
   * extension above which that cut hard-fails instead of warning.
   * Default 0.5 (more than half of the cut frozen).
   */
  freezeExtensionFailFraction?: number;
  /**
   * Per-cut absolute frozen-frame seconds above which that cut hard-fails
   * regardless of fraction — catches a long freeze that's a low fraction of
   * a long requested duration (e.g. 3s frozen out of 20s requested is only
   * 15%, but 3s of a held frame still reads as broken). Default 2.0s.
   */
  freezeExtensionFailSeconds?: number;
  /** Frozen-seconds tolerance before a cut counts as mismatched at all (probe/encode rounding). Default 0.2s. */
  freezeToleranceSeconds?: number;
  /**
   * The story's planned narrative runtime in seconds — the sum of the
   * script's section durations, or (preferably, since it's what's actually
   * synthesized) the narration audio file's probed duration. When omitted,
   * the `narrative_duration_vs_script` check is skipped entirely (not even
   * a `pass` entry) — this option only exists to let a caller who has this
   * number opt in, it doesn't change behavior for callers who don't.
   */
  narrativeDurationSeconds?: number;
  /**
   * Fraction of `narrativeDurationSeconds` the composed edit's total
   * duration must reach before this check warns. Default 0.9 (composed
   * runtime is missing more than 10% of the planned narrative).
   */
  narrativeDurationWarnFraction?: number;
  /**
   * Fraction of `narrativeDurationSeconds` the composed edit's total
   * duration must reach before this check hard-fails. Default 0.8 (missing
   * more than 20% — the optical-hall-detective run was at 47%, a clear fail
   * under this bar).
   */
  narrativeDurationFailFraction?: number;
  /**
   * Fraction of total composed seconds that must come from real video-source
   * cuts (not still images, however animated) before `motion_coverage_vs_scene`
   * warns. Default 0.6.
   */
  motionCoverageWarnFraction?: number;
  /**
   * Fraction of total composed seconds that must come from real video-source
   * cuts before `motion_coverage_vs_scene` hard-fails. Default 0.4 — the
   * optical-hall-effect-150yr run measured ~28% (32s real motion / 113s
   * total), a clear fail under this bar.
   */
  motionCoverageFailFraction?: number;
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

  // Two genuinely different render semantics share this "total composed
  // duration" number (see the Bug-1 writeup in output/next-goal-20260712_081500.md):
  // compose-motion (render_runtime="ffmpeg") concatenates cuts in array order
  // using each cut's own (out_seconds - in_seconds) as a RELATIVE window, so
  // the true total is the SUM of per-cut windows. compose-remotion (and, by
  // default/unknown, "hyperframes") place cuts on one shared absolute
  // timeline (Root.tsx: durationInFrames = max(out_seconds)), so max() is
  // correct there. Using max() for a compose-motion edit silently reports
  // one clip's length as the whole video's duration — confirmed in the
  // saturn-young-rings run (12 cuts, real ~78s composed, gate read "8.04s").
  const sumRelative = cuts
    .filter((c) => c.type !== "text")
    .reduce((sum, c) => sum + Math.max(0, (c.out_seconds ?? 0) - (c.in_seconds ?? 0)), 0);
  const maxAbsolute = Math.max(0, ...cuts.map((c) => c.out_seconds ?? 0));
  const lastOut = edit.render_runtime === "ffmpeg" ? sumRelative : maxAbsolute;
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
  const freezeFailSeconds = opts.freezeExtensionFailSeconds ?? 2.0;
  const freezeTolerance = opts.freezeToleranceSeconds ?? 0.2;
  const videoCuts = mediaCuts.filter((c) => isVideo(c.source) && c.source && existsSync(c.source));
  const mismatches: { id: string; status: "warn" | "fail"; reason: string }[] = [];
  for (const c of videoCuts) {
    const inSeconds = c.in_seconds ?? 0;
    const requested = (c.out_seconds ?? 0) - inSeconds;
    if (requested <= 0) continue;
    const sourceDuration = await probeDuration(c.source!, opts.spawnImpl);
    if (sourceDuration <= 0) continue; // probe failed — can't judge, don't false-positive

    // in_seconds itself at/past the source's end: ffmpeg `-ss` past EOF yields
    // ~nothing real, so the ENTIRE requested span is a frozen/empty read —
    // always a hard fail, independent of the fraction/absolute-seconds knobs
    // below (compose_motion.ts already carries a defensive warning for this
    // exact case; the gate should catch it before the render, not just log it).
    if (inSeconds >= sourceDuration - freezeTolerance) {
      mismatches.push({
        id: c.id,
        status: "fail",
        reason: `"${c.id}" in_seconds=${inSeconds.toFixed(2)}s is at/past source duration (${sourceDuration.toFixed(2)}s) — the whole ${requested.toFixed(2)}s requested span reads as empty/frozen`,
      });
      continue;
    }

    const available = Math.max(0, sourceDuration - inSeconds);
    const frozenSeconds = requested - available;
    if (frozenSeconds <= freezeTolerance) continue; // within source, nothing to flag

    const frozenFrac = frozenSeconds / requested;
    const status: "warn" | "fail" = frozenFrac > freezeFailFrac || frozenSeconds > freezeFailSeconds ? "fail" : "warn";
    mismatches.push({
      id: c.id,
      status,
      reason: `"${c.id}" requests ${requested.toFixed(2)}s, source has ${available.toFixed(2)}s left ` +
        `(${frozenSeconds.toFixed(2)}s would be frozen, ${(frozenFrac * 100).toFixed(0)}%)`,
    });
  }
  if (mismatches.length > 0) {
    const worstStatus: "warn" | "fail" = mismatches.some((m) => m.status === "fail") ? "fail" : "warn";
    checks.push({
      name: "cut_duration_vs_source",
      status: worstStatus,
      detail: `${mismatches.length}/${videoCuts.length} video cut(s) request more duration than their source has — ` +
        `compose-motion will silently freeze-extend the last frame: ` +
        mismatches.map((m) => `${m.reason}${m.status === "fail" ? " [fail]" : " [warn]"}`).join("; "),
    });
  } else {
    checks.push({
      name: "cut_duration_vs_source",
      status: "pass",
      detail: videoCuts.length > 0 ? `${videoCuts.length} video cut(s) within their source's duration` : "no video cuts to check",
    });
  }

  // ── motion coverage vs. scene (a still cut with any `animation` already
  //    reads as "has motion" to slideshow_risk above, so an edit can be
  //    mostly panned-still filler and still pass every check so far — see
  //    optical-hall-effect-150yr, 2026-07-11) ──────────────────────────────
  const motionWarnFraction = opts.motionCoverageWarnFraction ?? 0.6;
  const motionFailFraction = opts.motionCoverageFailFraction ?? 0.4;
  const hasRealVideoCut = mediaCuts.some((c) => isVideo(c.source));
  const realVideoSeconds = mediaCuts
    .filter((c) => isVideo(c.source))
    .reduce((sum, c) => sum + Math.max(0, (c.out_seconds ?? 0) - (c.in_seconds ?? 0)), 0);
  // Only applies to edits that already contain real generated motion — a
  // purely still-image "animated slideshow" edit (Ken Burns throughout, no
  // I2V source at all) is a legitimate, distinct composition style already
  // judged by slideshow_risk above; this check targets the specific loophole
  // where an edit MIXES real video with still filler and the filler quietly
  // dominates the runtime.
  if (lastOut > 0 && hasRealVideoCut) {
    const motionCoverage = realVideoSeconds / lastOut;
    let motionStatus: GateCheck["status"] = "pass";
    if (motionCoverage < motionFailFraction) motionStatus = "fail";
    else if (motionCoverage < motionWarnFraction) motionStatus = "warn";
    checks.push({
      name: "motion_coverage_vs_scene",
      status: motionStatus,
      detail: `real video motion=${realVideoSeconds.toFixed(2)}s of ${lastOut.toFixed(2)}s total ` +
        `(${(motionCoverage * 100).toFixed(0)}% coverage)` +
        (motionStatus === "pass"
          ? ""
          : ` — most of the runtime is still-image filler (however animated); chain additional real I2V ` +
            `clips per scene (last-frame reseed) instead of padding with a panned/zoomed still`),
    });
  }

  // ── narrative duration vs. script duration (a run can carry every cut
  //    within its own source and still be far shorter than the story it's
  //    supposed to tell — see optical-hall-detective, 2026-07-11) ─────────────
  if (opts.narrativeDurationSeconds !== undefined && opts.narrativeDurationSeconds > 0) {
    const scriptSeconds = opts.narrativeDurationSeconds;
    const warnFraction = opts.narrativeDurationWarnFraction ?? 0.9;
    const failFraction = opts.narrativeDurationFailFraction ?? 0.8;
    const coverage = lastOut / scriptSeconds;
    let status: GateCheck["status"] = "pass";
    if (coverage < failFraction) status = "fail";
    else if (coverage < warnFraction) status = "warn";
    checks.push({
      name: "narrative_duration_vs_script",
      status,
      detail: `composed duration=${lastOut.toFixed(2)}s vs. script/narration duration=${scriptSeconds.toFixed(2)}s ` +
        `(${(coverage * 100).toFixed(0)}% coverage)` +
        (status === "pass"
          ? ""
          : ` — composed video is missing ${((1 - coverage) * 100).toFixed(0)}% of the planned narrative; ` +
            `either extend per-scene clip/cut durations to match the script's section lengths, or shorten the script`),
    });
  }

  const verdict: PreComposeGateResult["verdict"] = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";
  return { verdict, checks };
}

/**
 * GATE (Bug 2, saturn-young-rings 2026-07-12): a pre-compose `verdict:"fail"`
 * used to block nothing — an agent could call `pre-compose`, read a fail, and
 * simply call `compose-motion`/`compose-remotion` next with the identical
 * unmodified edit. Mirrors the `overrideFinalReview` pattern in checkpoint.ts:
 * both compose tool cases now run the SAME gate internally (deterministic,
 * cheap outside the video-cut ffprobe calls, and the caller's editDecisions
 * is already in hand — no separate pre-compose call is required) and refuse
 * to render on a fail verdict unless `overridePreCompose:true` is passed
 * explicitly. A `warn` verdict does not block (matches pre-compose's own
 * warn/fail distinction) — only `fail` does. Returns null (proceed) or a
 * `{ok:false}` tool result (blocked) for the caller to return directly.
 */
export async function enforcePreCompose(edit: RemotionEditDecisions, opts: Record<string, unknown>): Promise<GateResult> {
  if (opts.overridePreCompose === true) return null;
  const narrativeDurationSeconds = opts.narrativeDurationSeconds !== undefined ? Number(opts.narrativeDurationSeconds) : undefined;
  const gate = await preComposeGate(edit, { narrativeDurationSeconds });
  if (gate.verdict !== "fail") return null;
  const failedChecks = gate.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`);
  return {
    ok: false,
    error:
      `GATE VIOLATION: pre-compose failed (${failedChecks.length} check(s)) — refusing to render:\n  ` +
      failedChecks.join("\n  ") +
      `\nFix the edit_decisions (or the underlying assets) and retry, or pass overridePreCompose=true only ` +
      `after an explicit human/agent decision to ship past the failure.`,
  };
}
