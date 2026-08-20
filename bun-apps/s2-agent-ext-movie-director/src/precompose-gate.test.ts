import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preComposeGate, enforcePreCompose, type RemotionEditDecisions } from "./precompose-gate.ts";
import type { SpawnImpl } from "./spawn.ts";

/** Fake ffprobe: always reports `durationSeconds` for `-show_entries format=duration` probes. */
function fakeProbe(durationSeconds: number): SpawnImpl {
  return async () => ({ code: 0, stdout: String(durationSeconds), stderr: "" });
}

/** Fake ffprobe: reports a per-path duration (looked up by the probed file's argv path), so a
 * multi-cut edit can mix a clean source with a bad one in the same call. */
function fakeProbePerPath(durations: Record<string, number>): SpawnImpl {
  return async (_cmd, argv) => {
    const path = argv[argv.length - 1]!;
    return { code: 0, stdout: String(durations[path] ?? 0), stderr: "" };
  };
}

describe("preComposeGate — delivery promise", () => {
  it("fails when there are no cuts", async () => {
    const r = await preComposeGate({ version: "1.0", cuts: [] });
    expect(r.verdict).toBe("fail");
    expect(r.checks[0]!.name).toBe("cuts_present");
    expect(r.checks[0]!.status).toBe("fail");
  });

  it("fails when total duration is 0", async () => {
    const r = await preComposeGate({ version: "1.0", cuts: [{ id: "a", source: "/x.png", in_seconds: 0, out_seconds: 0, animation: "ken-burns" }] });
    expect(r.verdict).toBe("fail");
    expect(r.checks.find((c) => c.name === "total_duration_positive")!.status).toBe("fail");
  });
});

describe("preComposeGate — slideshow risk", () => {
  it("passes (no slideshow warning) when image cuts have motion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-motion-"));
    try {
      const a = join(dir, "a.png"); writeFileSync(a, "x");
      const b = join(dir, "b.png"); writeFileSync(b, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: a, in_seconds: 0, out_seconds: 2, animation: "ken-burns" },
          { id: "b", source: b, in_seconds: 2, out_seconds: 4, animation: "zoom-in" },
        ],
        transition: "crossfade",
      };
      const r = await preComposeGate(edit);
      expect(r.checks.find((c) => c.name === "slideshow_risk")!.status).toBe("pass");
      // No delivery-promise fails → verdict pass (sources exist, audio is only a warn here).
      expect(r.verdict).not.toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when most image cuts are static (slideshow risk)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-static-"));
    try {
      const mk = (n: string) => { const p = join(dir, n); writeFileSync(p, "x"); return p; };
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: mk("a.png"), in_seconds: 0, out_seconds: 2 },                       // static
          { id: "b", source: mk("b.png"), in_seconds: 2, out_seconds: 4 },                       // static
          { id: "c", source: mk("c.png"), in_seconds: 4, out_seconds: 6 },                       // static
          { id: "d", source: mk("d.png"), in_seconds: 6, out_seconds: 8, animation: "zoom-in" }, // motion
        ],
        transition: "crossfade",
      };
      const r = await preComposeGate(edit);
      const slide = r.checks.find((c) => c.name === "slideshow_risk")!;
      expect(slide.status).toBe("warn");
      expect(r.verdict).toBe("warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails slideshow risk when static images + transition=none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-none-"));
    try {
      const mk = (n: string) => { const p = join(dir, n); writeFileSync(p, "x"); return p; };
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: mk("a.png"), in_seconds: 0, out_seconds: 2 },
          { id: "b", source: mk("b.png"), in_seconds: 2, out_seconds: 4 },
        ],
        transition: "none",
      };
      const r = await preComposeGate(edit);
      expect(r.checks.find((c) => c.name === "slideshow_risk")!.status).toBe("fail");
      expect(r.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns on multiple image cuts with transition=none even if not slideshow-heavy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-nonemo-"));
    try {
      const mk = (n: string) => { const p = join(dir, n); writeFileSync(p, "x"); return p; };
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: mk("a.png"), in_seconds: 0, out_seconds: 2, animation: "ken-burns" },
          { id: "b", source: mk("b.png"), in_seconds: 2, out_seconds: 4, animation: "zoom-in" },
        ],
        transition: "none",
      };
      const r = await preComposeGate(edit);
      // Motion is set so it's not slideshow-heavy, but transition=none with >=2 image cuts nudges.
      const slide = r.checks.find((c) => c.name === "slideshow_risk")!;
      expect(slide.status).toBe("warn");
      expect(slide.detail).toContain("crossfade");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preComposeGate — sources + audio", () => {
  it("fails sources_exist when every source is missing", async () => {
    const r = await preComposeGate({
      version: "1.0",
      cuts: [
        { id: "a", source: "/no/1.png", in_seconds: 0, out_seconds: 2, animation: "ken-burns" },
        { id: "b", source: "/no/2.png", in_seconds: 2, out_seconds: 4, animation: "ken-burns" },
      ],
    });
    expect(r.checks.find((c) => c.name === "sources_exist")!.status).toBe("fail");
    expect(r.verdict).toBe("fail");
  });

  it("passes audio_present when a music layer is present (silent image cut OK)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-aud-"));
    try {
      const a = join(dir, "a.png"); writeFileSync(a, "x");
      const mus = join(dir, "m.mp3"); writeFileSync(mus, "x");
      const r = await preComposeGate({
        version: "1.0",
        cuts: [{ id: "a", source: a, in_seconds: 0, out_seconds: 3, animation: "ken-burns" }],
        audio: { music: { src: mus } },
      });
      expect(r.checks.find((c) => c.name === "audio_present")!.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preComposeGate — cut duration vs. source duration", () => {
  it("passes when a video cut's requested span fits within the source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-dur-ok-"));
    try {
      const v = join(dir, "scene.mp4"); writeFileSync(v, "x");
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: v, in_seconds: 0, out_seconds: 4, animation: "static" }] },
        { spawnImpl: fakeProbe(4.04) },
      );
      const c = r.checks.find((x) => x.name === "cut_duration_vs_source")!;
      expect(c.status).toBe("pass");
      expect(r.verdict).not.toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when a cut requests far more duration than a mostly-frozen source has (the ancient-quasars-v1 case)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-dur-frozen-"));
    try {
      const v = join(dir, "scene-hook-video.mp4"); writeFileSync(v, "x");
      // Real repro: out_seconds=32 cut from a 4.04s source (receipt real-e2e-20260711-v5).
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "hook", source: v, in_seconds: 0, out_seconds: 32, animation: "static" }] },
        { spawnImpl: fakeProbe(4.04) },
      );
      const c = r.checks.find((x) => x.name === "cut_duration_vs_source")!;
      expect(c.status).toBe("fail");
      expect(c.detail).toContain("hook");
      expect(c.detail).toContain("freeze-extend");
      expect(r.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns (not fails) when the frozen portion is a minor fraction of the requested duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-dur-warn-"));
    try {
      const v = join(dir, "scene.mp4"); writeFileSync(v, "x");
      // Requests 5s from a 4.5s source — 0.5s frozen out of 5s requested (10%), well under the 50% fail bar.
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: v, in_seconds: 0, out_seconds: 5, animation: "static" }] },
        { spawnImpl: fakeProbe(4.5) },
      );
      const c = r.checks.find((x) => x.name === "cut_duration_vs_source")!;
      expect(c.status).toBe("warn");
      expect(r.verdict).not.toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not false-positive on image-source cuts (only video sources are duration-checked)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-dur-img-"));
    try {
      const p = join(dir, "a.png"); writeFileSync(p, "x");
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: p, in_seconds: 0, out_seconds: 32, animation: "ken-burns" }] },
        { spawnImpl: fakeProbe(4.04) },
      );
      const c = r.checks.find((x) => x.name === "cut_duration_vs_source")!;
      expect(c.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when in_seconds itself is at/past the source's end, even with a short requested span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-dur-inpast-"));
    try {
      const v = join(dir, "scene.mp4"); writeFileSync(v, "x");
      // in_seconds=5 on a 4.04s source: -ss past EOF yields ~nothing, regardless of the 1s span requested.
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: v, in_seconds: 5, out_seconds: 6, animation: "static" }] },
        { spawnImpl: fakeProbe(4.04) },
      );
      const c = r.checks.find((x) => x.name === "cut_duration_vs_source")!;
      expect(c.status).toBe("fail");
      expect(c.detail).toContain("at/past source duration");
      expect(r.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a long absolute freeze even when the frozen fraction is low", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-dur-absolute-"));
    try {
      const v = join(dir, "scene.mp4"); writeFileSync(v, "x");
      // Requests 20s from a 17s source — 3s frozen out of 20s (15%, under the 50% fraction bar),
      // but 3s of held frame is itself over the 2.0s absolute-seconds fail bar.
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: v, in_seconds: 0, out_seconds: 20, animation: "static" }] },
        { spawnImpl: fakeProbe(17) },
      );
      const c = r.checks.find((x) => x.name === "cut_duration_vs_source")!;
      expect(c.status).toBe("fail");
      expect(r.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not add narrative_duration_vs_script when narrativeDurationSeconds is omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-narr-off-"));
    try {
      const v = join(dir, "scene.mp4"); writeFileSync(v, "x");
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: v, in_seconds: 0, out_seconds: 4, animation: "static" }] },
        { spawnImpl: fakeProbe(4.04) },
      );
      expect(r.checks.find((c) => c.name === "narrative_duration_vs_script")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails narrative_duration_vs_script when composed duration is far short of the script (the optical-hall-detective case)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-narr-fail-"));
    try {
      const clips = Array.from({ length: 7 }, (_, i) => {
        const p = join(dir, `s${i + 1}.mp4`); writeFileSync(p, "x"); return p;
      });
      // Real repro: 7 cuts x 8s = 56s composed, against a 120s script (47% coverage).
      const r = await preComposeGate(
        {
          version: "1.0",
          cuts: clips.map((p, i) => ({ id: `s${i + 1}`, source: p, in_seconds: 0, out_seconds: (i + 1) * 8, animation: "static" })),
        },
        { spawnImpl: fakeProbe(8.04), narrativeDurationSeconds: 120 },
      );
      const c = r.checks.find((x) => x.name === "narrative_duration_vs_script")!;
      expect(c.status).toBe("fail");
      expect(c.detail).toContain("120.00s");
      expect(r.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns (not fails) narrative_duration_vs_script when composed duration is only slightly short", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-narr-warn-"));
    try {
      const v = join(dir, "scene.mp4"); writeFileSync(v, "x");
      // 85s composed vs 100s script = 85% coverage: under the 90% warn bar, above the 80% fail bar.
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: v, in_seconds: 0, out_seconds: 85, animation: "static" }] },
        { spawnImpl: fakeProbe(85), narrativeDurationSeconds: 100 },
      );
      const c = r.checks.find((x) => x.name === "narrative_duration_vs_script")!;
      expect(c.status).toBe("warn");
      expect(r.verdict).not.toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes narrative_duration_vs_script when composed duration comfortably covers the script", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-narr-pass-"));
    try {
      const v = join(dir, "scene.mp4"); writeFileSync(v, "x");
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: v, in_seconds: 0, out_seconds: 118, animation: "static" }] },
        { spawnImpl: fakeProbe(118), narrativeDurationSeconds: 120 },
      );
      const c = r.checks.find((x) => x.name === "narrative_duration_vs_script")!;
      expect(c.status).toBe("pass");
      expect(r.verdict).not.toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the whole check when one cut is badly mismatched even if other cuts are clean (not diluted by averaging)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-dur-mixed-"));
    try {
      const clean = join(dir, "clean.mp4"); writeFileSync(clean, "x");
      const bad = join(dir, "bad.mp4"); writeFileSync(bad, "x");
      const r = await preComposeGate(
        {
          version: "1.0",
          cuts: [
            { id: "clean", source: clean, in_seconds: 0, out_seconds: 4, animation: "static" },
            { id: "bad", source: bad, in_seconds: 0, out_seconds: 32, animation: "static" },
          ],
        },
        { spawnImpl: fakeProbePerPath({ [clean]: 4.04, [bad]: 4.04 }) },
      );
      const c = r.checks.find((x) => x.name === "cut_duration_vs_source")!;
      expect(c.status).toBe("fail");
      expect(c.detail).toContain("bad");
      expect(c.detail).not.toContain('"clean" requests');
      expect(r.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preComposeGate — total duration branches on render_runtime (Bug 1, saturn-young-rings 2026-07-12)", () => {
  it("compose-motion (render_runtime=ffmpeg): sums per-cut relative windows, not max(out_seconds)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-ffmpeg-sum-"));
    try {
      // Real repro shape: 12 cuts, each locally windowed [in, in+~4-8], NOT a
      // cumulative absolute timeline — this is exactly how compose-motion.ts
      // treats cuts (array-order concat of (out_seconds - in_seconds) each).
      const outs = [8.04, 4.04, 8.04, 6.04, 8.04, 8.04, 8.04, 7.04, 8.04, 4.04, 8.04, 4.04];
      const cuts: RemotionEditDecisions["cuts"] = outs.map((out, i) => {
        const p = join(dir, `c${i}.mp4`); writeFileSync(p, "x");
        return { id: `c${i}`, source: p, in_seconds: 0, out_seconds: out, animation: "static" };
      });
      const expectedTotal = outs.reduce((s, o) => s + o, 0); // 81.48
      const r = await preComposeGate(
        { version: "1.0", cuts, render_runtime: "ffmpeg" },
        { spawnImpl: fakeProbe(8.04), narrativeDurationSeconds: 79.53 },
      );
      const total = r.checks.find((c) => c.name === "total_duration_positive")!;
      expect(total.detail).toContain(`total duration=${expectedTotal.toFixed(2)}s`);
      const narr = r.checks.find((c) => c.name === "narrative_duration_vs_script")!;
      expect(narr.status).toBe("pass"); // ~81.48s vs 79.53s script ≈ 102% — real coverage, not the "10%" bug
      const motion = r.checks.find((c) => c.name === "motion_coverage_vs_scene")!;
      expect(motion.detail).not.toContain("1013%"); // the exact nonsense value from the real bug
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compose-remotion (render_runtime unset/other): keeps max(out_seconds) absolute-timeline semantics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-remotion-max-"));
    try {
      const v = join(dir, "scene.mp4"); writeFileSync(v, "x");
      // Absolute timeline: single cut spanning [0, 8] — max(out_seconds)=8 is correct here.
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: v, in_seconds: 0, out_seconds: 8, animation: "static" }] },
        { spawnImpl: fakeProbe(8.04) },
      );
      const total = r.checks.find((c) => c.name === "total_duration_positive")!;
      expect(total.detail).toContain("total duration=8.00s");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preComposeGate — motion coverage vs. scene", () => {
  it("passes when most of the composed runtime is real video motion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-motion-cov-pass-"));
    try {
      const v = join(dir, "clip.mp4"); writeFileSync(v, "x");
      const r = await preComposeGate(
        { version: "1.0", cuts: [{ id: "a", source: v, in_seconds: 0, out_seconds: 8, animation: "static" }] },
        { spawnImpl: fakeProbe(8.04) },
      );
      const c = r.checks.find((x) => x.name === "motion_coverage_vs_scene")!;
      expect(c.status).toBe("pass");
      expect(r.verdict).not.toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when a large minority of the runtime is still-image filler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-motion-cov-warn-"));
    try {
      const v = join(dir, "clip.mp4"); writeFileSync(v, "x");
      const still = join(dir, "lastframe.png"); writeFileSync(still, "x");
      // 8s real motion + 6s panned-still filler = 8/14 ≈ 57% coverage: under the 60% warn bar, above the 40% fail bar.
      const r = await preComposeGate(
        {
          version: "1.0",
          cuts: [
            { id: "a", source: v, in_seconds: 0, out_seconds: 8, animation: "static" },
            { id: "a-filler", source: still, in_seconds: 8, out_seconds: 14, animation: "ken-burns" },
          ],
        },
        { spawnImpl: fakeProbe(8.04) },
      );
      const c = r.checks.find((x) => x.name === "motion_coverage_vs_scene")!;
      expect(c.status).toBe("warn");
      expect(r.verdict).not.toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when most of the runtime is Ken-Burns-panned still filler (the optical-hall-effect-150yr case)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-gate-motion-cov-fail-"));
    try {
      // Real repro: 4 scenes x one 8.04s real I2V clip each = 32s real motion, padded out to
      // 113s total with panned freeze-frame stills — 32/113 ≈ 28% coverage, under the 40% fail bar.
      // Every filler cut carries an `animation` object, so slideshow_risk alone would call this "has motion".
      const cuts: RemotionEditDecisions["cuts"] = [];
      let t = 0;
      for (let s = 0; s < 4; s++) {
        const clip = join(dir, `s${s}.mp4`); writeFileSync(clip, "x");
        const still = join(dir, `s${s}-lastframe.png`); writeFileSync(still, "x");
        cuts.push({ id: `s${s}a`, source: clip, in_seconds: t, out_seconds: t + 8.04, animation: "static" });
        t += 8.04;
        cuts.push({ id: `s${s}b`, source: still, in_seconds: t, out_seconds: t + 14, animation: "ken-burns" });
        t += 14;
      }
      const r = await preComposeGate(
        { version: "1.0", cuts },
        { spawnImpl: fakeProbe(8.04) },
      );
      const c = r.checks.find((x) => x.name === "motion_coverage_vs_scene")!;
      expect(c.status).toBe("fail");
      expect(c.detail).toContain("still-image filler");
      expect(r.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Relocated from extensions/movie-director.ts (Item 1, gate unification,
// output/next-goal-20260712_135012.md) — pure move, same GATE VIOLATION
// wording/override-flag behavior as before, now unit-testable without
// instantiating the extension/dispatcher.
describe("enforcePreCompose", () => {
  const failingEdit: RemotionEditDecisions = { version: "1.0", cuts: [] };
  // A text cut skips the sources_exist check entirely (no file to probe),
  // keeping this a minimal fixture for a non-"fail" verdict (audio_present
  // still warns here, which is fine — enforcePreCompose only blocks on fail).
  const passingEdit: RemotionEditDecisions = {
    version: "1.0",
    cuts: [{ id: "a", type: "text", in_seconds: 0, out_seconds: 5, text: "hello" }],
  };

  it("returns a blocking result on a fail verdict", async () => {
    const r = await enforcePreCompose(failingEdit, {});
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain("GATE VIOLATION: pre-compose failed");
  });

  it("returns null (proceed) on a passing verdict", async () => {
    const r = await enforcePreCompose(passingEdit, {});
    expect(r).toBeNull();
  });

  it("returns null when overridePreCompose:true, even on a fail verdict", async () => {
    const r = await enforcePreCompose(failingEdit, { overridePreCompose: true });
    expect(r).toBeNull();
  });
});
