import { describe, expect, it } from "bun:test";
import {
  adaptKrea2,
  adaptFlux2,
  adaptLtx,
  generate,
  selectAndGenerate,
  tariffFor,
  type ToolResult,
  type GenerateRequest,
  type Adapter,
} from "./bridge.ts";
import { selectProvider } from "./selector.ts";
import { REGISTRY, type ProviderEntry } from "./registry.ts";
import type { Krea2Details } from "@repo/pi-agent-ext-krea2";
import type { Flux2Details } from "@repo/pi-agent-ext-flux2";
import type { LtxDetails } from "@repo/pi-agent-ext-ltx";

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
