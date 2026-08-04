# Purify Transformer-Backend Swift-Native Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `purify --backend transformer` (flux2-klein SDEdit img2img redraw) reachable through the Bun bridge and route it to the already-Swift-native `flux2 styletransfer` command, with zero new Swift code, while `--remove` and the default `--backend seedvr2` continue to fall back to `run.py image purify` exactly as they do today.

**Architecture:** A new pure-TS module (`purify_native.ts`) replicates `image-purify.py`'s `_run_transformer_backend`/`_parse_resolution` parameter math (mode→denoise, resolution→dimensions, always-16-divisible rounding, `<input>_purify_<mode>_<res>` output naming) plus a dependency-free PNG-header dimension probe, then delegates the actual pixels to `runFlux2("styletransfer", ...)`. `bridge.ts` gains a style-forked `isNativePurifyRequest`/`realPurify` pair (same shape as the existing `isNativeControlNetRequest`/`realControlNet`), wired into `registry.ts` as a new `purify_hybrid` entry that takes over the `"purify"` command name from `runpy_image`.

**Tech Stack:** TypeScript (Bun), the existing `@repo/pi-agent-ext-flux2` `runFlux2` client, Bun's `Bun.file()` for a partial binary read (no npm image-codec dependency).

---

## Reference: verified facts this plan depends on

- `swift/flux2-image-director`'s `styletransfer` command (`StyleTransferCommand.swift`) already implements exactly the mechanism `--backend transformer` needs: `Flux2EditPipeline.generate(prompt:, imagePaths: [], initImagePath:, denoiseStrength:, width:, height:, seed:, ...)`. Its `validate()` requires either `--style-preset` or a non-empty `--prompt` — the transformer backend always supplies a prompt, so `stylePreset` stays unset.
- `styletransfer`'s fields (`bun-apps/pi-agent-ext-flux2/src/commands.ts:358-372`): `input` (path), `stylePreset?`, `prompt`, `strength` (0-1], `lora[]`, `loraScale[]`, plus `GEN_FIELDS` (`transformer`, `seed`, `width`, `height`, `steps`, `cfgScale`, `output`, `outputDir`, `name`, `vae`, `encoder`, `tokenizerDir`, `noArtifacts`, `strictGate`).
- `styletransfer` writes a `.manifest.json` sidecar via `writeArtifacts()` (unless `noArtifacts`), so `Flux2Details.output`/`.outputs`/`.width`/`.height`/`.seed` are populated through the normal manifest-parsing path (`pi-agent-ext-flux2/src/result.ts`) — the same trustworthy shape `t2i`/`upscale`/`face-detail` already have. **Not** the `cutout`/`postprocess` shape (no manifest, `d.output` always null) — no special-case handling needed here, `adaptFlux2` can be reused directly.
- `RunPyImageOptions.inputImage` (`bun-apps/pi-agent-ext-movie-director/src/runpy_image.ts:64`) is the field that maps to `--input-image`, which is what `image-purify.py` reads (`--input-image PATH`). `RunPyImageOptions.input` is a **different** field used by `angle`/`profile`/`expansion`/`review` — purify never reads it. `isNativePurifyRequest` must only look at `options.inputImage`.
- Neither `backend` nor `remove` is a typed field on `RunPyImageOptions` today, and neither `--backend` nor `--remove` is in `EXTRA_ARG_ALLOW_RUNPY_IMAGE` (`runpy_image.ts:183-201`) — no existing caller can reach `--backend transformer` (or `--remove`) at all today, native or Python. This plan adds `backend` as a typed, forwarded field (closing a silent-drop gap for the Python fallback); `remove` stays untouched/unreachable, unchanged from today, out of scope.
- `bridge.ts`'s `realAdapters()` (`bridge.ts:1279-1303`) is the live dispatch map from `ProviderEntry.invoke` → adapter function. Only pure gate functions (`isNativeControlNetRequest`, `isNativeWorkflowRequest`) get dedicated unit tests in `bridge.test.ts` — the style-forked `real*` dispatch functions themselves are not separately mock-tested (precedent: neither `realControlNet` nor `realWorkflow` appears in `bridge.test.ts`). This plan follows the same precedent: `isNativePurifyRequest` gets full table-driven tests; `realPurify`'s wiring is exercised through `purify_native.test.ts`'s own seam tests plus a real (non-mocked) integration check in the final task.
- The top-level `generate()` function (`bridge.ts:1320-1383`) already wraps every adapter call in `try { await adapter(req) } catch`, converting any thrown error into a failed `ToolResult` — so `realPurify` does not need its own try/catch (matches `realControlNet`'s leaner style, not `realWorkflow`'s redundant one).
- Python's `_parse_resolution` returns `(value, label)` where `label` is Python's `str()`/f-string formatting of a float — e.g. `f"{2.0}x"` → `"2.0x"` (Python always shows `.0` for a whole-number float), `f"{2.5}x"` → `"2.5x"`. JS's `String(2)` → `"2"` (no decimal) — `purifyResolutionLabel` must force the `.0` for whole-number scale factors to match Python's filenames byte-for-byte.
- Python's `_run_transformer_backend` (`image-purify.py:395-513`) computes output dimensions and **unconditionally** rounds both down to the nearest multiple of 16 (min 16) — even in the `resolution == "same"` case. This plan's `computePurifyDimensions` must replicate that, not special-case "same" as exempt.
- `TRANSFORMER_DENOISE = {"purify": 0.35, "enhance": 0.55, "deartifact": 0.7, "redraw": 0.85}` and `_DEFAULT_TRANSFORMER_PROMPT = "highly detailed, sharp focus, high quality, professional"` (`image-purify.py:236,246`) are literal constants to transcribe exactly.
- `film_grain`/`sharpening` only apply on Python's `seedvr2` branch (`run_purify`, `image-purify.py:858-874`), strictly after the `backend == "transformer"` branch's early `return` (`image-purify.py:847`) — dead parameters on the transformer backend. Not wired here; not a gap.

---

### Task 1: `purify_native.ts` — constants + resolution parsing

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/purify_native.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { TRANSFORMER_DENOISE, parsePurifyResolution, purifyResolutionLabel } from "./purify_native.ts";

describe("TRANSFORMER_DENOISE — mirrors image-purify.py's TRANSFORMER_DENOISE exactly", () => {
  it("has the exact 4 modes with the exact Python values", () => {
    expect(TRANSFORMER_DENOISE).toEqual({
      purify: 0.35,
      enhance: 0.55,
      deartifact: 0.7,
      redraw: 0.85,
    });
  });
});

describe("parsePurifyResolution — mirrors _parse_resolution's value half", () => {
  it('"same" (and the undefined default) parses to scale 1.0', () => {
    expect(parsePurifyResolution("same")).toBe(1.0);
    expect(parsePurifyResolution("SAME")).toBe(1.0);
    expect(parsePurifyResolution(undefined)).toBe(1.0);
  });

  it('"Nx" parses to a bare scale number', () => {
    expect(parsePurifyResolution("2x")).toBe(2);
    expect(parsePurifyResolution("2.5x")).toBe(2.5);
    expect(parsePurifyResolution("0.5x")).toBe(0.5);
  });

  it("a bare pixel string or number parses to a {pixels} target", () => {
    expect(parsePurifyResolution("2160")).toEqual({ pixels: 2160 });
    expect(parsePurifyResolution(2160)).toEqual({ pixels: 2160 });
  });

  it("throws on garbage input", () => {
    expect(() => parsePurifyResolution("not-a-resolution")).toThrow(/invalid resolution/);
  });
});

describe("purifyResolutionLabel — mirrors _parse_resolution's label half (filename component)", () => {
  it('"same" and undefined label as "same"', () => {
    expect(purifyResolutionLabel("same")).toBe("same");
    expect(purifyResolutionLabel(undefined)).toBe("same");
  });

  it('"Nx" labels with Python\'s str(float) formatting (whole numbers keep ".0")', () => {
    expect(purifyResolutionLabel("2x")).toBe("2.0x");
    expect(purifyResolutionLabel("2.5x")).toBe("2.5x");
  });

  it("a bare pixel value labels as its plain integer string", () => {
    expect(purifyResolutionLabel("2160")).toBe("2160");
    expect(purifyResolutionLabel(2160)).toBe("2160");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: FAIL — `Cannot find module './purify_native.ts'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `bun-apps/pi-agent-ext-movie-director/src/purify_native.ts`:

```ts
/**
 * purify_native.ts — native Bun port of `run.py image purify`'s
 * `--backend transformer` redraw path (`app/commands/image-purify.py`'s
 * `_run_transformer_backend`, `_parse_resolution`).
 *
 * `--backend transformer` is pure parameter computation (a mode→denoise
 * lookup table + a resolution-string parser) around a flux2-klein SDEdit
 * img2img call — a mechanism that already exists natively as
 * `swift/flux2-image-director`'s `styletransfer` command
 * (`Flux2EditPipeline.generate`'s `initImagePath`/`denoiseStrength`
 * params). Zero new Swift code.
 *
 * `--backend seedvr2` (the default) and `--remove` are OUT OF SCOPE — both
 * stay on `run.py image purify`, unchanged. See
 * .planning/specs/2026-08-05-purify-transformer-backend-swift-native-port-design.md.
 */
import { extname } from "node:path";
import { runFlux2, type Flux2Details } from "@repo/pi-agent-ext-flux2";

/** Mirrors image-purify.py's MODE_PRESETS keys (softness itself is seedvr2-only, unused here). */
export type PurifyMode = "purify" | "enhance" | "deartifact" | "redraw";

/** Mirrors TRANSFORMER_DENOISE exactly (image-purify.py:236). */
export const TRANSFORMER_DENOISE: Record<PurifyMode, number> = {
  purify: 0.35,
  enhance: 0.55,
  deartifact: 0.7,
  redraw: 0.85,
};

/** Mirrors _DEFAULT_TRANSFORMER_PROMPT exactly (image-purify.py:246). */
export const DEFAULT_TRANSFORMER_PROMPT =
  "highly detailed, sharp focus, high quality, professional";

/** A resolved resolution: either a scale factor (1.0 = same) or a shortest-side pixel target. */
export type PurifyResolution = number | { pixels: number };

/** Mirrors _parse_resolution's value half (image-purify.py:206-226). */
export function parsePurifyResolution(resStr: string | number | undefined): PurifyResolution {
  const s = String(resStr ?? "same").toLowerCase();
  if (s === "same") return 1.0;
  if (s.endsWith("x")) {
    const scale = Number.parseFloat(s.slice(0, -1));
    if (!Number.isFinite(scale)) throw new Error(`purify: invalid resolution "${resStr}"`);
    return scale;
  }
  const pixels = Number.parseInt(s, 10);
  if (!Number.isFinite(pixels)) throw new Error(`purify: invalid resolution "${resStr}"`);
  return { pixels };
}

/**
 * Mirrors _parse_resolution's label half — the filename component
 * (image-purify.py:206-226). Python's f"{scale}x" on a float always shows at
 * least one decimal digit (str(2.0) === "2.0"); JS's String(2) === "2" — the
 * whole-number branch below forces the ".0" to match Python's filenames
 * byte-for-byte.
 */
export function purifyResolutionLabel(resStr: string | number | undefined): string {
  const s = String(resStr ?? "same").toLowerCase();
  if (s === "same") return "same";
  if (s.endsWith("x")) {
    const scale = Number.parseFloat(s.slice(0, -1));
    return Number.isInteger(scale) ? `${scale}.0x` : `${scale}x`;
  }
  const pixels = Number.parseInt(s, 10);
  return String(pixels);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/purify_native.ts bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts
git commit -m "feat(purify): resolution parsing + denoise constants (Task 1)"
```

---

### Task 2: `purify_native.ts` — dimension computation

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/purify_native.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `purify_native.test.ts`:

```ts
import { computePurifyDimensions } from "./purify_native.ts";

describe("computePurifyDimensions — mirrors _run_transformer_backend's dimension math", () => {
  it("scale 1.0 (same) uses the input dims, rounded down to 16 (even 'same' rounds)", () => {
    // 1000x1500 -> floor(1000/16)*16=992, floor(1500/16)*16=1488
    expect(computePurifyDimensions(1000, 1500, 1.0)).toEqual({ width: 992, height: 1488 });
  });

  it("a non-1.0 scale multiplies both dims then rounds down to 16", () => {
    // 1000x1500 * 2 = 2000x3000 -> both already 16-divisible
    expect(computePurifyDimensions(1000, 1500, 2)).toEqual({ width: 2000, height: 3000 });
    // 1000x1500 * 0.5 = 500x750 -> floor(500/16)*16=496, floor(750/16)*16=736
    expect(computePurifyDimensions(1000, 1500, 0.5)).toEqual({ width: 496, height: 736 });
  });

  it("a pixel target scales by shortest-side, then rounds down to 16", () => {
    // 1000x1500, target 2000 shortest-side: scale=2000/1000=2 -> 2000x3000
    expect(computePurifyDimensions(1000, 1500, { pixels: 2000 })).toEqual({ width: 2000, height: 3000 });
  });

  it("never returns below 16 for a tiny input", () => {
    expect(computePurifyDimensions(4, 4, 1.0)).toEqual({ width: 16, height: 16 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: FAIL — `computePurifyDimensions is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `purify_native.ts` (after `purifyResolutionLabel`):

```ts
/**
 * Mirrors _run_transformer_backend's dimension math exactly
 * (image-purify.py:410-420), including the UNCONDITIONAL 16-divisible
 * rounding — applied even when resolution is 1.0 ("same").
 */
export function computePurifyDimensions(
  w0: number,
  h0: number,
  resolution: PurifyResolution,
): { width: number; height: number } {
  let outW: number;
  let outH: number;
  if (typeof resolution === "number") {
    if (resolution === 1.0) {
      outW = w0;
      outH = h0;
    } else {
      outW = Math.round(w0 * resolution);
      outH = Math.round(h0 * resolution);
    }
  } else {
    const scale = resolution.pixels / Math.min(w0, h0);
    outW = Math.round(w0 * scale);
    outH = Math.round(h0 * scale);
  }
  return {
    width: Math.max(16, Math.floor(outW / 16) * 16),
    height: Math.max(16, Math.floor(outH / 16) * 16),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/purify_native.ts bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts
git commit -m "feat(purify): dimension computation with 16-divisible rounding (Task 2)"
```

---

### Task 3: `purify_native.ts` — output path naming

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/purify_native.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `purify_native.test.ts`:

```ts
import { purifyOutputPathFor } from "./purify_native.ts";

describe("purifyOutputPathFor — mirrors _make_purify_paths' naming (next to input, not OUTPUT_DIR/output_XXXX)", () => {
  it("builds <base>_purify_<mode>_<res_label><ext> next to the input", () => {
    expect(purifyOutputPathFor("/out/photo.png", "enhance", "same")).toBe("/out/photo_purify_enhance_same.png");
    expect(purifyOutputPathFor("/out/photo.png", "redraw", "2x")).toBe("/out/photo_purify_redraw_2.0x.png");
    expect(purifyOutputPathFor("/out/photo.png", "purify", "2160")).toBe("/out/photo_purify_purify_2160.png");
  });

  it("preserves the input's extension (not forced to .png)", () => {
    expect(purifyOutputPathFor("/out/photo.jpg", "enhance", "same")).toBe("/out/photo_purify_enhance_same.jpg");
  });

  it("defaults extension to .png when the input has none", () => {
    expect(purifyOutputPathFor("/out/photo", "enhance", "same")).toBe("/out/photo_purify_enhance_same.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: FAIL — `purifyOutputPathFor is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `purify_native.ts` (after `computePurifyDimensions`):

```ts
/**
 * Mirrors _make_purify_paths' naming (image-purify.py:342-360): next to the
 * input, NOT the OUTPUT_DIR/output_XXXX convention other flux2 commands use.
 */
export function purifyOutputPathFor(
  inputImage: string,
  mode: PurifyMode,
  resolution: string | number | undefined,
): string {
  const resLabel = purifyResolutionLabel(resolution);
  const realExt = extname(inputImage);
  const ext = realExt || ".png";
  const base = inputImage.slice(0, inputImage.length - realExt.length);
  return `${base}_purify_${mode}_${resLabel}${ext}`;
}
```

Note: `realExt` is computed once and reused for both the display extension (defaulting to `.png` when absent) and the base-stripping length. When the input has no extension, `realExt.length === 0`, so `base` keeps the full input path unchanged — e.g. `purifyOutputPathFor("/out/photo", "enhance", "same")` → `base = "/out/photo"`, `ext = ".png"` → `"/out/photo_purify_enhance_same.png"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/purify_native.ts bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts
git commit -m "feat(purify): output path naming parity with _make_purify_paths (Task 3)"
```

---

### Task 4: `purify_native.ts` — PNG dimension probe

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/purify_native.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `purify_native.test.ts`:

```ts
import { probePngDimensions } from "./purify_native.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("probePngDimensions — dependency-free PNG IHDR reader", () => {
  /** Builds a minimal (invalid-past-IHDR, but that's fine — we only read bytes 0-23) PNG buffer with a given width/height baked into the IHDR chunk. */
  function fakePngBuffer(width: number, height: number): Buffer {
    const buf = Buffer.alloc(24);
    // PNG signature
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    // bytes 8-11: IHDR chunk length (13, unused by the probe but realistic)
    buf.writeUInt32BE(13, 8);
    // bytes 12-15: "IHDR" (unused by the probe but realistic)
    buf.write("IHDR", 12, "ascii");
    // bytes 16-19 / 20-23: width / height
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
  }

  it("reads width/height from a real PNG-shaped file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purify-native-test-"));
    const path = join(dir, "fake.png");
    try {
      writeFileSync(path, fakePngBuffer(832, 1216));
      await expect(probePngDimensions(path)).resolves.toEqual({ width: 832, height: 1216 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a non-PNG file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purify-native-test-"));
    const path = join(dir, "fake.jpg");
    try {
      // JPEG magic bytes (0xFFD8FF), not the PNG signature.
      writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
      await expect(probePngDimensions(path)).rejects.toThrow(/not a PNG/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: FAIL — `probePngDimensions is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `purify_native.ts` (after `purifyOutputPathFor`):

```ts
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Dependency-free PNG dimension probe: reads only the 8-byte PNG signature +
 * the IHDR chunk's width/height (bytes 16-19 / 20-23, big-endian uint32) —
 * a 24-byte partial file read, no decode, no npm image-codec package.
 *
 * Throws on a non-PNG signature or a truncated file. Callers only reach this
 * after isNativePurifyRequest's own `.png` extension check already passed
 * (bridge.ts), so a throw here means a genuinely mislabeled/corrupt file —
 * surfaced as a real error, not a signal to reroute anywhere.
 */
export async function probePngDimensions(path: string): Promise<{ width: number; height: number }> {
  const buf = new Uint8Array(await Bun.file(path).slice(0, 24).arrayBuffer());
  if (buf.length < 24 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) {
    throw new Error(`probePngDimensions: ${path} is not a PNG (or is truncated)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: PASS (19 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/purify_native.ts bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts
git commit -m "feat(purify): dependency-free PNG dimension probe (Task 4)"
```

---

### Task 5: `purify_native.ts` — orchestration function

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/purify_native.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `purify_native.test.ts`:

```ts
import { runPurifyTransformerNative, type StyleTransferFn } from "./purify_native.ts";
import type { Flux2Details } from "@repo/pi-agent-ext-flux2";
// mkdtempSync/rmSync/writeFileSync (node:fs), tmpdir (node:os), and join
// (node:path) are already imported at the top of this file from Task 4.

function fakePngBufferForOrchestrationTest(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function fakeStyleTransferDetails(overrides: Partial<Flux2Details> = {}): Flux2Details {
  return {
    ok: true, command: "styletransfer", exitCode: 0, aborted: false,
    output: "/out/photo_purify_enhance_same.png",
    outputs: [{ path: "/out/photo_purify_enhance_same.png", seed: 42, width: 992, height: 1488, sizeBytes: 12345 }],
    seed: 42, width: 992, height: 1488, gate: null,
    perf: { steps: 4, totalSeconds: 1.2, avgItPerSec: null, peakMemoryMB: null },
    manifestPath: null, runJsonPath: null,
    ...overrides,
  };
}

describe("runPurifyTransformerNative — computes params and delegates to styletransfer", () => {
  it("computes denoise/dims/output and forwards them to styletransfer, defaulting the prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purify-native-test-"));
    const inputPath = join(dir, "photo.png");
    try {
      writeFileSync(inputPath, fakePngBufferForOrchestrationTest(1000, 1500));

      let seenOptions: Record<string, unknown> | null = null;
      let seenOutputDir: string | undefined;
      const runStyleTransfer: StyleTransferFn = async (options, outputDir) => {
        seenOptions = options;
        seenOutputDir = outputDir;
        return { details: fakeStyleTransferDetails(), summary: "restyled photo_purify_enhance_same.png", stderrTail: "" };
      };

      const out = await runPurifyTransformerNative(
        { inputImage: inputPath, outputDir: "/out" },
        runStyleTransfer,
      );

      expect(seenOptions).toEqual({
        input: inputPath,
        prompt: "highly detailed, sharp focus, high quality, professional",
        strength: 0.55, // enhance (default mode)
        width: 992,     // 1000 -> floor(1000/16)*16
        height: 1488,   // 1500 -> floor(1500/16)*16
        seed: undefined,
        transformer: undefined,
        output: `${inputPath.slice(0, -4)}_purify_enhance_same.png`,
      });
      expect(seenOutputDir).toBe("/out");
      expect(out.details.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the given mode/resolution/seed/prompt/transformer instead of defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purify-native-test-"));
    const inputPath = join(dir, "photo.png");
    try {
      writeFileSync(inputPath, fakePngBufferForOrchestrationTest(1000, 1000));

      let seenOptions: Record<string, unknown> | null = null;
      const runStyleTransfer: StyleTransferFn = async (options) => {
        seenOptions = options;
        return { details: fakeStyleTransferDetails(), summary: "ok", stderrTail: "" };
      };

      await runPurifyTransformerNative(
        {
          inputImage: inputPath,
          mode: "redraw",
          resolution: "2x",
          seed: 7,
          prompt: "custom prompt",
          transformer: "kleinova-nsfw-v3",
        },
        runStyleTransfer,
      );

      expect(seenOptions).toMatchObject({
        prompt: "custom prompt",
        strength: 0.85, // redraw
        width: 2000,
        height: 2000,
        seed: 7,
        transformer: "kleinova-nsfw-v3",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: FAIL — `runPurifyTransformerNative is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `purify_native.ts` (after `probePngDimensions`):

```ts
export interface PurifyTransformerOptions {
  inputImage: string;
  mode?: PurifyMode;
  resolution?: string | number;
  seed?: number;
  prompt?: string;
  transformer?: string;
  outputDir?: string;
}

/** Test seam: the real implementation calls runFlux2("styletransfer", ...) directly. */
export type StyleTransferFn = (
  options: Record<string, unknown>,
  outputDir?: string,
) => Promise<{ details: Flux2Details; summary: string; stderrTail: string }>;

const defaultRunStyleTransfer: StyleTransferFn = (options, outputDir) =>
  runFlux2({ command: "styletransfer", options, outputDir });

/**
 * Computes the transformer-backend's denoise/dimensions/output path (mirrors
 * _run_transformer_backend, image-purify.py:395-513) and delegates the
 * actual redraw to flux2's native `styletransfer` command.
 */
export async function runPurifyTransformerNative(
  opts: PurifyTransformerOptions,
  runStyleTransfer: StyleTransferFn = defaultRunStyleTransfer,
): Promise<{ details: Flux2Details; summary: string; stderrTail: string }> {
  const mode = opts.mode ?? "enhance";
  const denoise = TRANSFORMER_DENOISE[mode];
  const { width: w0, height: h0 } = await probePngDimensions(opts.inputImage);
  const resolution = parsePurifyResolution(opts.resolution);
  const { width, height } = computePurifyDimensions(w0, h0, resolution);
  const output = purifyOutputPathFor(opts.inputImage, mode, opts.resolution);
  return runStyleTransfer(
    {
      input: opts.inputImage,
      prompt: opts.prompt || DEFAULT_TRANSFORMER_PROMPT,
      strength: denoise,
      width,
      height,
      seed: opts.seed,
      transformer: opts.transformer,
      output,
    },
    opts.outputDir,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/purify_native.test.ts )`
Expected: PASS (21 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/purify_native.ts bun-apps/pi-agent-ext-movie-director/src/purify_native.test.ts
git commit -m "feat(purify): runPurifyTransformerNative orchestration (Task 5)"
```

---

### Task 6: `runpy_image.ts` — forward `--backend` to the Python fallback

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/runpy_image.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/runpy_image.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `runpy_image.test.ts` (inside the existing `describe("buildImageArgs", ...)` block, after the `controlnet with prompt + input-image + controlnet flags` test):

```ts
  it("purify forwards --backend when set (closes a silent-drop gap for an explicit backend choice)", () => {
    const args = buildImageArgs(
      { action: "purify", inputImage: "/in/photo.png", purifyMode: "enhance", backend: "transformer" },
      null,
    );
    expect(args).toEqual([
      "image", "purify",
      "--input-image", "/in/photo.png",
      "--purify-mode", "enhance",
      "--backend", "transformer",
    ]);
  });

  it("purify omits --backend when unset (Python's own seedvr2 default, unchanged)", () => {
    const args = buildImageArgs({ action: "purify", inputImage: "/in/photo.png" }, null);
    expect(args).not.toContain("--backend");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/runpy_image.test.ts )`
Expected: FAIL — `buildImageArgs` doesn't read `opts.backend` yet, so the actual args array is missing `"--backend", "transformer"`, failing the `toEqual` assertion. (Bun test strips types rather than type-checking, so the test literal's `backend` field — not yet declared on `RunPyImageOptions` — runs fine as plain JS; it just has no effect until Step 3.)

- [ ] **Step 3: Write minimal implementation**

In `bun-apps/pi-agent-ext-movie-director/src/runpy_image.ts`, add the field to `RunPyImageOptions` right after `resolution` (around line 96):

```ts
  /** purify mode (purify|enhance|redraw) + resolution (same|2x|2160|...). */
  purifyMode?: string;
  resolution?: string | number;
  /** purify --backend (seedvr2 default | transformer). Forwarded as-is; the native purify_hybrid fork intercepts "transformer" requests before they ever reach here — see bridge.ts's isNativePurifyRequest. */
  backend?: string;
```

Then in `buildImageArgs`, add the forwarding line right after the `resolution` line (around line 240):

```ts
  if (opts.purifyMode != null) args.push("--purify-mode", opts.purifyMode);
  if (opts.resolution != null) args.push("--resolution", String(opts.resolution));
  if (opts.backend != null) args.push("--backend", opts.backend);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/runpy_image.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/runpy_image.ts bun-apps/pi-agent-ext-movie-director/src/runpy_image.test.ts
git commit -m "feat(purify): forward --backend to the Python fallback (Task 6)"
```

---

### Task 7: `bridge.ts` — `isNativePurifyRequest`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `bridge.test.ts`, right after the existing `describe("isNativeWorkflowRequest — workflow native/python fork", ...)` block (after its closing `});`, before `describe("adaptKrea2 ...`):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/bridge.test.ts )`
Expected: FAIL — `isNativePurifyRequest` is not exported from `./bridge.ts` (the test file's import list needs it too — see Step 3).

- [ ] **Step 3: Write minimal implementation**

At the top of `bridge.test.ts`, add `isNativePurifyRequest` to the existing import from `./bridge.ts` (alongside `isNativeControlNetRequest`):

```ts
  isNativeControlNetRequest,
  isNativePurifyRequest,
```

In `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`, add right after `isNativeWorkflowRequest`'s closing brace (after line 659, before `realWorkflow`'s doc comment):

```ts
/**
 * isNativePurifyRequest — decide whether a `purify` request can reach
 * flux2's native `styletransfer` command (via purify_native.ts) instead of
 * run.py's image-purify.py.
 *
 * `--backend transformer` is pure parameter computation around a
 * flux2-klein SDEdit img2img call — already Swift-native as `styletransfer`.
 * `--backend seedvr2` (the default) is confirmed PyTorch/torch-MPS-only, and
 * `--remove` (subtitle/watermark/screen-ui removal) is a separate, larger
 * new-algorithm effort with no existing Swift primitive for its mask-union/
 * dilate/median-fill/feathered-composite steps — see
 * .planning/specs/2026-08-05-purify-transformer-backend-swift-native-port-design.md.
 * Both stay on run.py, unchanged.
 *
 * The `.png` extension check exists because `purify_native.ts`'s dimension
 * probe (`probePngDimensions`) only parses the PNG IHDR chunk — deciding
 * this up front (not attempting native work and falling back on failure)
 * matches every other native/Python fork in this file
 * (isNativeControlNetRequest/isNativeWorkflowRequest never retry-on-failure).
 * purify's Python flag is `--input-image` (`RunPyImageOptions.inputImage`) —
 * NOT the same `input` field angle/profile/expansion/review use.
 */
export function isNativePurifyRequest(options: Record<string, unknown>): boolean {
  if (options.backend !== "transformer") return false;
  const remove = options.remove;
  if (remove != null && remove !== "none") return false;
  const inputImage = options.inputImage;
  if (typeof inputImage !== "string" || !/\.png$/i.test(inputImage)) return false;
  return true;
}

```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/bridge.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/bridge.ts bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts
git commit -m "feat(purify): isNativePurifyRequest gate (Task 7)"
```

---

### Task 8: `bridge.ts` + `registry.ts` — wire `realPurify` into the dispatch map

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/registry.test.ts` (existing generic tests must keep passing — no new test needed, see Step 4)

This task has no new failing-test-first step of its own (the pure-logic pieces were already TDD'd in Tasks 1-7); it wires those pieces together, verified by re-running the existing suites plus a real end-to-end check in Task 9.

- [ ] **Step 1: Add `realPurify` to `bridge.ts`**

Right after `isNativePurifyRequest` (from Task 7), add:

```ts
/**
 * realPurify — style-forked (controlnet_hybrid/workflow_hybrid pattern)
 * purify dispatch. Native path: purify_native.ts's runPurifyTransformerNative
 * (flux2 styletransfer). Fallback path: the pre-existing realRunPyImage,
 * unchanged. See isNativePurifyRequest for the exact split.
 */
async function realPurify(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const options = (req.options ?? {}) as Record<string, unknown>;
  if (!isNativePurifyRequest(options)) {
    return realRunPyImage(req, env);
  }
  const { runPurifyTransformerNative } = await import("./purify_native.ts");
  const inputImage = String(options.inputImage);
  const out = await runPurifyTransformerNative({
    inputImage,
    mode: options.purifyMode as PurifyMode | undefined,
    resolution: options.resolution as string | number | undefined,
    seed: options.seed as number | undefined,
    prompt: options.prompt as string | undefined,
    transformer: options.transformer as string | undefined,
    outputDir: req.outputDir,
  });
  return adaptFlux2(req, out.details, out.summary, out.stderrTail, env);
}
```

Add the type-only import at the top of `bridge.ts`, alongside the other local imports (near the `runpy_image.ts` import block, ~line 39-43):

```ts
import type { PurifyMode } from "./purify_native.ts";
```

- [ ] **Step 2: Wire `realPurify` into `realAdapters()`**

In `bridge.ts`'s `realAdapters()` function (~line 1279-1303), add a new line right after the `"mlx:workflow-hybrid"` entry:

```ts
    "mlx:controlnet-hybrid": (req) => realControlNet(req, env),
    "mlx:workflow-hybrid": (req) => realWorkflow(req, env),
    "mlx:purify-hybrid": (req) => realPurify(req, env),
```

- [ ] **Step 3: `registry.ts` — add the invoke literal, the new entry, and trim `runpy_image`**

In `bun-apps/pi-agent-ext-movie-director/src/registry.ts`, add `"mlx:purify-hybrid"` to the `invoke` union type (right after `"mlx:workflow-hybrid"`, ~line 57):

```ts
    | "mlx:caption"
    | "mlx:controlnet-hybrid"
    | "mlx:workflow-hybrid"
    | "mlx:purify-hybrid"
    | "fetch"
```

Change `runpy_image`'s `commands` array (~line 155) from:

```ts
    commands: ["purify", "multicouple"],
```

to:

```ts
    commands: ["multicouple"],
```

In that same entry's `notes` string (~line 156), find the sentence:

> `` `workflow` moved OFF this adapter (2026-07-14, session 7) onto workflow_hybrid below — ``

and insert, right before it (still inside the same notes string, same paragraph flow as the other "moved OFF" sentences):

```
`purify` moved OFF this adapter (2026-08-05) onto purify_hybrid below — see that entry's notes; only the `--backend transformer` redraw path moved (a thin wrapper around flux2's already-native `styletransfer` command), `--backend seedvr2` (the default) and `--remove` stay here unchanged.
```

Add the new `purify_hybrid` entry right after the `workflow_hybrid` entry (~line 228, after its closing `},`):

```ts
  // purify — 2026-08-05: image-purify.py's `--backend transformer` redraw
  // path (`_run_transformer_backend`) is pure parameter computation (a
  // mode→denoise lookup table + a resolution-string parser) around a
  // flux2-klein SDEdit img2img call — already Swift-native as
  // `swift/flux2-image-director`'s `styletransfer` command
  // (Flux2EditPipeline.generate's initImagePath/denoiseStrength, no new
  // Swift code). `--backend seedvr2` (the default) stays confirmed
  // PyTorch/torch-MPS-only. `--remove` (subtitle/watermark/screen-ui
  // removal via SAM3 + inpaint + feathered composite) is a separate,
  // larger new-algorithm effort with no existing Swift primitive for its
  // mask-union/dilate/median-fill/composite steps — deferred, not silently
  // dropped, see .planning/specs/2026-08-05-purify-transformer-backend-
  // swift-native-port-design.md. So this stays under ONE command name
  // ("purify") and forks by request shape inside bridge.ts's realPurify —
  // the same style-fork controlnet_hybrid/workflow_hybrid (above) use.
  // Native path only fires when backend==="transformer", no `remove` is
  // requested, and the input is a `.png` — see isNativePurifyRequest in
  // bridge.ts. Everything else still reaches run.py's image-purify.py via
  // realRunPyImage exactly as before.
  {
    name: "purify_hybrid",
    capability: "image_generation",
    provider: "purify-hybrid",
    backend: "native_swift",
    invoke: "mlx:purify-hybrid",
    configured: true,
    commands: ["purify"],
    notes: "Style-forked (caption.ts/controlnet_hybrid/workflow_hybrid pattern) purify dispatch (src/bridge.ts realPurify). Native path: src/purify_native.ts computing denoise/dimensions/output-path then delegating to flux2's native `styletransfer` command — fires only for `--backend transformer` requests with a `.png` input and no `--remove`. Fallback path: run.py's image-purify.py (the default `--backend seedvr2` SeedVR2 redraw/upscale, and `--remove` subtitle/watermark/screen-ui removal) — fires for everything else, unchanged from before this migration. See isNativePurifyRequest for the exact split and purify_native.ts's module doc for the parameter-math parity notes.",
  },

```

- [ ] **Step 4: Run the full suite to confirm nothing broke**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: PASS — every existing test (including `registry.test.ts`'s generic invariant checks, which need no new cases: the new `purify_hybrid` entry automatically satisfies `getByCapability`/`providerMenuSummary`'s bucket-count/gap/cloud-isolation checks the same way `controlnet_hybrid`/`workflow_hybrid` already do) plus every test from Tasks 1-7.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/bridge.ts bun-apps/pi-agent-ext-movie-director/src/registry.ts
git commit -m "feat(purify): wire realPurify + purify_hybrid registry entry (Task 8)"
```

---

### Task 9: Real (non-mocked) integration check

**Files:** none committed — this task builds the real binary and runs a throwaway script, then cleans up.

This mirrors the postprocess port's final verification step: a real end-to-end run against the actual built `flux2` binary, not just mocked seams, catching anything a test double could hide (wrong flag name, wrong CLI shape, a `runFlux2` path-safety rejection, etc.).

- [ ] **Step 1: Build the release `flux2` binary (skip if already fresh)**

Run: `( cd swift/flux2-image-director && swift build -c release )`
Expected: `Build complete!` (or already up to date).

- [ ] **Step 2: Create a real small PNG test fixture under the allowed output root**

`runFlux2`'s path-safety guard (`pi-agent-ext-flux2/src/paths.ts`) only allows `repoRoot`/`outputDir` (`video_generation__output`)/`modelsRoot` — NOT `/tmp`. Generate a real tiny PNG via the already-built `flux2 t2i` (guarantees a valid, real PNG, not a hand-rolled fixture):

```bash
mkdir -p ../video_generation__output/_purify_native_check
swift/flux2-image-director/.build/release/flux2 t2i \
  --prompt "a red circle on white background" --width 256 --height 256 --steps 2 \
  --output ../video_generation__output/_purify_native_check/src.png --no-artifacts
```

Expected: exits 0, `../video_generation__output/_purify_native_check/src.png` exists.

- [ ] **Step 3: Run `runPurifyTransformerNative` against the real binary**

Write a throwaway script (not committed) at `/private/tmp/claude-501/*/scratchpad/check-purify-native.ts` (use this session's actual scratchpad path) — or anywhere under the repo the sandbox allows, then delete it after:

```ts
import { runPurifyTransformerNative } from "/Users/huangziyu/proj/video_generation__director/bun-apps/pi-agent-ext-movie-director/src/purify_native.ts";

const out = await runPurifyTransformerNative({
  inputImage: "/Users/huangziyu/proj/video_generation__output/_purify_native_check/src.png",
  mode: "enhance",
  resolution: "same",
});
console.log(JSON.stringify({ ok: out.details.ok, output: out.details.output, width: out.details.width, height: out.details.height }, null, 2));
```

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun run /path/to/check-purify-native.ts )`

Expected: `ok: true`, `output` pointing at `.../src_purify_enhance_same.png`, and that file exists with dimensions `240x240` (256 rounded down to the nearest 16 — confirms the real end-to-end math, binary, and `runFlux2` wiring all agree, not just the mocked unit tests).

- [ ] **Step 4: Verify the output file for real**

Run: `file ../video_generation__output/_purify_native_check/src_purify_enhance_same.png`
Expected: reports a valid PNG at 240x240.

- [ ] **Step 5: Clean up**

```bash
rm -rf ../video_generation__output/_purify_native_check
rm /path/to/check-purify-native.ts
```

No commit for this task — it produced no source changes, only verification.

---

## Non-goals recap (unchanged from the design spec)

- `--remove` stays on Python, unchanged, no regression.
- `--backend seedvr2` (default) stays on Python, unchanged, no regression.
- No new Swift code — `styletransfer` already implements the needed mechanism end-to-end.
