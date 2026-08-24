import { describe, expect, it } from "bun:test";
import {
  adaptKrea2,
  adaptFlux2,
  adaptLtx,
  adaptRunPy,
  adaptCaption,
  adaptKokoroTts,
  generate,
  selectAndGenerate,
  tariffFor,
  missingRequiredOptions,
  normalizeLegacyImageRequest,
  isNativeControlNetRequest,
  isNativeWorkflowRequest,
  isNativePurifyRequest,
  type ToolResult,
  type GenerateRequest,
  type Adapter,
} from "./bridge.ts";
import { selectProvider, rankedProviders } from "./selector.ts";
import { REGISTRY, type ProviderEntry } from "./registry.ts";
import { probeConfigured, _setLmStudioReachableForTest, _setMusicgenBinaryForTest } from "./providers.ts";
import { defaultBinaryPath, resolveRepoRoot } from "@repo/s2-agent-ext-ltx";
import { existsSync } from "node:fs";
import type { Krea2Details } from "@repo/s2-agent-ext-krea2";
import type { Flux2Details } from "@repo/s2-agent-ext-flux2";
import type { LtxDetails, RunPyVideoDetails } from "@repo/s2-agent-ext-ltx";

// Honest signal for the machine-coupled selector/probe tests below: is the
// local MLX venv (python/venv + run.py) actually present? On CI or right after
// `git clean -dxf` / a fresh clone it is absent → these tests skip instead of
// failing with NoConfiguredProviderError / probe mismatch.
const VENV_PRESENT = probeConfigured(REGISTRY.find((p) => p.invoke === "mlx:runpy")!);

const imgReq: GenerateRequest = {
  capability: "image_generation",
  command: "t2i",
  options: { prompt: "a cat", seed: 42, width: 512, height: 512 },
};

function entryFor(invoke: ProviderEntry["invoke"]): ProviderEntry {
  const e = REGISTRY.find((p) => p.invoke === invoke && p.configured);
  if (!e) throw new Error(`no configured entry for ${invoke}`);
  return e;
}

describe("normalizeLegacyImageRequest — runpy_image → flux2/krea2 field/command translation", () => {
  it("passes non-legacy commands through unchanged", () => {
    const r = normalizeLegacyImageRequest(imgReq);
    expect(r).toEqual(imgReq);
  });

  it("angle: maps legacy inputImage → input, keeps command", () => {
    const r = normalizeLegacyImageRequest({
      capability: "image_generation",
      command: "angle",
      options: { inputImage: "/a.png", prompt: "front view" },
    });
    expect(r.command).toBe("angle");
    expect(r.options).toMatchObject({ input: "/a.png", prompt: "front view" });
  });

  it("swap: maps legacy inputImage → source, keeps reference/prompt as-is", () => {
    const r = normalizeLegacyImageRequest({
      capability: "image_generation",
      command: "swap",
      options: { inputImage: "/src.png", reference: "/ref.png", prompt: "the hat" },
    });
    expect(r.command).toBe("swap");
    expect(r.options).toMatchObject({ source: "/src.png", reference: "/ref.png", prompt: "the hat" });
  });

  it("i2i: maps legacy inputImage/denoiseStrength → input/strength", () => {
    const r = normalizeLegacyImageRequest({
      capability: "image_generation",
      command: "i2i",
      options: { inputImage: "/a.png", denoiseStrength: 0.6 },
    });
    expect(r.command).toBe("i2i");
    expect(r.options).toMatchObject({ input: "/a.png", strength: 0.6 });
  });

  it("anime2real: renames command to style, injects preset, maps input", () => {
    const r = normalizeLegacyImageRequest({
      capability: "image_generation",
      command: "anime2real",
      options: { inputImage: "/a.png" },
    });
    expect(r.command).toBe("style");
    expect(r.options).toMatchObject({ preset: "anime2real", input: "/a.png" });
  });

  it("expansion: renames command to expand, maps input", () => {
    const r = normalizeLegacyImageRequest({
      capability: "image_generation",
      command: "expansion",
      options: { inputImage: "/a.png", prompt: "extend the sky" },
    });
    expect(r.command).toBe("expand");
    expect(r.options).toMatchObject({ input: "/a.png", prompt: "extend the sky" });
  });

  it("restore: renames command to i2i, maps legacy inputImage/denoiseStrength → input/strength", () => {
    const r = normalizeLegacyImageRequest({
      capability: "image_generation",
      command: "restore",
      options: { inputImage: "/frame.png", denoiseStrength: 0.35, prompt: "sharp eyes, detailed face" },
    });
    expect(r.command).toBe("i2i");
    expect(r.options).toMatchObject({ input: "/frame.png", strength: 0.35, prompt: "sharp eyes, detailed face" });
  });

  it("inpaint: maps legacy inputImage/referenceImage → input/reference, keeps mask/prompt as-is", () => {
    const r = normalizeLegacyImageRequest({
      capability: "image_generation",
      command: "inpaint",
      options: { inputImage: "/src.png", referenceImage: "/ref.png", mask: "/mask.png", prompt: "clear sky" },
    });
    expect(r.command).toBe("inpaint");
    expect(r.options).toMatchObject({
      input: "/src.png", reference: "/ref.png", mask: "/mask.png", prompt: "clear sky",
    });
  });

  it("faceswap: maps legacy input/loraPath → body/lora, keeps face/mode/prompt as-is", () => {
    const r = normalizeLegacyImageRequest({
      capability: "image_generation",
      command: "faceswap",
      options: { input: "/body.png", face: "/face.png", mode: "head", loraPath: "bfs-head-v1-klein-9b" },
    });
    expect(r.command).toBe("faceswap");
    expect(r.options).toMatchObject({
      body: "/body.png", face: "/face.png", mode: "head", lora: "bfs-head-v1-klein-9b",
    });
  });

  it("faceswap: native body/lora field names pass through unchanged", () => {
    const r = normalizeLegacyImageRequest({
      capability: "image_generation",
      command: "faceswap",
      options: { body: "/body.png", face: "/face.png", lora: "bfs-head-v1-klein-9b" },
    });
    expect(r.options).toMatchObject({ body: "/body.png", face: "/face.png", lora: "bfs-head-v1-klein-9b" });
  });

  it("enhancement:upscale: maps legacy esrgan `image` field → flux2 `input`", () => {
    const r = normalizeLegacyImageRequest({
      capability: "enhancement",
      command: "upscale",
      options: { image: "/a.png", model: "4xNomosWebPhoto_RealPLKSR.pth" },
    });
    expect(r.command).toBe("upscale");
    expect(r.options).toMatchObject({ input: "/a.png" });
  });

  it("does not touch non-image_generation capabilities even with a matching command name", () => {
    const req: GenerateRequest = { capability: "tts", command: "swap", options: { text: "hi" } };
    expect(normalizeLegacyImageRequest(req)).toEqual(req);
  });
});

describe("isNativeControlNetRequest — controlnet native/python fork", () => {
  // 2026-07-13 session 3: swift/krea2-image-director's Krea2ControlNet.swift
  // does zero preprocessing of its own (control image must already be a
  // depth/pose/edge map), so the native path only fires when the caller
  // supplies the native `controlImage` field AND no Python-only
  // preprocessing knob is requested. See bridge.ts's realControlNet +
  // registry.ts's controlnet_hybrid entry for the full rationale.
  it("false when the request has no native `controlImage` field (legacy run.py shape)", () => {
    expect(isNativeControlNetRequest({ inputImage: "/ref.png", controlnetType: "canny" })).toBe(false);
    expect(isNativeControlNetRequest({})).toBe(false);
  });

  it("true when controlImage is set and no Python-only preprocessing knob is requested", () => {
    expect(isNativeControlNetRequest({ controlImage: "/depth.png" })).toBe(true);
    expect(isNativeControlNetRequest({ controlImage: "/depth.png", controlnetType: "raw" })).toBe(true);
    expect(isNativeControlNetRequest({ controlImage: "/depth.png", controlnetType: "depth" })).toBe(true);
  });

  it("false when controlnetType needs Python's built-in preprocessing (canny/scribble/pose/hed)", () => {
    for (const ctype of ["canny", "scribble", "pose", "hed"]) {
      expect(isNativeControlNetRequest({ controlImage: "/depth.png", controlnetType: ctype })).toBe(false);
    }
  });

  it("false when a Python-only preprocessing knob is set even with controlImage present", () => {
    expect(isNativeControlNetRequest({ controlImage: "/depth.png", blurRef: 5 })).toBe(false);
    expect(isNativeControlNetRequest({ controlImage: "/depth.png", removeOutlines: true })).toBe(false);
    expect(isNativeControlNetRequest({ controlImage: "/depth.png", controlnetAbTest: true })).toBe(false);
  });
});

describe("isNativeWorkflowRequest — workflow native/python fork", () => {
  // 2026-07-14 session 7: only base-gen + ESRGAN-upscale are genuinely
  // portable (see workflow_native.ts's module doc); post-process/
  // seedvr2-upscale must still fall back to run.py's image-workflow.py.
  // 2026-08-02: face-detail is now native too (Task 6 of the face-detail
  // Swift-native port plan) — see isNativeWorkflowRequest's doc comment.
  it("true for a bare base-gen request (no non-portable knobs)", () => {
    expect(isNativeWorkflowRequest({ prompt: "a cat" })).toBe(true);
    expect(isNativeWorkflowRequest({ prompt: "a cat", upscale: true })).toBe(true);
    expect(isNativeWorkflowRequest({ prompt: "a cat", upscale: true, upscaleMethod: "esrgan" })).toBe(true);
  });

  it("true when face_detail is requested — now native (camelCase or snake_case)", () => {
    expect(isNativeWorkflowRequest({ prompt: "x", faceDetail: true })).toBe(true);
    expect(isNativeWorkflowRequest({ prompt: "x", face_detail: true })).toBe(true);
  });

  it("true when film_grain/sharpening/skin_contrast/noise_clean are requested — now native", () => {
    expect(isNativeWorkflowRequest({ film_grain: 0.02 })).toBe(true);
    expect(isNativeWorkflowRequest({ sharpening: 0.1 })).toBe(true);
    expect(isNativeWorkflowRequest({ skin_contrast: true })).toBe(true);
    expect(isNativeWorkflowRequest({ noise_clean: true })).toBe(true);
  });

  it("false when a LUT knob is requested — still falls back", () => {
    expect(isNativeWorkflowRequest({ lut: "models/lut/NaturalBoost.cube" })).toBe(false);
    expect(isNativeWorkflowRequest({ lutPath: "x.cube" })).toBe(false);
    expect(isNativeWorkflowRequest({}, ["--lut", "x.cube"])).toBe(false);
  });

  it("false for zero-valued filters is NOT triggered (0/false means off, matches Python's _has_post_processing)", () => {
    expect(isNativeWorkflowRequest({ prompt: "x", filmGrain: 0, sharpening: 0, faceDetail: false })).toBe(true);
  });

  it("false when upscale_method is seedvr2 (camelCase or snake_case)", () => {
    expect(isNativeWorkflowRequest({ prompt: "x", upscale: true, upscaleMethod: "seedvr2" })).toBe(false);
    expect(isNativeWorkflowRequest({ prompt: "x", upscale: true, upscale_method: "seedvr2" })).toBe(false);
  });

  it("false when a non-portable flag rides in extraArgs (runpy_image.ts's raw-token escape hatch)", () => {
    expect(isNativeWorkflowRequest({ prompt: "x" }, ["--lut", "/foo.cube"])).toBe(false);
    expect(isNativeWorkflowRequest({ prompt: "x" }, ["--upscale-method", "seedvr2"])).toBe(false);
  });

  it("true when extraArgs carries only portable tokens (including --face-detail and post-process flags, now native)", () => {
    expect(isNativeWorkflowRequest({ prompt: "x" }, ["--upscale-method", "esrgan"])).toBe(true);
    expect(isNativeWorkflowRequest({ prompt: "x" }, ["--face-detail"])).toBe(true);
    expect(isNativeWorkflowRequest({ prompt: "x" }, ["--film-grain", "0.02"])).toBe(true);
    expect(isNativeWorkflowRequest({ prompt: "x" }, ["--sharpening", "0.1"])).toBe(true);
    expect(isNativeWorkflowRequest({ prompt: "x" }, ["--skin-contrast"])).toBe(true);
    expect(isNativeWorkflowRequest({ prompt: "x" }, ["--noise-clean"])).toBe(true);
  });
});

describe("isNativePurifyRequest — purify native/python fork", () => {
  // Native path only serves --backend transformer with a .png input and no
  // --remove request. Everything else (default seedvr2, --remove, non-PNG
  // input) falls back to run.py, unchanged from before this port.
  it("false when backend is unset or seedvr2 (the Python default, untouched)", () => {
    expect(isNativePurifyRequest({ inputImage: "/a.png" })).toBe(false);
    expect(isNativePurifyRequest({ inputImage: "/a.png", backend: "seedvr2" })).toBe(false);
  });

  it("true for backend=transformer with a .png input and no remove", () => {
    expect(isNativePurifyRequest({ inputImage: "/a.png", backend: "transformer" })).toBe(true);
    expect(isNativePurifyRequest({ inputImage: "/a.PNG", backend: "transformer" })).toBe(true);
    expect(isNativePurifyRequest({ inputImage: "/a.png", backend: "transformer", remove: "none" })).toBe(true);
  });

  it("false when remove is requested (--remove stays on Python — not ported)", () => {
    expect(isNativePurifyRequest({ inputImage: "/a.png", backend: "transformer", remove: "subtitle" })).toBe(false);
    expect(isNativePurifyRequest({ inputImage: "/a.png", backend: "transformer", remove: "watermark" })).toBe(false);
  });

  it("false for a non-PNG input (probePngDimensions can't read it — falls back to Python, which opens any format)", () => {
    expect(isNativePurifyRequest({ inputImage: "/a.jpg", backend: "transformer" })).toBe(false);
    expect(isNativePurifyRequest({ inputImage: "/a", backend: "transformer" })).toBe(false);
  });

  it("false when inputImage is missing entirely", () => {
    expect(isNativePurifyRequest({ backend: "transformer" })).toBe(false);
  });
});

describe("adaptKrea2 — contract parse (Details → ToolResult)", () => {
  it("maps a successful krea2 run", () => {
    const details: Krea2Details = {
      ok: true,
      command: "t2i",
      exitCode: 0,
      aborted: false,
      output: "/out/cat.png",
      outputs: [
        { path: "/out/cat.png", seed: 42, width: 512, height: 512, sizeBytes: 12345 },
      ],
      seed: 42,
      width: 512,
      height: 512,
    };
    const r = adaptKrea2(imgReq, details, "t2i ok → /out/cat.png", "");
    expect(r.success).toBe(true);
    expect(r.provider).toBe("krea2");
    expect(r.command).toBe("t2i");
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]).toMatchObject({ path: "/out/cat.png", kind: "image", seed: 42, bytes: 12345 });
    expect(r.error).toBeNull();
    expect(r.seed).toBe(42);
    expect(r.model).toBe("krea2"); // no transformer in options → provider fallback
    expect(r.duration_seconds).toBeNull(); // krea2 reports none; generate() fills it
  });

  it("maps a failed krea2 run with error text", () => {
    const details: Krea2Details = {
      ok: false,
      command: "t2i",
      exitCode: 1,
      aborted: false,
      output: null,
      outputs: [],
      seed: 42,
      width: null,
      height: null,
    };
    const r = adaptKrea2(imgReq, details, "t2i FAILED (exit 1).", "boom");
    expect(r.success).toBe(false);
    expect(r.artifacts).toEqual([]);
    expect(r.error).toContain("FAILED");
    expect(r.error).toContain("boom");
    expect(r.cost_usd).toBe(0); // no cost on failure
  });
});

describe("adaptFlux2 — contract parse", () => {
  it("uses perf.totalSeconds for duration + cost", () => {
    const details: Flux2Details = {
      ok: true,
      command: "t2i",
      exitCode: 0,
      aborted: false,
      output: "/out/x.png",
      outputs: [{ path: "/out/x.png", seed: 7, width: 1024, height: 1024, sizeBytes: 99 }],
      seed: 7,
      width: 1024,
      height: 1024,
      gate: "PASS",
      perf: { steps: 4, totalSeconds: 3.5, avgItPerSec: 1.1, peakMemoryMB: 8000 },
      manifestPath: "/out/x.manifest.json",
      runJsonPath: null,
    };
    const r = adaptFlux2({ ...imgReq, options: { ...imgReq.options, transformer: "flux2-klein" } }, details, "ok", "");
    expect(r.duration_seconds).toBe(3.5);
    expect(r.success).toBe(true);
    expect(r.model).toBe("flux2-klein"); // transformer surfaced as model
    expect(r.seed).toBe(7);
    // default tariff image_usd = 0 → cost 0 (honest for local silicon)
    expect(r.cost_usd).toBe(0);
  });
});

describe("adaptLtx — contract parse", () => {
  it("maps native-i2v primary video + named secondaries (audio/frames)", () => {
    const details: LtxDetails = {
      ok: true,
      command: "native-i2v",
      exitCode: 0,
      aborted: false,
      output: "/out/v.mp4",
      extraOutputs: { audio: "/out/audio.wav", upscaledFrames: "/out/frames" },
      width: 768,
      height: 768,
      wallSeconds: 12.0,
      gate: null,
      stdout: "ok",
    };
    const r = adaptLtx(
      { capability: "video_generation", command: "native-i2v", options: { seed: 100 } },
      details,
      "ok",
      "",
    );
    expect(r.success).toBe(true);
    expect(r.provider).toBe("ltx");
    expect(r.duration_seconds).toBe(12.0);
    expect(r.seed).toBe(100);
    // primary + 2 secondaries
    expect(r.artifacts).toHaveLength(3);
    const kinds = r.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(["audio", "frames", "video"]);
    const paths = r.artifacts.map((a) => a.path);
    expect(paths).toContain("/out/v.mp4");
    expect(paths).toContain("/out/audio.wav");
    expect(paths).toContain("/out/frames");
  });

  it("native-relay: segment_N extraOutputs surface as kind:video artifacts", () => {
    const details: LtxDetails = {
      ok: true, command: "native-relay", exitCode: 0, aborted: false,
      output: "/tmp/relay/relay.mp4",
      extraOutputs: { segment_1: "/tmp/relay/seg01/segment.mp4", segment_2: "/tmp/relay/seg02/segment.mp4" },
      width: 640, height: 960, wallSeconds: 42.1, gate: null, stdout: "",
    };
    const r = adaptLtx({ capability: "video_generation", command: "native-relay", options: {} }, details, "ok", "");
    const seg1 = r.artifacts.find((a) => a.role === "segment_1");
    const seg2 = r.artifacts.find((a) => a.role === "segment_2");
    expect(seg1).toMatchObject({ path: "/tmp/relay/seg01/segment.mp4", kind: "video" });
    expect(seg2).toMatchObject({ path: "/tmp/relay/seg02/segment.mp4", kind: "video" });
  });
});

describe("adaptRunPy — run.py video adapter contract (Details → ToolResult)", () => {
  it("maps a successful t2i2v run to one video artifact + local i2v model", () => {
    const details: RunPyVideoDetails = {
      ok: true,
      command: "video t2i2v",
      exitCode: 0,
      aborted: false,
      output: "/out/t2i2v_run/final.mp4",
      manifest: { pipeline: "t2i2v", output_dir: "/out/t2i2v_run" },
      outDir: "/out/t2i2v_run",
      model: "dasiwa",
      stdout: "[t2i2v] ✓ Done",
      exitOk: true,
      mp4Exists: true,
    };
    const r = adaptRunPy(
      { capability: "video_generation", command: "t2i2v", options: { seed: 7 } },
      details,
      "video t2i2v: ✓ /out/t2i2v_run/final.mp4 [dasiwa]",
      "",
    );
    expect(r.success).toBe(true);
    expect(r.provider).toBe("ltx-runpy");
    expect(r.command).toBe("video t2i2v");
    expect(r.seed).toBe(7);
    // model from the manifest's i2v stage — local silicon, NEVER a cloud id.
    expect(r.model).toBe("dasiwa");
    expect(r.artifacts).toEqual([
      { path: "/out/t2i2v_run/final.mp4", kind: "video", role: "primary" },
    ]);
  });

  it("flags failure + no artifact when run.py produced no mp4", () => {
    const details: RunPyVideoDetails = {
      ok: false,
      command: "video t2i2v",
      exitCode: 2,
      aborted: false,
      output: null,
      manifest: null,
      outDir: null,
      model: null,
      stdout: "[t2i2v] ERROR",
      exitOk: false,
      mp4Exists: false,
    };
    const r = adaptRunPy({ capability: "video_generation", command: "t2i2v", options: {} }, details, "exited 2", "boom");
    expect(r.success).toBe(false);
    expect(r.artifacts).toEqual([]);
    expect(r.error).toContain("exited 2");
    // Falls back to a local label so the result never reads as a cloud model id.
    expect(r.model).toBe("run.py:t2i2v");
  });
});

describe("adaptCaption — run.py caption adapter contract (Details → ToolResult)", () => {
  it("maps a successful caption run to one text artifact + the resolved gemma model", () => {
    const details = {
      ok: true,
      command: "caption" as const,
      exitCode: 0,
      aborted: false,
      captionPath: "/out/img.png.caption.json",
      model: "prism-ml/bonsai-27b",
      styles: ["score"],
      text: '{"overall": 7, "issues": ["oversmoothed skin"]}',
      stdout: "[caption] done",
    };
    const r = adaptCaption(
      { capability: "analysis", command: "caption", options: { image: "/out/img.png", style: "score" } },
      details,
      "caption ✓ score → /out/img.png.caption.json [bonsai-27b]",
      "",
    );
    expect(r.success).toBe(true);
    expect(r.provider).toBe("caption-vlm");
    expect(r.command).toBe("caption");
    expect(r.seed).toBeNull();
    // model from the caption JSON — the local gemma brain, NEVER a cloud id.
    expect(r.model).toBe("prism-ml/bonsai-27b");
    expect(r.cost_usd).toBe(0); // local silicon analysis — honest $0
    expect(r.artifacts).toEqual([
      { path: "/out/img.png.caption.json", kind: "text", role: "caption" },
    ]);
  });

  it("flags failure + no artifact when run.py wrote no caption JSON", () => {
    const details = {
      ok: false,
      command: "caption" as const,
      exitCode: 0,
      aborted: false,
      captionPath: null,
      model: null,
      styles: [],
      text: null,
      stdout: "",
    };
    const r = adaptCaption(
      { capability: "analysis", command: "caption", options: {} },
      details,
      "caption FAILED (exit 0, no json)",
      "model not loaded",
    );
    expect(r.success).toBe(false);
    expect(r.artifacts).toEqual([]);
    expect(r.error).toContain("FAILED");
    expect(r.model).toBe("run.py:caption"); // local fallback label, never a cloud id
    expect(r.cost_usd).toBe(0); // no cost on failure
  });
});

describe("analysis selector — caption command resolves to mlx:caption (the local VLM tier)", () => {
  // The explicit replacement for OM's "orchestrator-LLM-is-the-vision-model"
  // assumption: a caller addressing {analysis, caption} must reach the local
  // run.py→gemma path, not whisper/clip (which own transcribe/video_understand).
  it("registry carries the caption_vlm provider under mlx:caption", () => {
    const e = REGISTRY.find((p) => p.invoke === "mlx:caption")!;
    expect(e).toBeTruthy();
    expect(e.capability).toBe("analysis");
    expect(e.commands).toEqual(["caption"]);
    expect(e.configured).toBe(true);
  });

  // Machine-coupled: selectProvider() needs the caption_vlm probe (local MLX
  // venv) to pass. GitHub Actions runners have no venv → NoConfiguredProviderError.
  // Skip under CI=true. See .github/CI.md. (The registry + probe-tracking tests
  // above/below are pure and still run in CI.)
  it.skipIf(!!process.env.CI || !VENV_PRESENT)("selectProvider({command:'caption'}) picks mlx:caption for the analysis capability", () => {
    const entry = selectProvider("analysis", { command: "caption" });
    expect(entry.invoke).toBe("mlx:caption");
    expect(entry.provider).toBe("caption-vlm");
  });

  // mlx:caption stopped sharing mlx:runpy's venv+run.py signal on 2026-07-19
  // (caption_native.ts ports straight to LM Studio, zero run.py) — its probe
  // now tracks LM Studio reachability instead. Pinned via the deterministic
  // test hook (mirrors providers.test.ts) rather than machine-coupled to
  // mlx:runpy, since the two probes are intentionally independent signals.
  it("mlx:caption probe tracks LM Studio reachability (Bun-native since the 2026-07-19 port, no run.py)", () => {
    const e = REGISTRY.find((p) => p.invoke === "mlx:caption")!;
    try {
      _setLmStudioReachableForTest(true);
      expect(probeConfigured(e)).toBe(true);
      _setLmStudioReachableForTest(false);
      expect(probeConfigured(e)).toBe(false);
    } finally {
      _setLmStudioReachableForTest(undefined);
    }
  });
});

describe("video_generation selector — swift:ltx vs mlx:runpy presence tiebreak", () => {
  // Regression for Option A: when the swift:ltx binary is unbuilt, the selector
  // MUST fall through to the run.py adapter (mlx:runpy) rather than picking an
  // unbuilt binary. Both are native_swift rank 0 — the binary's presence on disk
  // is the only honest tiebreak (probeConfigured, not a hardcoded configured flag).
  const ltxEntry = REGISTRY.find((p) => p.invoke === "swift:ltx")!;
  const runpyEntry = REGISTRY.find((p) => p.invoke === "mlx:runpy")!;

  it("registry carries BOTH video_generation providers", () => {
    expect(ltxEntry).toBeTruthy();
    expect(runpyEntry).toBeTruthy();
    expect(runpyEntry.capability).toBe("video_generation");
    expect(runpyEntry.backend).toBe("native_swift");
  });

  // Machine-coupled: hard-asserts the local venv+run.py probe is true; on CI
  // (no venv) the probe is false. Skip under CI=true. See .github/CI.md.
  it.skipIf(!!process.env.CI || !VENV_PRESENT)("swift:ltx probe tracks the built binary; mlx:runpy probe tracks the venv+run.py", () => {
    // Sanity: probeConfigured is the runtime truth, not the static configured flag.
    expect(probeConfigured(runpyEntry)).toBe(true); // venv + run.py present on this machine
    // swift:ltx is callable iff the binary exists — assert the probe AGREES with the disk.
    // Use resolveRepoRoot() (NOT process.cwd()): under `bun test --cwd <pkg>` the cwd is
    // the PACKAGE dir, so defaultBinaryPath(cwd) would point under <pkg>/swift/… and always
    // read false — silently agreeing with probeConfigured only when the binary is absent.
    // resolveRepoRoot() is exactly what probeConfigured/ltxBinaryPresent() uses.
    const repoRoot = resolveRepoRoot();
    expect(probeConfigured(ltxEntry)).toBe(existsSync(defaultBinaryPath(repoRoot)));
  });

  // Machine-coupled: with neither a built swift:ltx binary NOR the venv-backed
  // mlx:runpy (the CI reality), selectProvider('video_generation') throws.
  // Skip under CI=true. See .github/CI.md.
  it.skipIf(!!process.env.CI || !VENV_PRESENT)("selects mlx:runpy when the swift:ltx binary is absent (the local-machine truth)", () => {
    if (existsSync(defaultBinaryPath(resolveRepoRoot()))) {
      // Binary present on this machine → swift:ltx wins (rank 0, declared first).
      expect(selectProvider("video_generation").invoke).toBe("swift:ltx");
    } else {
      // Binary absent → mlx:runpy wins (the Option-A fallback, zero swift build).
      expect(selectProvider("video_generation").invoke).toBe("mlx:runpy");
      const ranked = rankedProviders("video_generation");
      expect(ranked[0]!.invoke).toBe("mlx:runpy");
    }
  });
});

describe("tariffFor", () => {
  it("defaults to 0 for local silicon, overridable via env", () => {
    expect(tariffFor()).toEqual({ image_usd: 0, video_per_sec_usd: 0 });
    expect(tariffFor({ MD_TARIFF_IMAGE_USD: "0.002" }).image_usd).toBe(0.002);
    // junk ignored → default
    expect(tariffFor({ MD_TARIFF_IMAGE_USD: "not-a-number" }).image_usd).toBe(0);
    expect(tariffFor({ MD_TARIFF_VIDEO_PER_SEC_USD: "0.01" }).video_per_sec_usd).toBe(0.01);
  });
});

describe("generate", () => {
  it("fills duration_seconds from measured wall time when the adapter reports null (krea2)", async () => {
    let t = 1000;
    const canned: ToolResult = {
      success: true,
      provider: "krea2",
      command: "t2i",
      artifacts: [{ path: "/out/cat.png", kind: "image" }],
      error: null,
      cost_usd: 0,
      duration_seconds: null, // adapter didn't report → must be filled
      seed: 42,
      model: "krea2",
    };
    const adapters = { "swift:krea2": (async () => canned) as Adapter };
    const r = await generate(entryFor("swift:krea2"), imgReq, {
      adapters,
      now: () => {
        // first call (start) returns 1000, second (end) returns 2500 → 1.5s
        t += 1500;
        return t;
      },
    });
    expect(r.duration_seconds).toBe(1.5);
    expect(r.success).toBe(true);
  });

  it("returns a structured ToolResult failure (does NOT throw) when invoke has no adapter", async () => {
    // compose_ffmpeg is configured but has no adapter wired in this iter.
    const e = REGISTRY.find((p) => p.name === "compose_ffmpeg")!;
    const r = await generate(e, { capability: "composition", command: "concat" }, { adapters: {} });
    expect(r.success).toBe(false);
    expect(r.error).toContain('no bridge implemented for invoke "ffmpeg"');
    expect(r.artifacts).toEqual([]);
  });

  it("catches a throwing adapter into a failure ToolResult", async () => {
    const adapters = {
      "swift:krea2": (async () => {
        throw new Error("binary blew up");
      }) as Adapter,
    };
    const r = await generate(entryFor("swift:krea2"), imgReq, { adapters });
    expect(r.success).toBe(false);
    expect(r.error).toBe("binary blew up");
    expect(r.provider).toBe("krea2");
  });
});

describe("missingRequiredOptions — per-capability required-options preflight", () => {
  it("flags image_generation with no command and no options.prompt", () => {
    expect(missingRequiredOptions({ capability: "image_generation", command: "", options: {} })).toEqual(["prompt"]);
  });

  it("flags image_generation:t2i missing options.prompt", () => {
    expect(missingRequiredOptions({ capability: "image_generation", command: "t2i", options: { seed: 1 } })).toEqual(["prompt"]);
  });

  it("passes image_generation:t2i with options.prompt present", () => {
    expect(missingRequiredOptions({ capability: "image_generation", command: "t2i", options: { prompt: "a cat" } })).toEqual([]);
  });

  it("does not check named commands with no declared requirement (e.g. faceswap)", () => {
    expect(missingRequiredOptions({ capability: "image_generation", command: "faceswap", options: {} })).toEqual([]);
  });
});

describe("generate — required-options preflight fails fast (no adapter invocation, no subprocess spawn)", () => {
  it("returns success:false synchronously for image_generation missing options.prompt, without calling the adapter", async () => {
    let adapterCalled = false;
    const adapters = {
      "swift:krea2": (async () => {
        adapterCalled = true;
        return {
          success: true,
          provider: "krea2",
          command: "t2i",
          artifacts: [],
          error: null,
          cost_usd: 0,
          duration_seconds: 0,
          seed: null,
          model: "krea2",
        } as ToolResult;
      }) as Adapter,
    };
    const r = await generate(
      entryFor("swift:krea2"),
      { capability: "image_generation", command: "t2i", options: {} },
      { adapters, now: () => 1000 },
    );
    expect(adapterCalled).toBe(false);
    expect(r.success).toBe(false);
    expect(r.error).toBe("image_generation requires options.prompt");
    expect(r.artifacts).toEqual([]);
    expect(r.duration_seconds).toBe(0); // near-zero — measured from the same `now()` call
  });
});

describe("selectAndGenerate — selector + bridge integration (mocked)", () => {
  it("selects the configured native provider and runs the injected adapter", async () => {
    const canned: ToolResult = {
      success: true,
      provider: "flux2",
      command: "t2i",
      artifacts: [{ path: "/out/x.png", kind: "image" }],
      error: null,
      cost_usd: 0,
      duration_seconds: 2,
      seed: 1,
      model: "flux2-klein",
    };
    const { entry, result } = await selectAndGenerate(
      "image_generation",
      { command: "t2i", options: { prompt: "x" } },
      { provider: "flux2" },
      { adapters: { "swift:flux2": (async () => canned) as Adapter } },
    );
    expect(entry.provider).toBe("flux2");
    expect(result).toBe(canned);
  });

  it("selects the local MusicGen provider for music_generation", () => {
    // 2026-07-26: recovered from an orphaned branch — music_generation now has
    // a registered provider (musicgen_music).
    // 2026-07-28: invoke moved off mlx:runpy-music (venv-gated) onto
    // bun:musicgen-native (the compiled swift/musicgen-director binary).
    // probeConfigured has an explicit binary-presence check for this invoke
    // (mirrors swift:ltx/krea2/flux2, added after a code-review found the
    // fallthrough-to-default case would make this test machine-coupled to
    // whether musicgen-director happened to be built locally) — pinned via
    // the deterministic test hook so this runs everywhere, same as the
    // mlx:caption/LM-Studio test above.
    try {
      _setMusicgenBinaryForTest(true);
      const entry = selectProvider("music_generation");
      expect(entry.provider).toBe("musicgen");
      expect(entry.invoke).toBe("bun:musicgen-native");
    } finally {
      _setMusicgenBinaryForTest(undefined);
    }
  });
});

describe("selectAndGenerate — tts quality-first chain (kokoro → edge-tts → say)", () => {
  const sayOk: ToolResult = {
    success: true, provider: "say", command: "narrate", artifacts: [{ path: "/out/say.aiff", kind: "audio" }],
    error: null, cost_usd: 0, duration_seconds: 1, seed: null, model: "say",
  };
  const edgeOk: ToolResult = {
    success: true, provider: "edge-tts", command: "narrate", artifacts: [{ path: "/out/edge.mp3", kind: "audio" }],
    error: null, cost_usd: 0, duration_seconds: 1, seed: null, model: "edge-tts",
  };
  const edgeFail: ToolResult = {
    success: false, provider: "edge-tts", command: "narrate", artifacts: [],
    error: "network unreachable", cost_usd: 0, duration_seconds: 1, seed: null, model: "edge-tts",
  };
  const kokoroOk: ToolResult = {
    success: true, provider: "kokoro", command: "narrate", artifacts: [{ path: "/out/kokoro.wav", kind: "audio" }],
    error: null, cost_usd: 0, duration_seconds: 1, seed: null, model: "kokoro",
  };
  const kokoroFail: ToolResult = {
    success: false, provider: "kokoro", command: "narrate", artifacts: [],
    error: "binary not built", cost_usd: 0, duration_seconds: 1, seed: null, model: "kokoro",
  };

  // 2026-08-21: kokoro (local Swift MLX) is the bare-tts default; a missing
  // adapter in the test deps is a runtime failure, so chains without a
  // "bun:kokoro-tts" adapter exercise the downstream fallbacks exactly like a
  // real kokoro failure does.
  it("no provider hint → tries kokoro first and uses it on success (edge/say never run)", async () => {
    let edgeCalled = false;
    let sayCalled = false;
    const { entry, result } = await selectAndGenerate(
      "tts",
      { command: "narrate", options: { text: "hello" } },
      {},
      {
        adapters: {
          "bun:kokoro-tts": (async () => kokoroOk) as Adapter,
          "bun:tts-native": (async () => { edgeCalled = true; return edgeOk; }) as Adapter,
          "macos:say": (async () => { sayCalled = true; return sayOk; }) as Adapter,
        },
      },
    );
    expect(entry.provider).toBe("kokoro");
    expect(result).toBe(kokoroOk);
    expect(edgeCalled).toBe(false);
    expect(sayCalled).toBe(false);
  });

  it("kokoro fails at runtime (e.g. binary not built) → falls back to edge-tts", async () => {
    let sayCalled = false;
    const { entry, result } = await selectAndGenerate(
      "tts",
      { command: "narrate", options: { text: "hello" } },
      {},
      {
        adapters: {
          "bun:kokoro-tts": (async () => kokoroFail) as Adapter,
          "bun:tts-native": (async () => edgeOk) as Adapter,
          "macos:say": (async () => { sayCalled = true; return sayOk; }) as Adapter,
        },
      },
    );
    expect(entry.provider).toBe("edge-tts");
    expect(result).toBe(edgeOk);
    expect(sayCalled).toBe(false);
  });

  it("kokoro + edge-tts both fail → falls back to the say result", async () => {
    const { entry, result } = await selectAndGenerate(
      "tts",
      { command: "narrate", options: { text: "hello" } },
      {},
      {
        adapters: {
          "bun:kokoro-tts": (async () => kokoroFail) as Adapter,
          "bun:tts-native": (async () => edgeFail) as Adapter,
          "macos:say": (async () => sayOk) as Adapter,
        },
      },
    );
    expect(entry.provider).toBe("say");
    expect(result).toBe(sayOk);
  });

  it("no kokoro adapter wired (treated as failure) → edge-tts result (legacy deps shape)", async () => {
    let sayCalled = false;
    const { entry, result } = await selectAndGenerate(
      "tts",
      { command: "narrate", options: { text: "hello" } },
      {},
      {
        adapters: {
          "bun:tts-native": (async () => edgeOk) as Adapter,
          "macos:say": (async () => { sayCalled = true; return sayOk; }) as Adapter,
        },
      },
    );
    expect(entry.provider).toBe("edge-tts");
    expect(result).toBe(edgeOk);
    expect(sayCalled).toBe(false); // edge succeeded — say's adapter must never run
  });

  it("explicit provider:\"say\" hint bypasses the edge-tts-first upgrade entirely", async () => {
    let edgeCalled = false;
    const { entry, result } = await selectAndGenerate(
      "tts",
      { command: "narrate", options: { text: "hello" } },
      { provider: "say" },
      {
        adapters: {
          "bun:tts-native": (async () => { edgeCalled = true; return edgeOk; }) as Adapter,
          "macos:say": (async () => sayOk) as Adapter,
        },
      },
    );
    expect(entry.provider).toBe("say");
    expect(result).toBe(sayOk);
    expect(edgeCalled).toBe(false);
  });
});

describe("adaptKokoroTts — local Kokoro-82M adapter contract (Details → ToolResult)", () => {
  it("maps a successful generation to one audio artifact with provider:'kokoro'", () => {
    const details = {
      ok: true,
      command: "tts" as const,
      exitCode: 0,
      aborted: false,
      output: "/out/tts_kokoro.wav",
      sizeBytes: 48000,
      voice: "af_heart",
      stdout: "[kokoro-tts generate] done -> /out/tts_kokoro.wav (48000 bytes)",
    };
    const r = adaptKokoroTts(
      { capability: "tts", command: "tts", options: { text: "Hello.", voice: "af_heart" } },
      details,
      "kokoro ✓ af_heart (Swift native, local) → /out/tts_kokoro.wav",
      "",
    );
    expect(r.success).toBe(true);
    expect(r.provider).toBe("kokoro");
    expect(r.command).toBe("tts");
    expect(r.seed).toBeNull();
    expect(r.model).toBe("af_heart");
    expect(r.cost_usd).toBe(0); // fully local — honest $0 marginal cost
    expect(r.artifacts).toEqual([
      { path: "/out/tts_kokoro.wav", kind: "audio", role: "primary", bytes: 48000 },
    ]);
  });

  it("flags failure + no artifact when the binary wrote no audio file", () => {
    const details = {
      ok: false,
      command: "tts" as const,
      exitCode: 1,
      aborted: false,
      output: null,
      sizeBytes: null,
      voice: null,
      stdout: "",
    };
    const r = adaptKokoroTts(
      { capability: "tts", command: "tts", options: { text: "x", voice: "zf_xiaobei" } },
      details,
      "kokoro tts FAILED (exit 1)",
      "ERROR: could not resolve repo",
    );
    expect(r.success).toBe(false);
    expect(r.artifacts).toEqual([]);
    expect(r.error).toContain("FAILED");
    expect(r.model).toBe("kokoro-82m"); // local fallback label when voice is unknown
    expect(r.cost_usd).toBe(0); // no cost on failure
  });
});
