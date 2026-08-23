# Purify Transformer-Backend Swift-Native Port — Design Spec

## Context

`run.py image purify` (`app/commands/image-purify.py`, 893 lines) wraps
SeedVR2 high-quality redraw/upscale, with two alternate mechanisms selectable
via `--backend`:

- `--backend seedvr2` (the default) — `SeedVR2Upscaler`, confirmed
  PyTorch/torch-MPS-only (see memory `project_pytorch_mps_versions` /
  `project_attention_backends_mps`). Permanently non-portable.
- `--backend transformer` — delegates to `run.py image i2i --pipeline
  flux2-klein --denoise-strength <mode-derived> --width --height --seed
  --prompt` (`_run_transformer_backend`, lines 395–513). This is pure
  parameter computation (a mode→denoise lookup table + a resolution-string
  parser) around a flux2-klein SDEdit img2img call — a mechanism that
  already exists natively as `swift/flux2-image-director`'s `styletransfer`
  command (`StyleTransferCommand.swift`): `Flux2EditPipeline.generate`'s
  `initImagePath`/`denoiseStrength` params, the same primitives
  `InpaintCommand`/`SceneCommand` already use. `styletransfer` requires
  either a `--style-preset` or a non-empty `--prompt` (its own `validate()`)
  — the transformer backend always supplies a prompt (user-given or a
  built-in default), so it satisfies this with `stylePreset` simply omitted.

A third mechanism, `--remove` (subtitle/watermark/screen-ui removal via SAM3
segmentation + inpaint + feathered composite), is a separate, larger new-code
effort (mask union/dilate, median-color prefill, feathered alpha composite —
none of which exist as Swift primitives yet) and is explicitly **out of
scope** for this port — see Scope below.

`registry.ts`'s `runpy_image` entry currently owns `purify` unconditionally
(`commands: ["purify", "multicouple"]`) — every purify request, regardless of
`--backend`, reaches `run.py`. Neither `backend` nor `remove` is a typed
field on `RunPyImageOptions` today, nor are `--backend`/`--remove` in
`EXTRA_ARG_ALLOW_RUNPY_IMAGE` — so a caller cannot request `--backend
transformer` (or `--remove`) through this bridge at all yet, native or
otherwise. This port is a net-new reachable capability, not a
routing-behavior change for any existing caller (the seedvr2 default path is
untouched).

## Scope

**In scope:**
- A new `purify_native.ts` (`bun-apps/pi-agent-ext-movie-director/src/`)
  exposing a pure parameter-computation function (mode → denoise, resolution
  string → target width/height, mirroring `_parse_resolution` +
  `_run_transformer_backend`'s dimension math exactly, including the
  always-applied 16-divisible rounding) plus a thin orchestration function
  that calls flux2's `styletransfer` command with the computed params.
- `bridge.ts` gains `isNativePurifyRequest(options)` + a style-forked
  `realPurify(req, env)` (same pattern as `isNativeControlNetRequest`/
  `realControlNet` and `isNativeWorkflowRequest`/`realWorkflow`): native path
  fires only when `options.backend === "transformer"` AND `options.remove` is
  absent/`null`/`"none"`; everything else (including the seedvr2 default and
  any future `remove` request) falls through to the existing
  `realRunPyImage`, unchanged.
- `RunPyImageOptions` gains a typed `backend?: string` field (forwarded as
  `--backend` in `buildImageArgs`) — closes a latent correctness gap where an
  explicit `backend: "transformer"` request that (for whatever reason) still
  reaches the Python fallback would otherwise have its backend choice
  silently dropped, defaulting to seedvr2 without the caller ever knowing.
  `remove` is deliberately **not** added here (see Out of scope).
- `registry.ts`: `"purify"` moves from `runpy_image.commands[]` to a new
  `purify_hybrid` entry (`commands: ["purify"]`, `invoke:
  "mlx:purify-hybrid"`), matching the `controlnet_hybrid`/`workflow_hybrid`
  style-fork precedent. `runpy_image.commands[]` keeps `multicouple` (still
  permanently unportable — genuine latent-couple MLX compute, unrelated to
  this port).
- `pi-agent-ext-flux2`'s `commands.ts` needs no changes — `styletransfer` is
  already fully wired.
- A small dependency-free `probePngDimensions(path)` helper in
  `purify_native.ts` (reads the 8-byte PNG signature + the IHDR chunk's
  width/height, a ~20-line partial-file read — no npm image-codec package).
  `computePurifyDimensions` needs the input's real pixel size for the
  default `resolution: "same"` case (and for pixel-target/scale cases), and
  nothing in this codebase can currently answer "what are this PNG's
  dimensions" without decoding the whole image — this is a new, narrowly
  scoped primitive, not a general image-codec dependency.
- Real, non-mocked unit tests for the parameter-computation function
  (denoise lookup, resolution parsing, dimension rounding — table-driven
  against the exact Python constants) plus `bridge.ts` fork-routing tests
  (mirroring `isNativeControlNetRequest`'s test shape).

**Out of scope (deferred, documented, not silently dropped):**
- `--remove` (subtitle/watermark/screen-ui removal) — genuine new-algorithm
  work (SAM3 multi-prompt mask union + dilation, border-median-color
  prefill, face-overlap warning, feathered alpha composite) with no existing
  Swift primitive for the fill/composite steps. `isNativePurifyRequest`
  treats any `remove` request as non-native (falls to Python) so a future
  caller that does supply `--remove` behaves exactly as it does today — no
  regression, no silent drop. A future round can port this once scoped on
  its own.
- `--backend seedvr2` (the default) — confirmed PyTorch/torch-MPS-only,
  unrelated to this port, untouched.
- `film_grain`/`sharpening` post-processing — in the Python source these
  only apply on the seedvr2 branch (`run_purify`, lines 858–874, strictly
  after the `backend == "transformer"` branch's early `return` at line 847).
  They are dead parameters on the transformer backend today, so the native
  port does not wire them either — faithful to the actual Python behavior,
  not a gap.
- Output filename convention: preserved exactly. Python's
  `_make_purify_paths` names the output `<input_base>_purify_<mode>_<res_label><ext>`
  next to the input (not the `OUTPUT_DIR/output_XXXX` convention other
  commands use). `purify_native.ts` replicates this via an explicit
  `--output` passed to `styletransfer`, mirroring `postProcessPathFor`/
  `cutoutPathFor`'s precedent of computing a caller-owned output path rather
  than trusting the command's auto-naming.
- Non-PNG input images. `probePngDimensions` only parses the PNG IHDR chunk.
  Route eligibility (`isNativePurifyRequest`) is decided synchronously and
  up front from the request shape alone — same as every other native/Python
  fork in this file (`isNativeControlNetRequest`/`isNativeWorkflowRequest`
  never start native work and fall back mid-flight on failure). So the
  `.png`/`.PNG` extension check happens INSIDE `isNativePurifyRequest`
  itself (cheap, sync, string-only): a non-`.png` `inputImage` is simply not
  natively servable and routes to `realRunPyImage` (PIL opens any format) —
  decided before any work starts, no partial-attempt-then-fallback. If the
  extension lies (a mislabeled non-PNG file with a `.png` name),
  `probePngDimensions` still throws inside the native path — that surfaces
  as a real, visible error, the same way any other genuine generation
  failure does elsewhere in this codebase, not a silent reroute. A future
  round can add JPEG (SOF0) parsing if this proves to matter in practice.

## Design

### 1. `purify_native.ts` (new)

Two pure, independently-testable pieces plus one orchestration function:

```ts
/** Mirrors image-purify.py's MODE_PRESETS keys (softness is seedvr2-only, unused here). */
export type PurifyMode = "purify" | "enhance" | "deartifact" | "redraw";

/** Mirrors TRANSFORMER_DENOISE exactly. */
const TRANSFORMER_DENOISE: Record<PurifyMode, number> = {
  purify: 0.35,
  enhance: 0.55,
  deartifact: 0.7,
  redraw: 0.85,
};

const DEFAULT_TRANSFORMER_PROMPT =
  "highly detailed, sharp focus, high quality, professional";

/** Mirrors _parse_resolution: "same" -> 1.0 (scale), "Nx" -> N (scale), else target shortest-side pixels. */
export function parsePurifyResolution(resStr: string | number | undefined): number | { pixels: number } {
  const s = String(resStr ?? "same").toLowerCase();
  if (s === "same") return 1.0;
  if (s.endsWith("x")) return parseFloat(s.slice(0, -1));
  const pixels = Number.parseInt(s, 10);
  if (!Number.isFinite(pixels)) throw new Error(`purify: invalid resolution "${resStr}"`);
  return { pixels };
}

/** Mirrors _run_transformer_backend's dimension math, incl. the unconditional 16-divisible clamp. */
export function computePurifyDimensions(
  w0: number,
  h0: number,
  resolution: number | { pixels: number },
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

export interface PurifyTransformerOptions {
  inputImage: string;
  mode?: PurifyMode; // default "enhance"
  resolution?: string | number; // default "same"
  seed?: number; // default 42
  prompt?: string;
  transformer?: string; // omit -> styletransfer's own default (klein-9b)
  /** Probed via probePngDimensions(inputImage) before calling this function. */
  inputWidth: number;
  inputHeight: number;
}

/**
 * Dependency-free PNG dimension probe: 8-byte PNG signature + the IHDR
 * chunk's width/height (bytes 16-19 / 20-23, big-endian uint32). No decode,
 * no npm image-codec package — a partial file read only. Throws on a
 * non-PNG signature or a truncated file. Callers only reach this after
 * isNativePurifyRequest's own `.png` extension check already passed, so a
 * throw here is a genuine error (mislabeled/corrupt file) surfaced directly
 * — not a signal to reroute to Python.
 */
export async function probePngDimensions(path: string): Promise<{ width: number; height: number }> {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const buf = new Uint8Array(await Bun.file(path).slice(0, 24).arrayBuffer());
  if (buf.length < 24 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) {
    throw new Error(`probePngDimensions: ${path} is not a PNG (or is truncated)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

export interface PurifyTransformerResult {
  path: string;
  width: number | null;
  height: number | null;
}

export type PurifyTransformerFn = (opts: PurifyTransformerOptions) => Promise<PurifyTransformerResult>;

/** Mirrors _make_purify_paths' naming (next to input, not OUTPUT_DIR/output_XXXX). */
export function purifyOutputPathFor(inputImage: string, mode: PurifyMode, resolution: string | number | undefined): string {
  const resLabel = purifyResolutionLabel(resolution);
  const ext = extname(inputImage) || ".png";
  const base = inputImage.slice(0, inputImage.length - extname(inputImage).length);
  return `${base}_purify_${mode}_${resLabel}${ext}`;
}
```

`purifyResolutionLabel` mirrors `_parse_resolution`'s second return value
(`"same"`, `"<scale>x"` — note Python's `f"{scale}x"` on a `float`, e.g.
`"2.0x"` not `"2x"`, — or the raw pixel string) so filenames match byte for
byte with what the Python path would have produced for the same input.

`defaultRunPurifyTransformer` (the real, non-test-seam implementation) takes
the already-probed `inputWidth`/`inputHeight` (probing happens in the
caller, `realPurify` — see below), looks up `denoise` from
`TRANSFORMER_DENOISE[mode ?? "enhance"]`, computes `{width, height}` via
`computePurifyDimensions`, computes `output` via `purifyOutputPathFor`, and
calls `runFlux2("styletransfer", { input, prompt: prompt ??
DEFAULT_TRANSFORMER_PROMPT, strength: denoise, width, height, seed,
transformer, output })` — same `runFlux2` +
`parseOutputPathFromStdout` question as every prior port: `styletransfer`'s
stdout ends with a **standalone** absolute path line (`imagePath.path`
printed alone, per `StyleTransferCommand.swift`'s
`print("   \(imagePath.path)")` — no prefix), matching the `t2i`/`upscale`/
`face-detail` shape (trustable via `d.output`), **not** the `cutout`/
`postprocess` shape. This gets verified against the real binary during
implementation (per this repo's established API-verification discipline),
but since the caller already computes and passes an explicit `--output`
path, the result path is known regardless — `d.output` is used only as a
sanity cross-check, not the sole source of truth, avoiding a repeat of the
postprocess port's `d.output`-trust bug.

### 2. `bridge.ts`

```ts
export function isNativePurifyRequest(options: Record<string, unknown>): boolean {
  if (options.backend !== "transformer") return false;
  const remove = options.remove;
  if (remove != null && remove !== "none") return false;
  const inputImage = options.inputImage ?? options.input;
  if (typeof inputImage !== "string" || !/\.png$/i.test(inputImage)) return false;
  return true;
}

async function realPurify(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const options = (req.options ?? {}) as Record<string, unknown>;
  if (isNativePurifyRequest(options)) {
    const { probePngDimensions, defaultRunPurifyTransformer } = await import("./purify_native.ts");
    const inputImage = String(options.inputImage ?? options.input);
    // No try/catch here: a probePngDimensions failure past this point (a
    // mislabeled non-PNG file, a truncated file) or a defaultRunPurifyTransformer
    // failure are both genuine errors — surfaced directly, matching every
    // other native command. Route eligibility was already fully decided
    // above; this function never falls back mid-flight.
    const { width, height } = await probePngDimensions(inputImage);
    const out = await defaultRunPurifyTransformer({
      inputImage,
      mode: options.purifyMode as PurifyMode | undefined,
      resolution: options.resolution as string | number | undefined,
      seed: options.seed as number | undefined,
      prompt: options.prompt as string | undefined,
      transformer: options.transformer as string | undefined,
      inputWidth: width,
      inputHeight: height,
    });
    return adaptPurifyNative(req, out, env);
  }
  return realRunPyImage(req, env);
}
```

`RunPyImageOptions` gains `backend?: string`, forwarded in `buildImageArgs`
as `if (opts.backend != null) args.push("--backend", opts.backend);` — a
1-line addition closing the silent-drop gap described in Scope.

### 3. `registry.ts`

`purify_hybrid` entry added (declared adjacent to `controlnet_hybrid`/
`workflow_hybrid`), `"purify"` removed from `runpy_image.commands[]`. Notes
on both entries document the split, following the existing
`controlnet_hybrid`/`workflow_hybrid` notes style (native condition, what
stays on Python and why).

### 4. `ProviderEntry.invoke` union type

Gains `"mlx:purify-hybrid"` as a new literal, wired in the invoke-dispatch
map (`"mlx:purify-hybrid": (req) => realPurify(req, env)`) alongside the
existing `"mlx:controlnet-hybrid"`/`"mlx:workflow-hybrid"` entries.

## Testing

- `purify_native.test.ts`: table-driven tests for
  `TRANSFORMER_DENOISE`/`parsePurifyResolution`/`computePurifyDimensions`/
  `purifyOutputPathFor` against literal values transcribed from the Python
  source (denoise per mode, `"same"`/`"2x"`/`"2160"` resolution parsing,
  16-divisible rounding including the "same → still rounds down" case,
  filename for at least one case per resolution kind). `probePngDimensions`
  gets a real (non-mocked) test: write a minimal valid PNG byte buffer with
  a known IHDR width/height to a temp file (scratch dir, cleaned up after)
  and assert the probed values match — plus a "not a PNG" input (e.g. a
  JPEG magic-byte buffer) asserting it throws. An orchestration test with an
  injected `_runPurifyTransformer` seam (mirrors `workflow_native.test.ts`'s
  `_runBase`/`_runFaceDetail` pattern) verifying the right `styletransfer`
  params are built from a `PurifyTransformerOptions` input.
- `bridge.test.ts`: `isNativePurifyRequest` true/false table (backend unset →
  false, backend="seedvr2" → false, backend="transformer" + `.png` input +
  no remove → true, backend="transformer" + `.png` input + remove="subtitle"
  → false, backend="transformer" + `.png` input + remove="none" → true,
  backend="transformer" + `.jpg` input → false) + a `realPurify` routing
  test with a mocked native seam and a mocked `realRunPyImage` fallback seam
  confirming each branch is reached.
- A real (non-mocked) integration check during implementation: build the
  release `flux2` binary, run `purify_native.ts`'s real orchestration
  function against it with a real small test image, confirm the output PNG
  exists at the expected `_purify_<mode>_<res>` path and dimensions — same
  discipline as the postprocess port's throwaway integration script (cleaned
  up afterward, not committed).

## Non-goals recap

- `--remove` stays on Python, unchanged, no regression.
- `--backend seedvr2` (default) stays on Python, unchanged, no regression.
- No new Swift code — `styletransfer` already implements the needed
  mechanism end-to-end.
