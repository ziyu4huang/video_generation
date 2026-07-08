import { describe, expect, it } from "bun:test";
import {
  adaptKrea2,
  adaptFlux2,
  adaptLtx,
  adaptRunPy,
  adaptCaption,
  generate,
  selectAndGenerate,
  tariffFor,
  type ToolResult,
  type GenerateRequest,
  type Adapter,
} from "./bridge.ts";
import { selectProvider, rankedProviders } from "./selector.ts";
import { REGISTRY, type ProviderEntry } from "./registry.ts";
import { probeConfigured } from "./providers.ts";
import { defaultBinaryPath, resolveRepoRoot } from "@repo/pi-agent-ext-ltx";
import { existsSync } from "node:fs";
import type { Krea2Details } from "@repo/pi-agent-ext-krea2";
import type { Flux2Details } from "@repo/pi-agent-ext-flux2";
import type { LtxDetails, RunPyVideoDetails } from "@repo/pi-agent-ext-ltx";

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
      model: "google/gemma-4-26b-a4b-qat",
      styles: ["score"],
      text: '{"overall": 7, "issues": ["oversmoothed skin"]}',
      stdout: "[caption] done",
    };
    const r = adaptCaption(
      { capability: "analysis", command: "caption", options: { image: "/out/img.png", style: "score" } },
      details,
      "caption ✓ score → /out/img.png.caption.json [gemma-4-26b]",
      "",
    );
    expect(r.success).toBe(true);
    expect(r.provider).toBe("caption-vlm");
    expect(r.command).toBe("caption");
    expect(r.seed).toBeNull();
    // model from the caption JSON — the local gemma brain, NEVER a cloud id.
    expect(r.model).toBe("google/gemma-4-26b-a4b-qat");
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
  it.skipIf(process.env.CI)("selectProvider({command:'caption'}) picks mlx:caption for the analysis capability", () => {
    const entry = selectProvider("analysis", { command: "caption" });
    expect(entry.invoke).toBe("mlx:caption");
    expect(entry.provider).toBe("caption-vlm");
  });

  it("mlx:caption probe tracks run.py+venv presence (same honest signal as mlx:runpy)", () => {
    const e = REGISTRY.find((p) => p.invoke === "mlx:caption")!;
    const runpy = REGISTRY.find((p) => p.invoke === "mlx:runpy")!;
    expect(probeConfigured(e)).toBe(probeConfigured(runpy));
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
  it.skipIf(process.env.CI)("swift:ltx probe tracks the built binary; mlx:runpy probe tracks the venv+run.py", () => {
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
  it.skipIf(process.env.CI)("selects mlx:runpy when the swift:ltx binary is absent (the local-machine truth)", () => {
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

  it("propagates NoConfiguredProviderError for an unwired capability", async () => {
    expect(() => selectProvider("tts")).toThrow();
  });
});
