# pi-agent-ext-ltx — TODO

Open work for this extension, roughly in priority order. See `README.md` for
the current command surface and `../../swift/ltx-video-director/PLAN.md` /
`docs/TODO.md` for the underlying Swift CLI's own roadmap (this package only
wraps that CLI — it doesn't own the generation logic).

## 1. `native-upscale`'s hd-mode result parsing is incomplete — DONE

`src/result.ts`'s `buildNativeUpscaleDetails` now also parses
`firstMatchLine(stdout, /\[restoration\]\s*\d+ frames:\s*(\S+)/)` into
`extraOutputs.restoredFrames`, alongside the existing `frames`/`mp4` keys.
Covered by a new hd-mode stdout fixture in `src/result.test.ts`.

## 2. `binary.ts`'s metallib build failure is silently swallowed — DONE

`buildMetallib` still treats a failed `setup-metallib.sh` run as best-effort
(no rejection — the right call, see `project_ltx_swift_native_port` memory),
but now checks whether `mlx.metallib` actually exists after the subprocess
resolves; if not, it forwards a clear `onProgress` warning (not a hard
failure) instead of leaving the agent to discover the real cause only when
the first MLX call crashes downstream.

## 3. `hd` mode is unverified against a real checkpoint (upstream gap, tracked here for visibility)

`native-upscale --mode hd`'s restoration IC-LoRA files
(`mlx-models/lora/ltx-2.3-restore/*.safetensors`) are user-downloaded,
gitignored external binaries — not present in any environment this package
has been tested in so far. The Swift-side mechanism (LoRA fusion +
`VideoConditionByReferenceLatent` reference conditioning) is real and
parity-tested at the tensor-math layer (see
`NativeUpscaleStageRealCheckpointTests.testGenerateHDMissingLoraThrowsNamedError`
and `VideoConditionByReferenceLatentParityTests`), but end-to-end generation
quality through this wrapper is unverified.

**Next step once the LoRA files are available**: run
`ltx native-upscale --mode hd` through this extension (not just the raw
Swift binary) end-to-end, confirm `details.output`/`extraOutputs` parse
correctly for the two-stage stdout, and do a visual-inspection pass (this
package's own established practice — shape/exit-code checks alone have
missed real bugs before, see `NativeUpscaleStage`'s color-fringing incident
in PLAN.md).

## 4. No test coverage for the hd-mode CLI fields on this side — DONE

`src/commands.test.ts` now covers `mp4: true`/`false` on both `native-i2v`
and `native-upscale` (inverted-flag path), and asserts
`restorationLora`/`upscaleLora` are in `pathFieldKeys(COMMANDS["native-upscale"])`
(i.e. validated by `validateOptionPaths` before ever reaching the binary).

## 5. `build:bundle` has never been run+verified for this package — DONE

Ran `bun run build:bundle` → produced
`dist/pi-extensions/pi-agent-ext-ltx.bundle.js` (6.44 MB) cleanly. Verified
end-to-end with `LTX_VIDEO_REPO_ROOT=<repo root> bun-apps/pi-agent/run.sh -e
dist/pi-extensions/pi-agent-ext-ltx.bundle.js -p "list installed LTX-2.3
transformer variants"` — a real `ltx models` call through the bundle
(not source mode), which correctly resolved `LTX_VIDEO_REPO_ROOT` and
listed all 3 installed transformer variants (`dev`/`distilled`/`dasiwa`).

## 6. `models` command has no structured output

`buildTextDetails` (the fallback for `models` and anything unrecognized)
just carries raw stdout — an agent asking "which transformer variants are
installed" gets a text blob to parse itself instead of a `string[]`. Low
priority (the raw text is small and stable), but if `models` output ever
needs to be *consumed* programmatically (e.g. an extension that validates a
`--transformer` value before calling `native-i2v`), this is the place to add
a dedicated `buildModelsDetails` parser.

## 7. `options` param serialized as a JSON string killed every tool call — DONE

Found via a real A/B upscale-verification run driven through the actual
`ltx` pi-agent tool (not `bun test`): `native-i2v` silently dropped
`--prompt` and `gate` rejected its `videos` array, both with confusing
errors. Root cause: `options` is declared `Type.Any()`, and the model/
provider pair in play serializes it as a JSON **string** rather than a
nested object — `key in options` then throws "options is not an Object" on
a string, discarding the whole call. `pi-agent-ext-flux2` had already hit
and fixed the identical issue (`coerceOptions()`); ported that fix verbatim
to `extensions/pi-ltx.ts` + 3 regression tests in `pi-ltx.test.ts`. Reran the
exact same 3 tool calls afterward through the real `ltx` tool (no bypass) —
all succeeded. 96/96 tests pass.

## 8. `gate --json` misreported a valid file as "could not read/probe video" — DONE (swift-side, tracked here since it was found through this package's own tool)

Same A/B run: `gate` on `native-upscale`'s own mp4 output (video-only, no
`--refine-audio` given) returned `"could not read/probe video"` — but
`ffprobe`/a standalone AVFoundation probe both confirmed the file was
completely valid. Traced (not guessed) to the real cause: `VideoGateVerdict`
evaluates fine, but its `meanDBFS` field is `-.infinity` for audio-less
clips, and Swift's `JSONEncoder` throws `EncodingError.invalidValue` on any
non-finite `Double` — silently swallowed by `GateCommand.swift`'s `try?
encoder.encode(...)` and mapped to the wrong, misleading reason. Fixed with
`encoder.nonConformingFloatEncodingStrategy = .convertToString(...)`; see
`swift/ltx-video-director/docs/TODO.md` for the full writeup + regression
tests (`VideoGateTests.swift`). A grep for the same pattern found and fixed
a second, worse instance in `I2VCommand.swift`'s `--json-out` (silently
dropped the whole `gate` key instead of even printing a wrong error).

**Consequence to keep in mind when calling this tool**: `native-upscale`
without `refineAudio` produces a video-only mp4. Gate it with
`expectVoice:false` (or pass `refineAudio: <base>/audio.wav` to
`native-upscale` if you want the upscaled clip to carry audio) — gating it
with the default `expectVoice:true` will correctly FAIL on "no audio track
present," which is not a bug, just an honest result now.

## 9. Audit sibling pi-agent-ext-* packages for the same `Type.Any()` options bug — DONE

Grepped `bun-apps/pi-agent-ext-*/extensions/*.ts` and `src/*.ts` for
`options: Type.Any(` / any loosely-typed options param. Only 3 packages
exist: `pi-agent-ext-flux2` and `pi-agent-ext-ltx` share the exact
`options: Type.Any({...})` shape (both already fixed with `coerceOptions()`
— item 7). `pi-agent-ext-power-tool` (`src/index.ts`) types every tool's
parameters as an explicit `Type.Object({...})` with named, individually
typed fields — no catch-all `options: Type.Any()` bucket, so the
JSON-string-serialization failure mode this bug depends on (a provider
serializing a whole options blob as one string) doesn't apply there. No
further packages to fix; closing this out as a clean audit rather than a
found-and-fixed item.

## 10. Extend the live-e2e workflow with the A/B upscale + ffprobe cross-check that found items 7 & 8 — DONE

Added an opt-in `includeUpscaleAB` step to
`bun-apps/pi-agent/run-dir/workflows/ltx-live-e2e.js` (default `false` — real
generation + upscale, ~5-10 min of MLX compute, same reasoning as the
existing `includeVideo` gate). When set, it runs the exact chain that found
items 7 and 8 for real, through the actual `ltx` pi-agent tool:
1. `native-i2v` (upscale:false, mp4:true) → base clip.
2. `native-upscale` (mode:fast, mp4:true) → upscaled clip.
3. An **independent** `ffprobe -show_entries stream=width,height,nb_frames,duration`
   call on both mp4s directly (via `Bun.spawnSync`/child_process in the
   scratch script — deliberately not the tool's own self-reported dims) —
   asserts upscaled width/height are exactly 2× base in both dimensions and
   duration matches within 0.1s tolerance, with the actual measured numbers
   recorded in the step detail so a human can check the arithmetic.
4. `gate` both clips with `expectVoice:false` (per item 8's finding —
   `native-upscale` without `--refine-audio` is legitimately audio-less) —
   asserts neither reports a "could not read/probe video" false negative.

Usage: `workflow` tool, `background:false`, script =
`ltx-live-e2e.js`, `args: { includeUpscaleAB: true }` (combine with
`includeVideo: true` to also run the plain native-i2v smoke in the same
pass).

Actually ran the default lane + `includeVideo:true` for real (not just
type-checked) and it found two real bugs in the *workflow script itself* on
the first pass, both fixed and reverified:
- `gate` doesn't accept still images despite an earlier version of this
  script assuming "gate accepts images too" — confirmed by a real run: the
  binary rejected a t2i PNG with `"could not read/probe video"`. Fixed by
  dropping `gate` from the default (image-only) lane entirely and only
  running it under `includeVideo:true`, against `native-i2v`'s real mp4.
- `runLtx`'s path validator rejects `/tmp` outright (only the repo root,
  models root, or `../video_generation__output` are allowed —
  `src/paths.ts`'s `resolveOutputDir`). The script's scratch *code* file can
  stay in `/tmp`, but every path passed as a `runLtx()` option must resolve
  under the allowed output root. Fixed by computing `OUT_DIR` from
  `resolveOutputDir`'s convention and writing all generated artifacts there.
- (Also bumped the smoke config's `seconds` from `0.5` to `1.2` — the
  0.38s clip that `0.5` snaps to at LTX's 8k+1 stride legitimately fails
  `VideoGate`'s 1.0s minimum-duration check; that's correct gate behavior,
  not a bug, but it made the smoke's own `overallOk` red for the wrong
  reason.)

Final verification run (`includeVideo:true`, real MLX compute, ~200s):
`models` ok, `t2i` ok (4.3s), `native-i2v` ok (57.6s, real `video.mp4`),
`gate` ok (status=PASS) — **overallOk: true**.

Then ran `includeUpscaleAB:true` for real too (~460s, real generation +
upscale both ways) — found and fixed a **third** real bug the same way:
the prompt told the subagent to pass the base run's **mp4** as
`native-upscale`'s `--input`, but that field is actually a PNG
`frame_%04d.png` **directory** (`native-i2v`'s own `frames/` output) — see
`commands.ts`'s `native-upscale.fields.input` description. The subagent
self-corrected at runtime (used `frames/` instead, kept the mp4 only for
the ffprobe dimension baseline) and the run still passed, but the workflow
prompt itself was still wrong and would trip up a differently-behaved
model/run. Fixed by rewording step 2 in the `UpscaleAB` agent prompt to
name the `frames/` directory explicitly instead of leaving it to be
inferred.

**Full A/B result, with the actual independent ffprobe numbers** (not the
tool's self-report): base clip `640×960`, `1.041667s`; upscaled clip
`1280×1920`, `1.041667s`. All three assertions held — width exactly 2×,
height exactly 2×, duration matched within tolerance. `gate-base` and
`gate-upscaled` both passed cleanly (the exact upscaled-clip case that used
to trigger the JSON-encoder false negative before item 8's fix — confirmed
still fixed under real load). **overallOk: true** for the full workflow
(smoke + UpscaleAB combined).

Net: this session's real (not just type-checked) execution of `ltx-live-e2e.js`
found and fixed **three** genuine bugs in the workflow script itself (gate
vs. still-image input, `/tmp` vs. the allowed output root, mp4 vs. frames-dir
for `native-upscale --input`) before it could reliably serve as the
repeatable regression check item 10 set out to build. The workflow is now
proven to pass end-to-end, twice, with real MLX compute both times.

This is the three-tier test plan going forward for this package: `bun test`
(unit — args/parsing/paths), `ltx-live-e2e.js` default lane (wiring — real
binary via the real pi-agent tool), and `includeUpscaleAB` (semantic
correctness — did the generation actually do the right thing, verified
independently of the tool's own claims).

Looked into VMAF/SSIM-based quality scoring as a further-out idea (Netflix's
`libvmaf` via ffmpeg, used in video-encoder CI to catch perceptual
regressions, not just dimension/duration correctness) — deliberately not
added here: it needs a `libvmaf`-enabled ffmpeg build, careful
reference/distorted resolution alignment (never downscale the master —
upscale the distorted to match, per common CI pitfalls), and a real quality
threshold (e.g. `VMAF_mean >= 90`) that this repo hasn't established for its
own upscale path yet. Worth a dedicated follow-up item once
`native-upscale --mode hd` (item 3) has real checkpoint output to calibrate
against — grading a fast-mode upscale on VMAF today would just be inventing
a threshold with nothing to validate it.

## Not planned

- Bit-exact parity between `native-upscale --mode hd` and the run.py-bridged
  `ltx-video upscale`'s IC-LoRA output — deliberately out of scope, see
  `NativeUpscaleStage.generateHD`'s doc comment in the Swift package. This
  wrapper will surface whatever the Swift CLI produces; it doesn't
  reimplement or second-guess the generation algorithm.
