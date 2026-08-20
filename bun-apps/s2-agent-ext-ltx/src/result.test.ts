import { describe, expect, test } from "bun:test";
import { buildDetails, summarize } from "./result.ts";
import type { InvokeResult } from "./invoke.ts";

function ok(stdout: string, exitCode = 0): InvokeResult {
  return { exitCode, output: stdout, stdout, stderr: "", aborted: false };
}

describe("buildDetails: native-i2v", () => {
  // Real stdout shape captured from a production native-i2v + upscale + refine run.
  const stdout = `→ native I2V (no run.py): 9 frames @ 24.0fps, 640x960, transformer=distilled
[1/5] NativeT2IStage: generating source frame...
[5/5] VideoDecoder + AudioVAEDecoder + VocoderWithBWE: decoding output...

✅ wall time: 587.7s
   source image: /tmp/out/source.png
   9 frames: /tmp/out/frames
   audio: /tmp/out/audio.wav
   100% native Swift/MLX — zero run.py calls.

[upscale] auto-upscaling (native LatentUpsampler, 2x spatial + refine pass, --no-upscale to skip)...
[3b/4] refine: low-strength denoise pass...
✅ upscale wall time: 36.4s
   640x960 -> 1280x1920
   9 frames: /tmp/out/upscaled/frames
`;

  test("output points at the upscaled frames dir when upscale ran", () => {
    const d = buildDetails("native-i2v", ok(stdout));
    expect(d.ok).toBe(true);
    expect(d.output).toBe("/tmp/out/upscaled/frames");
  });

  test("extraOutputs carries source image / base frames / audio / upscaled frames", () => {
    const d = buildDetails("native-i2v", ok(stdout));
    expect(d.extraOutputs.sourceImage).toBe("/tmp/out/source.png");
    expect(d.extraOutputs.frames).toBe("/tmp/out/frames");
    expect(d.extraOutputs.audio).toBe("/tmp/out/audio.wav");
    expect(d.extraOutputs.upscaledFrames).toBe("/tmp/out/upscaled/frames");
  });

  test("wallSeconds SUMS every 'wall time:' line — base generation AND the upscale add-on", () => {
    const d = buildDetails("native-i2v", ok(stdout));
    expect(d.wallSeconds).toBeCloseTo(587.7 + 36.4, 5);
  });

  test("without an upscale section, output falls back to the base frames dir", () => {
    const noUpscale = `→ native I2V (no run.py): 9 frames @ 24.0fps, 640x960, transformer=distilled
✅ wall time: 100.0s
   source image: /tmp/out2/source.png
   9 frames: /tmp/out2/frames
   audio: /tmp/out2/audio.wav
   100% native Swift/MLX — zero run.py calls.
`;
    const d = buildDetails("native-i2v", ok(noUpscale));
    expect(d.output).toBe("/tmp/out2/frames");
    expect(d.extraOutputs.upscaledFrames).toBeUndefined();
  });

  test("a failed run (non-zero exit) surfaces ok=false", () => {
    const d = buildDetails("native-i2v", ok("some partial output\nerror: models missing", 1));
    expect(d.ok).toBe(false);
  });

  test("reports the DERIVED resolution from the '→ native I2V' line (post-fix Swift print), not a stale requested value", () => {
    // Regression: NativeI2VCommand.swift's "→ native I2V ..." print used to
    // interpolate the pre-override `width`/`height` @Option vars instead of
    // `effectiveWidth`/`effectiveHeight` when --last-frame-derives-resolution
    // overrides them — since this exact line is what parseDims() falls back
    // to, a stale print silently mis-reported details.width/height. This
    // fixture reflects the FIXED Swift print (512x768, the derived
    // resolution) to confirm parseDims correctly surfaces it end-to-end.
    const derivedStdout = `→ native I2V (no run.py): 9 frames @ 24.0fps, 512x768, transformer=distilled
✅ wall time: 100.0s
   source image: /tmp/out3/source.png
   9 frames: /tmp/out3/frames
   audio: /tmp/out3/audio.wav
   100% native Swift/MLX — zero run.py calls.
`;
    const d = buildDetails("native-i2v", ok(derivedStdout));
    expect(d.width).toBe(512);
    expect(d.height).toBe(768);
  });
});

describe("buildDetails: native-upscale", () => {
  test("parses frames dir and dims from a standalone run", () => {
    const stdout = `→ native upscale (no run.py): reading frames from in/ [fast/preview mode]

✅ wall time: 1.8s
   640x960 -> 1280x1920
   9 frames: /tmp/up/frames
   100% native Swift/MLX — zero run.py calls.
`;
    const d = buildDetails("native-upscale", ok(stdout));
    expect(d.output).toBe("/tmp/up/frames");
    expect(d.width).toBe(1280);
    expect(d.height).toBe(1920);
    expect(d.wallSeconds).toBe(1.8);
  });

  test("hd mode: captures the intermediate [restoration] frames dir AND resolves output to the final upscaled dir", () => {
    const stdout = `→ native upscale (no run.py): reading frames from in/ [hd mode]

✅ wall time: 12.4s
   640x960 -> 640x960
   [restoration] 9 frames: /tmp/up/restored/frames

✅ wall time: 1.8s
   640x960 -> 1280x1920
   9 frames: /tmp/up/frames
   [mp4] muxed: /tmp/up/video.mp4
   100% native Swift/MLX — zero run.py calls.
`;
    const d = buildDetails("native-upscale", ok(stdout));
    expect(d.extraOutputs.restoredFrames).toBe("/tmp/up/restored/frames");
    expect(d.extraOutputs.frames).toBe("/tmp/up/frames");
    expect(d.output).toBe("/tmp/up/video.mp4");
  });
});

describe("buildDetails: native-t2a", () => {
  test("output points at the wav; no dims, wallSeconds parsed", () => {
    const stdout = `→ native T2A (no run.py, no video): 96 virtual frames @ 25.0fps, transformer=distilled

✅ wall time: 4.2s
   audio: /tmp/t2a/audio.wav
   100% native Swift/MLX — zero run.py calls, zero video generated.
`;
    const d = buildDetails("native-t2a", ok(stdout));
    expect(d.ok).toBe(true);
    expect(d.output).toBe("/tmp/t2a/audio.wav");
    expect(d.wallSeconds).toBe(4.2);
    expect(d.width).toBeNull();
  });
});

describe("buildDetails: native-relay", () => {
  // Real stdout shape from NativeRelayCommand.swift's runOnce (non-variant path).
  const stdout = `→ native relay (no run.py, no ffmpeg): 2 segment(s) @ 640x960, 2.0s/segment, transformer=distilled
[relay] ═══ Segment 1/2 ═══
[relay] ═══ Segment 2/2 ═══
   segment 1: /tmp/relay/seg01/segment.mp4
   segment 2: /tmp/relay/seg02/segment.mp4
   final: /tmp/relay/relay.mp4
   100% native Swift/MLX + AVFoundation — zero run.py calls, zero ffmpeg calls.

✅ wall time: 92.3s
`;

  test("output points at the final concatenated video; dims + wallSeconds parsed", () => {
    const d = buildDetails("native-relay", ok(stdout));
    expect(d.ok).toBe(true);
    expect(d.output).toBe("/tmp/relay/relay.mp4");
    expect(d.width).toBe(640);
    expect(d.height).toBe(960);
    expect(d.wallSeconds).toBe(92.3);
  });

  test("native-relay: final path + one numbered extraOutputs key per segment, in order", () => {
    const stdout = [
      "→ native relay (no run.py, no ffmpeg): 2 segment(s) @ 640x960, 8.0s/segment, transformer=distilled",
      "[relay] segment 1 last frame: frame_0199.png — feeding forward as segment 2's --input-image",
      "   segment 1: /tmp/relay/seg01/segment.mp4",
      "[relay] segment 2 last frame: frame_0191.png — feeding forward as segment 3's --input-image",
      "   segment 2: /tmp/relay/seg02/segment.mp4",
      "   final: /tmp/relay/relay.mp4",
      "wall time: 42.1s",
    ].join("\n");
    const d = buildDetails("native-relay", ok(stdout));
    expect(d.output).toBe("/tmp/relay/relay.mp4");
    expect(d.extraOutputs.segment_1).toBe("/tmp/relay/seg01/segment.mp4");
    expect(d.extraOutputs.segment_2).toBe("/tmp/relay/seg02/segment.mp4");
    expect(d.extraOutputs.segments).toBeUndefined();
  });
});

describe("buildDetails: native-ingredients", () => {
  const stdout = `→ native ingredients (no run.py): reference=/tmp/ref.png [lora=/tmp/ic.safetensors]

✅ wall time: 51.2s
   512x512
   9 frames: /tmp/ingredients/frames
   audio: /tmp/ingredients/audio.wav
   100% native Swift/MLX — zero run.py calls.

[mp4] muxed: /tmp/ingredients/output.mp4
`;

  test("output points at the mp4 when muxed; frames/audio in extraOutputs", () => {
    const d = buildDetails("native-ingredients", ok(stdout));
    expect(d.ok).toBe(true);
    expect(d.output).toBe("/tmp/ingredients/output.mp4");
    expect(d.extraOutputs).toEqual({ frames: "/tmp/ingredients/frames", audio: "/tmp/ingredients/audio.wav", mp4: "/tmp/ingredients/output.mp4" });
    expect(d.width).toBe(512);
    expect(d.height).toBe(512);
    expect(d.wallSeconds).toBe(51.2);
  });
});

describe("buildDetails: native-restyle", () => {
  const stdout = `→ native restyle (no run.py): reading frames from /tmp/in [V2V, lora=/tmp/style.safetensors]

✅ wall time: 30.5s
   504x504 (unchanged — restyle, not upscale)
   9 frames: /tmp/restyle/frames
   100% native Swift/MLX — zero run.py calls.
`;

  test("output points at frames dir when no mp4; dims parsed despite the trailing annotation", () => {
    const d = buildDetails("native-restyle", ok(stdout));
    expect(d.ok).toBe(true);
    expect(d.output).toBe("/tmp/restyle/frames");
    expect(d.width).toBe(504);
    expect(d.height).toBe(504);
    expect(d.wallSeconds).toBe(30.5);
  });
});

describe("buildDetails: segment", () => {
  const stdout = `[segment] clip.mp4
[segment] Threshold: 0.4, min frames: 8
[segment] Detecting scene changes...
[segment] 360 frames, 448×704, 24.0fps
[segment] Detected 2 scene(s)

  Scene 1: frames 0-199 (200 frames, 8.3s)
  Scene 2: frames 200-359 (160 frames, 6.7s)

[segment] JSON report: /tmp/seg/report.json
`;

  test("parses dims, scene list, and the JSON report path as output", () => {
    const d = buildDetails("segment", ok(stdout));
    expect(d.ok).toBe(true);
    expect(d.output).toBe("/tmp/seg/report.json");
    expect(d.width).toBe(448);
    expect(d.height).toBe(704);
    expect(d.scenes).toEqual([
      { sceneNum: 1, startFrame: 0, endFrame: 199, frames: 200, durationSec: 8.3 },
      { sceneNum: 2, startFrame: 200, endFrame: 359, frames: 160, durationSec: 6.7 },
    ]);
  });

  test("output is null when no --json path was given", () => {
    const noJson = stdout.replace(/\n\[segment\] JSON report:.*\n/, "\n");
    const d = buildDetails("segment", ok(noJson));
    expect(d.output).toBeNull();
    expect(d.scenes?.length).toBe(2);
  });
});

describe("buildDetails: t2i", () => {
  test("parses the Wrote <path> line", () => {
    const stdout = `Generating natively (ZImageDirector in-process, no run.py)...
  transformer: moody-pro-mix, size: 640x960, seed: 99
Wrote /tmp/t2i_native_output.png — 100% native Swift/MLX, zero run.py calls.
`;
    const d = buildDetails("t2i", ok(stdout));
    expect(d.output).toBe("/tmp/t2i_native_output.png");
  });
});

describe("buildDetails: i2v", () => {
  test("parses output dir, video path, wall time, and an optional gate line", () => {
    const stdout = `→ generating 240 frames (~10.0s @ 24.0fps) with transformer=distilled-1.1

✅ output dir: /tmp/i2v_out
   wall time: 245.3s
   video: /tmp/i2v_out/clip.mp4
   gate: PASS — all checks green
`;
    const d = buildDetails("i2v", ok(stdout));
    expect(d.output).toBe("/tmp/i2v_out/clip.mp4");
    expect(d.extraOutputs.outputDir).toBe("/tmp/i2v_out");
    expect(d.wallSeconds).toBe(245.3);
    expect(d.gate).toBe("PASS");
    expect(d.gateResults?.[0].status).toBe("PASS");
  });

  test("without --self-verify, no gate line means gate stays null", () => {
    const stdout = `✅ output dir: /tmp/i2v_out2
   wall time: 200.0s
   video: /tmp/i2v_out2/clip.mp4
`;
    const d = buildDetails("i2v", ok(stdout));
    expect(d.gate).toBeNull();
  });
});

describe("buildDetails: upscale", () => {
  test("parses the upscaled: <path> line and an optional gate line", () => {
    const stdout = `
✅ upscaled: /tmp/clip_restored.mp4
   gate: WARN — motion below threshold
`;
    const d = buildDetails("upscale", ok(stdout));
    expect(d.output).toBe("/tmp/clip_restored.mp4");
    expect(d.gate).toBe("WARN");
  });
});

describe("buildDetails: gate", () => {
  test("parses --json array output and computes the worst status", () => {
    const stdout = JSON.stringify([
      { path: "a.mp4", status: "PASS", reasons: [] },
      { path: "b.mp4", status: "FAIL", reasons: ["blank frames"] },
    ]);
    const d = buildDetails("gate", ok(stdout));
    expect(d.gate).toBe("FAIL");
    expect(d.gateResults).toHaveLength(2);
  });

  test("non-JSON stdout (no --json) falls back to regex-parsing the human-readable verdict", () => {
    const d = buildDetails("gate", ok("✅ PASS  a.mp4\n     all good"));
    expect(d.gateResults).toEqual([{ path: "a.mp4", status: "PASS", reasons: ["all good"] }]);
    expect(d.gate).toBe("PASS");
    expect(d.ok).toBe(true);
  });

  test("text-mode fallback also parses a FAIL entry with a nested ASR sub-result", () => {
    const stdout = [
      "❌ FAIL  a.mp4",
      "     duration too short (0.38s)",
      "     ASR ❌ FAIL  content ratio 0.00 below threshold",
      "     transcript: 謝謝",
    ].join("\n");
    const d = buildDetails("gate", ok(stdout));
    expect(d.gateResults).toEqual([
      {
        path: "a.mp4",
        status: "FAIL",
        reasons: ["duration too short (0.38s)"],
        asr: { status: "FAIL", reasons: ["content ratio 0.00 below threshold"], detectedLang: "", transcript: "謝謝" },
      },
    ]);
    expect(d.gate).toBe("FAIL");
  });

  test("folds a FAILing nested `asr` sub-check into the worst status, even when the video-only status is PASS", () => {
    const stdout = JSON.stringify([
      {
        path: "a.mp4",
        status: "PASS",
        reasons: [],
        asr: { status: "FAIL", reasons: ["transcript mismatch"], detectedLang: "en", transcript: "謝謝" },
      },
    ]);
    const d = buildDetails("gate", ok(stdout, 1));
    expect(d.gate).toBe("FAIL");
    const summary = summarize(d);
    expect(summary).toContain("ASR FAIL");
    expect(summary).toContain("transcript mismatch");
  });

  test("an ASR WARN does not get masked by a PASSing video status", () => {
    const stdout = JSON.stringify([
      { path: "a.mp4", status: "PASS", reasons: [], asr: { status: "WARN", reasons: ["low confidence"], detectedLang: "zh", transcript: "你好" } },
    ]);
    const d = buildDetails("gate", ok(stdout));
    expect(d.gate).toBe("WARN");
  });

  test("asrPrompt was requested but Swift's try? swallowed the bridge crash — no asr key at all — flags FAIL, not silent PASS", () => {
    const stdout = JSON.stringify([{ path: "a.mp4", status: "PASS", reasons: [] }]);
    const d = buildDetails("gate", ok(stdout), { videos: ["a.mp4"], asrPrompt: "「你好」" });
    expect(d.gate).toBe("FAIL");
    expect(d.gateResults?.[0].reasons).toContain(
      "ASR requested (asrPrompt) but no asr result was returned — likely a swallowed Python-bridge crash",
    );
  });

  test("without asrPrompt, a missing asr key is NOT flagged (it just wasn't requested)", () => {
    const stdout = JSON.stringify([{ path: "a.mp4", status: "PASS", reasons: [] }]);
    const d = buildDetails("gate", ok(stdout), { videos: ["a.mp4"] });
    expect(d.gate).toBe("PASS");
    expect(d.gateResults?.[0].reasons).toEqual([]);
  });
});

describe("buildDetails: verify", () => {
  test("parses --json object output", () => {
    const stdout = JSON.stringify({ mean_overall: 7.5, worst_overall: 6.0, frames: [], pass: true });
    const d = buildDetails("verify", ok(stdout));
    expect(d.verify).toEqual({ meanOverall: 7.5, worstOverall: 6.0, pass: true });
  });
});

describe("buildDetails: audio-decode / video-decode", () => {
  test("audio-decode parses the Wrote ... to <path> line", () => {
    const stdout = `Loading native AudioVAEDecoder (no run.py)...
Wrote 12000 frames (2ch, 48000) to /tmp/audio_decode_output.wav — 100% native Swift/MLX, zero run.py calls.
`;
    const d = buildDetails("audio-decode", ok(stdout));
    expect(d.output).toBe("/tmp/audio_decode_output.wav");
  });

  test("video-decode parses the Wrote ... to <path> line", () => {
    const stdout = `Wrote 9 PNG frames to /tmp/video_decode_frames — 100% native Swift/MLX, zero run.py calls.\n`;
    const d = buildDetails("video-decode", ok(stdout));
    expect(d.output).toBe("/tmp/video_decode_frames");
  });
});

describe("buildDetails: models (read-only text)", () => {
  test("falls through to text details, stdout preserved", () => {
    const stdout = "LTX-2.3 transformer variants:\n  • distilled-1.1 (default for i2v) — 3 checkpoint file(s)\n";
    const d = buildDetails("models", ok(stdout));
    expect(d.output).toBeNull();
    expect(d.stdout).toContain("distilled-1.1");
  });
});

describe("summarize", () => {
  test("failed run includes a stdout tail", () => {
    const d = buildDetails("t2i", ok("boom: transformer not found", 1));
    expect(summarize(d)).toContain("t2i FAILED");
    expect(summarize(d)).toContain("boom: transformer not found");
  });

  test("aborted run reports abortion, not failure text", () => {
    const d = buildDetails("t2i", { exitCode: 130, output: "", stdout: "", stderr: "", aborted: true });
    expect(summarize(d)).toContain("aborted");
  });

  test("ok run includes the output path and dims/gate/wall when present", () => {
    const stdout = `✅ wall time: 1.8s\n   640x960 -> 1280x1920\n   9 frames: /tmp/up/frames\n`;
    const d = buildDetails("native-upscale", ok(stdout));
    const line = summarize(d);
    expect(line).toContain("/tmp/up/frames");
    expect(line).toContain("1280x1920");
  });
});
