# cutout Swift-native port (`image cutout` off Python)

## Context

Standing architecture rule (reaffirmed 2026-07-27, see `project_ltx_swift_native_port`
memory): Python is dev/spike-only; every production CLI surface the TS agent
bridge calls into must be Swift-native. `music_generation` closed out
2026-07-28 (PR #922). `kontext` closed out 2026-07-29 (PR #943).
`styletransfer` closed out 2026-07-30 (PR #957), and its own design spec
flagged `cutout` as the next reasonable candidate.

`runpy_image`'s `commands[]` list
(`bun-apps/pi-agent-ext-movie-director/src/registry.ts`) still routes
`cutout` to `python/mlx-movie-director/app/commands/image-cutout.py`, which
cuts a subject out onto a transparent RGBA canvas: SAM3 text-prompted
segmentation isolates `--subject`, the mask is (optionally hole-filled and)
feathered, then the ORIGINAL pixels are alpha-composited onto a transparent
canvas — no regeneration, no model in the compositing loop, purely
numpy/PIL. `--trim` optionally crops to the alpha bounding box.

**Key finding from this session's investigation:** the SAM3 segmentation
step already has a working Python-subprocess bridge that Swift calls today —
`python/mlx-movie-director/app/tests/sam3_segment_bridge.py`, invoked by the
already-shipped `flux2 segment` command
(`swift/flux2-image-director/Sources/Flux2DirectorCLI/SegmentCommand.swift`).
SAM3 itself is explicitly out of scope for a native port — that command's own
header comment says a full Swift MLX port would be "a multi-day effort
comparable to the entire Flux2 port." This spec does not change that: cutout
stays on the subprocess bridge for segmentation. What's missing is purely the
downstream alpha-compositing (RGB + mask → transparent RGBA PNG, plus
optional bbox trim and mask/overlay debug dump) — a small, self-contained
unit of new Swift code, unlike `kontext` (needed a whole new denoise
pipeline) or `styletransfer` (reused an existing pipeline wholesale). Its
closest architectural sibling is `SegmentCommand.swift` itself (no model
loading, no `RunConfig`/`OutputPathResolver`, explicit `--output` path) —
not the generation commands (`InpaintCommand`/`StyleTransferCommand`), which
this port does NOT resemble.

**Scope narrowed vs. the Python original**, confirmed with the user across
two sessions:
- `--feather`/`--fill-holes` are dropped. The bridge already feathers with a
  hardcoded radius of 10 and never fills holes; v1 reuses the bridge
  unchanged rather than adding new bridge flags with no driving caller yet.
- `--save-mask`'s debug output matches Python's shape (mask PNG + green-tint
  overlay PNG, both saved), not just the raw mask — confirmed via
  AskUserQuestion this session. The overlay's *blending math* differs from
  Python by necessity (see §1.5) since the bridge only ever returns a
  feathered mask, not Python's pre-feather binary one.

## Scope (v1)

**In scope:**
- `CutoutCommand.swift` — a new `flux2 cutout` CLI subcommand. See §1.
- `ImageSave.savePNGRGBA(rgb:alpha:to:)` — a new function in
  `swift/common-image-director/Sources/CommonImageDirector/ImageSave.swift`,
  writing real alpha (`CGImageAlphaInfo.last`) instead of the existing
  `savePNG`'s hardcoded opaque `.noneSkipLast`.
- `--trim` bbox-cropping, implemented fresh in Swift via MLX array slicing
  (mirrors Python's `_trim_to_alpha`).
- `--save-mask` debug dump (mask + overlay), matching Python's two-file
  output shape.
- TS integration (`pi-agent-ext-flux2/src/commands.ts` +
  `pi-agent-ext-movie-director/src/registry.ts`) — pure data addition, same
  shape as the two prior ports: `cutout` moves from `runpy_image.commands[]`
  to `flux2_image.commands[]`.
- One end-to-end sanity check: real Swift cutout vs. `run.py image cutout`
  (real `--input`, not `--self-test`'s synthesized source) output, pixel-level
  comparison on the final RGBA — same shape as `compare_kontext_e2e.py` /
  `compare_styletransfer_e2e.py`.

**Out of scope (deferred, not dropped):**
- `--feather`/`--fill-holes` configurability (see above).
- Python's `--self-test` synthetic-source generation — the E2E comparison
  script (§4) supplies a fixed real input image instead, same precedent as
  the two prior ports.
- Byte-level parity of the `--save-mask` debug files with Python's own
  output — the *final cutout* is what's numerically verified (§4); the debug
  mask/overlay differ by an intentional, documented mechanism (§1.5).

## 1. `CutoutCommand.swift` (new file:
`swift/flux2-image-director/Sources/Flux2DirectorCLI/CutoutCommand.swift`)

Follows `SegmentCommand.swift`'s shape (no model loading, no
`RunConfig`/`OutputPathResolver`/`ImageGate`, explicit `--output` path,
subprocess bridge call with inherited stdout/stderr) — not
`InpaintCommand`/`StyleTransferCommand`'s generation-pipeline shape, since
cutout has no model in its loop.

### 1.1 CLI options

```
flux2 cutout --input <content-image> [--subject <text>] [--prompt <text>]
  [--sam-threshold F=0.3] [--trim] [--save-mask] --output <path>
```

- `--subject`: SAM3 text prompt. Falls back to `--prompt` if omitted (same
  as Python). At least one of the two is required — `ValidationError` if
  both are missing.
- `--sam-threshold`: detection score threshold, default `0.3` (matches
  Python's default and is passed straight through to the bridge's own
  `--threshold`).
- `--trim`: crop to alpha bbox + 5% padding (see §1.4).
- `--save-mask`: also write `<output>_mask.png` + `<output>_overlay.png`
  (see §1.5).
- `--output`: required, explicit path (no `--output-dir`/`--name`/
  `--no-artifacts` — there is no `RunConfig` to write since there's no
  model).

### 1.2 SAM3 bridge invocation

Reuses the exact subprocess pattern `SegmentCommand.swift` already has
(repo-root resolution by walking up for `python/venv/bin/python`, `Process`
with inherited stdout/stderr, JSON sidecar read). Bridge is invoked with a
temp mask path (`NSTemporaryDirectory()` + a UUID-suffixed name — the bridge
output isn't the final artifact, just an intermediate the compositing step
consumes and the temp file is removed after use):

```swift
process.arguments = [
    bridge,
    "--image", input,
    "--prompt", subject,       // subject, falling back to prompt, resolved earlier
    "--out-mask", tempMaskPath,
    "--threshold", String(samThreshold),
]
```

After the process exits, read `<tempMaskPath>.json`. If `count == 0`, print
the Python-equivalent message and `exit(2)`:
```
[cutout] No detections for '<subject>'. Try lowering --sam-threshold.
```
Otherwise print the Python-equivalent progress line using `best_score` /
`best_box` from the JSON:
```
[cutout] Best: score=<best_score> box=(<best_box[0]>,<best_box[1]>,<best_box[2]>,<best_box[3]>)
```

### 1.3 Compositing (MLX-based, decided this session over raw CoreGraphics/vImage)

Uses `Flux2ImageLoad.imageSize(at:)` first to get the source's native
resolution — **no resize** (unlike every generation command, which targets a
fixed `--width`/`--height` canvas; cutout must preserve the input's exact
dimensions):

```swift
let (width, height) = try Flux2ImageLoad.imageSize(at: inputURL)
let rgb = try Flux2ImageLoad.loadArray(from: inputURL, targetSize: (width, height))
let alpha = try Flux2ImageLoad.loadMaskAsChannel(from: tempMaskURL, width: width, height: height)
try FileManager.default.removeItem(at: tempMaskURL)
try? FileManager.default.removeItem(at: tempMaskURL.appendingPathExtension("json"))
```

`alpha` is already the bridge's feathered `[0,1]` mask — no re-feathering
needed in Swift (the bridge feathers with radius 10 before it ever writes
the PNG). Then:

```swift
var outRGB = rgb
var outAlpha = alpha
if trim {
    (outRGB, outAlpha) = try Self.trimToAlpha(rgb: outRGB, alpha: outAlpha, padding: 0.05)
}
try ImageSave.savePNGRGBA(rgb: outRGB, alpha: outAlpha, to: URL(fileURLWithPath: output))
```

### 1.4 `--trim` (new, mirrors Python's `_trim_to_alpha`)

A `static func trimToAlpha(rgb: MLXArray, alpha: MLXArray, padding: Float) throws
-> (MLXArray, MLXArray)` helper on `CutoutCommand` (or a free function in the
same file — decided during implementation, whichever keeps the file's
responsibilities clear). Computes the bounding box of non-zero alpha rows/
columns, expands by `padding` fraction of `max(bw, bh)` on each side
(clamped to image bounds), then slices both `rgb` (shape `(1,3,H,W)`) and
`alpha` (shape `(1,1,H,W)`) to the box — the exact math Python's
`_trim_to_alpha` uses (`np.where(rows)[0][[0,-1]]` /
`np.where(cols)[0][[0,-1]]`, `px = int(max(bw,bh) * padding)`), translated to
MLX slicing on the H/W axes. If no pixel has alpha > 0, return the inputs
unchanged (same as Python's early-return).

### 1.5 `--save-mask` (matches Python's two-file shape; blend math necessarily differs)

Python's own `--save-mask` (`image-cutout.py:252-259`) saves the **pre-feather
binary** mask plus a **hard-edged** green overlay (`mask > 0` selects pixels
for a 50/50 blend). Swift's bridge, unlike Python's direct
`app.sam3_predictor` call, only ever returns the **already-feathered**
continuous alpha — there is no pre-feather binary mask available to Swift
without changing the bridge (out of scope, see above). So:

- `<output>_mask.png`: the feathered alpha itself, saved via the existing
  grayscale path (`ImageSave` needs no new function for this — the alpha
  MLXArray is already `(1,1,H,W)` in `[0,1]`, same shape a grayscale PNG
  save expects).
- `<output>_overlay.png`: a continuous alpha-weighted green blend —
  `rgb * (1 - 0.5*alpha) + green * (0.5*alpha)` — instead of Python's binary
  `mask > 0` selection. This gives a smoothly-fading tint at the feathered
  edge rather than Python's hard-edged tint. Documented here as the
  intentional deviation; not gated by the E2E comparison (§4), which only
  checks the final cutout.

Both files are written using the (possibly trimmed, if `--trim` was also
passed) `outRGB`/`outAlpha` — i.e. `--save-mask` reflects what was actually
composited, consistent with itself.

## 2. `ImageSave.savePNGRGBA` (modify:
`swift/common-image-director/Sources/CommonImageDirector/ImageSave.swift`)

New function alongside the existing `savePNG`, sharing its CHW→interleaved
conversion shape but taking a separate alpha channel and writing real alpha:

```swift
public static func savePNGRGBA(rgb: MLXArray, alpha: MLXArray, to url: URL) throws {
    let dims = rgb.shape
    precondition(dims.count == 4 && dims[0] == 1 && dims[1] == 3,
                 "expected rgb (1, 3, H, W), got \(dims)")
    let height = dims[2]
    let width = dims[3]
    precondition(alpha.shape == [1, 1, height, width],
                 "expected alpha (1, 1, \(height), \(width)), got \(alpha.shape)")

    let flatRGB = rgb.reshaped([3, height, width]).asType(.float32)
    let flatA = alpha.reshaped([height, width]).asType(.float32)
    MLX.eval(flatRGB, flatA)
    let rArr = flatRGB[0].asArray(Float.self)
    let gArr = flatRGB[1].asArray(Float.self)
    let bArr = flatRGB[2].asArray(Float.self)
    let aArr = flatA.asArray(Float.self)

    var rgba = [UInt8](repeating: 0, count: width * height * 4)
    for idx in 0..<(width * height) {
        let outIdx = idx * 4
        rgba[outIdx]     = UInt8(max(0, min(255, rArr[idx] * 255)))
        rgba[outIdx + 1] = UInt8(max(0, min(255, gArr[idx] * 255)))
        rgba[outIdx + 2] = UInt8(max(0, min(255, bArr[idx] * 255)))
        rgba[outIdx + 3] = UInt8(max(0, min(255, aArr[idx] * 255)))
    }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    // kCGImageAlphaLast = real RGBA (unlike savePNG's opaque .noneSkipLast).
    let alphaInfo = CGImageAlphaInfo.last.rawValue
    let orderInfo = CGBitmapInfo.byteOrder32Big.rawValue
    let bitmapInfo = CGBitmapInfo(rawValue: alphaInfo | orderInfo)
    let provider = CGDataProvider(data: Data(rgba) as CFData)!
    guard let cgImage = CGImage(
        width: width, height: height,
        bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: colorSpace, bitmapInfo: bitmapInfo,
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
    ) else {
        throw NSError(domain: "ImageSave", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "CGImage creation failed"])
    }

    var fileURL = url
    if fileURL.pathExtension.lowercased() != "png" {
        fileURL = fileURL.appendingPathExtension("png")
    }
    guard let dest = CGImageDestinationCreateWithURL(
        fileURL as CFURL, UTType.png.identifier as CFString, 1, nil
    ) else {
        throw NSError(domain: "ImageSave", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "CGImageDestination creation failed"])
    }
    CGImageDestinationAddImage(dest, cgImage, nil)
    guard CGImageDestinationFinalize(dest) else {
        throw NSError(domain: "ImageSave", code: 3, userInfo: [NSLocalizedDescriptionKey: "PNG write failed"])
    }
}
```

`savePNG` itself is untouched — existing callers (all opaque-image
generation commands) keep working exactly as before.

## 3. TS integration (`pi-agent-ext-flux2/src/commands.ts` +
`pi-agent-ext-movie-director/src/registry.ts`)

Pure data addition, identical shape to the `kontext`/`styletransfer` ports —
no new invoke key, no new spawn code (`commands.ts`'s declarative `COMMANDS`
map + `invoke.ts`'s generic spawn already handle any registered
subcommand). Field shape mirrors the existing `segment` entry (no
`acceptsGlobals`, explicit `output`):

```ts
cutout: {
  name: "cutout",
  writesImage: true,
  when: "Transparent-background cutout: SAM3 text segmentation → alpha-composited RGBA PNG. No regeneration — subject pixels preserved verbatim.",
  fields: {
    input: { flag: "--input", type: "string", isPath: true, description: "Source image path." },
    subject: { flag: "--subject", type: "string", description: "SAM3 text prompt for the subject to cut out (e.g. 'woman', 'coffee cup'). Falls back to --prompt if omitted." },
    prompt: { flag: "--prompt", type: "string", description: "Fallback subject text if --subject is omitted." },
    samThreshold: { flag: "--sam-threshold", type: "number", description: "SAM3 detection score threshold (0-1). Default 0.3." },
    trim: { flag: "--trim", type: "boolean", description: "Crop the result to the alpha bounding box + 5% margin." },
    saveMask: { flag: "--save-mask", type: "boolean", description: "Also save the SAM3 mask + a green-tint overlay alongside the cutout, for inspection." },
    output: { flag: "--output", type: "string", isPath: true, description: "Output RGBA PNG path." },
  },
},
```

`pi-agent-ext-movie-director/src/registry.ts` — `runpy_image`'s
`commands[]` drops `"cutout"`; `flux2_image`'s `commands[]` gains it.
`flux2_image.notes` gets an arrival sentence (same pattern as the
`kontext`/`styletransfer`/`inpaint`/`faceswap` entries already there);
`runpy_image.notes` gets a matching departure sentence.

## 4. Verification plan

1. Build `CutoutCommand`, confirm it runs end-to-end locally against a real
   input image (no crash, valid RGBA output, background visibly
   transparent, subject visibly preserved) before touching the TS layer.
2. `compare_cutout_e2e.py` (new file, same shape as
   `compare_kontext_e2e.py`/`compare_styletransfer_e2e.py`) — a real content
   image + fixed `--subject`/`--sam-threshold` through both `run.py image
   cutout` (real `--input`, not `--self-test`) and `flux2 cutout`, compare
   the final RGBA output pixels (cosine similarity / mean/max diff
   thresholds on both RGB and alpha channels). `--save-mask` debug files are
   NOT compared (see §1.5 for why).
3. Swift unit tests: `savePNGRGBA` round-trip (write then re-load via
   `Flux2ImageLoad`, assert alpha values survive within quantization
   tolerance), `trimToAlpha` bbox math (pure function, testable without SAM3
   — construct a synthetic alpha array with a known non-zero region and
   assert the returned crop bounds).
4. TS: unit tests for the new `commands.ts` entry (field-order/subcommand-
   count tests, same pattern `commands.test.ts` already has for `kontext`/
   `styletransfer`) and a `selector.test.ts` addition asserting
   `selectProvider("image_generation", {command:"cutout"})` routes to
   `flux2` / `swift:flux2`.
5. `bun run --cwd bun-apps/gui-movie-director check:schema` to confirm the
   registry change doesn't break schema validation.

## Out of scope

- `--feather`/`--fill-holes` configurability (see Scope above) — deferred,
  not dropped; would require new bridge flags with no driving caller yet.
- Python's `--self-test` synthetic-source generation — deferred, same
  precedent as `kontext`/`styletransfer`.
- Byte-level parity of `--save-mask` debug output with Python — an
  intentional, documented deviation (§1.5), not a gap to close later.
