# `native-relay --variant` A/B comparison (2026-07-05)

Closes the last `native-relay` "still open" item. `--variant
name[=lora_path[:strength]]` (repeatable) runs the full relay once per
variant to its own `<output>/<name>/` subdirectory, catching per-variant
errors, printing a plain-text summary table. Only "which LoRA" varies
(this native port is distilled-only, unlike Python's dev/distilled +
cfg/stg toggle); no HTML side-by-side reviewer (no Swift-side
equivalent to `video-review.py`). Real 2-variant end-to-end run
(`baseline` vs `vbvr-licon-390k`) confirmed both ran independently and
the LoRA genuinely fused only in the `vbvr` run (per-run log evidence).
No dedicated unit test (CLI-orchestration logic, no existing CLI test
harness in this package) — the real run is the verification. With this,
all three of `native-relay`'s originally-scoped-out items (audio
overlay, TTS, variant A/B) are done. See PLAN.md's matching milestone.

# `native-relay --relay-tts-text` narration (2026-07-05)

Follow-up to `--relay-audio` — TTS narration item. New `MacTTS.swift`
shells out to macOS's built-in `say` (voice "Meijia"/145wpm defaults,
matching the Python version; `edge-tts` not ported — external
network/PyPI dependency, out of scope for a native port). Writes AIFF
directly, which `VideoConcatenator.replaceAudioTrack` already reads
natively — no ffmpeg conversion step needed. Wired into `native-relay
--relay-tts-text` by feeding the synthesized AIFF into the SAME
`audioOverlayPath` mechanism the audio-overlay milestone just built. 2
new `MacTTSTests` using a real `say` invocation (fast, local, no mock
needed) — caught a wrong assumption along the way (unknown voice names
don't make `say` fail, an unwritable output path does; verified
manually, not guessed).

# `native-relay --relay-audio` custom audio overlay (2026-07-05)

Follow-up to `native-relay`'s "still open" list — the custom audio
overlay/replace item. New `VideoConcatenator.replaceAudioTrack` (video
track from the concatenated relay + audio track from a user-supplied
file, via `AVMutableComposition`) wired into `Request.audioOverlayPath` /
`--relay-audio <path>`. AVFoundation decodes WAV/MP3/M4A/AAC natively —
matches the Python `mix`/`replace`/`keep` mode set's default (`replace`
only; `mix`/`keep` not ported) without needing ffmpeg. 7/7 new+existing
tests pass, all using real (non-mocked) mp4/wav files. See PLAN.md's
matching milestone for the full writeup.

# `native-upscale --mode hd` restoration LoRA pair FOUND + verified (2026-07-05)

Standing backlog item, blocked across two prior sessions as "doesn't exist
in that form" (not "nobody's tried"). A fresh search this session found a
genuinely new, non-gated match: `joyfox/LTX2.3-ICEdit-Insight` on
HuggingFace (Apache-2.0) contains BOTH required files
(`ltx2.3-video-restoration-general.safetensors` +
`ltx2.3-ic-video-upscale-general.safetensors`) by their exact expected
filenames — confirmed via the HF API, not guessed. Downloaded both
(100.8 MB + 327.3 MB), externalized to the external model store + symlinks
(same primitive this session's `import-lora-image.py` fix uses — the
target directory's `.raw-download` marker predates the externalization
convention and doesn't exempt it from "never commit raw safetensors").
`check-model`: 66/66 pass.

Real end-to-end `native-upscale --mode hd` run against a real 25-frame
clip: 109.2s wall, all 5 stages completed, 1280×1920 output + muxed mp4.
Visually confirmed: same scene, genuinely higher resolution, with a
moderate fur-texture over-sharpening artifact from this particular
LoRA pair's own training (not a correctness bug). New
`NativeUpscaleStageRealCheckpointTests.testGenerateHDProducesRestoredUpscaledFrames`
— 10/10 suite pass (1 pre-existing unrelated skip). See PLAN.md's
matching milestone for the full writeup.

# VBVR reasoning LoRA verified native + `--input-image` generalization (2026-07-05)

Standing backlog item (`run.py video vbvr`'s native-port target). Turned
out to need ZERO new fusion code: VBVR is just I2V + a specific reasoning
LoRA, and `native-i2v --lora` already fuses arbitrary LoRAs onto the
distilled transformer — the Python version's dev-pipeline requirement
("distilled has no LoRA fusion stage") doesn't apply here. All 5 VBVR
LoRA variants already exist locally under `mlx-models/lora/vbvr-*` (no
download needed). Ran `native-i2v --lora .../vbvr-licon-390k/...int8
.safetensors:1.0` for real (25 frames, 6m19s) — PASS, visually clean
throughout, matches the human-reviewed "best" (3★) LiconStudio 390K
checkpoint from `_RELAY_VARIANTS`. New `LoRAFusionTests
.testVBVRLoRALoadsAndProducesNonZeroFusionDelta` (load + non-zero-delta
regression; no vendor reference dump exists for this file).

Along the way, found and fixed a real prerequisite gap for the `relay`
backlog item: `NativeI2VStage` had no way to do I2V from an arbitrary
supplied image — frame 0 was hardcoded to always come from
`NativeT2IStage`. Added `Request.inputImagePath` / `native-i2v
--input-image <path>` (skips T2I, VAE-encodes the supplied image as
frame-0 conditioning instead), 3 new `NativeI2VStageRealCheckpointTests`
cases including a real-checkpoint chain test proving the image reaches
generation (not silently ignored).

**Same session, `native-relay` core chaining landed too** (turned out
`--input-image` was the only missing piece): new `NativeRelayStage` +
`ltx-video native-relay` chains N segments (each segment's last decoded
frame feeds the next segment's `--input-image`), mp4-per-segment via the
existing `MP4Writer`, then concatenates all segments into one final
`relay.mp4` via a new `VideoConcatenator` (`AVMutableComposition` +
`AVAssetExportSession` — pure Swift, no ffmpeg). Real 2-segment run
verified: chaining is real (segment 2's `source.png` byte-identical to
segment 1's actual last frame, visually confirmed too), concatenation is
real (`ffprobe` shows both segments' frames present in the final file).
A synthetic no-audio test case caught a real bug along the way — an empty
composition audio track (when no segment has audio) made
`AVAssetExportSession` fail outright; fixed by dropping the audio track
before export if nothing was ever inserted into it. Still open: custom
audio overlay (`--relay-audio`), TTS narration, and the variant A/B
harness — see PLAN.md's matching milestone for the full writeup.

# ASR voice-content gate (zh-TW/zh-CN aware) — landed, transcription still bridged (2026-07-04)

`output/new-goal-20260704-141422.md` item (A): the existing basic gateway
(`VideoGate`/`AudioProbe`) only measures loudness/silence — it cannot tell
"clear audible nonsense" from "clear audible correct speech", and there was
no Traditional-vs-Simplified Chinese discriminator anywhere in this repo
(Whisper's `detected_lang` only ever reports generic `"zh"`).

**Native Swift (100%, this iteration):**
- `Sources/LTXVideoDirector/CJKScript.swift` — Traditional/Simplified
  classifier via a curated ~200-character discriminating table (Han
  unification means most CJK share one codepoint across scripts, so a
  codepoint-RANGE test can't separate them; only characters whose simplified
  and traditional forms are genuinely different codepoints carry signal).
  Covered by `Tests/LTXVideoDirectorTests/CJKScriptTests.swift` (6/6 pass).
- `Sources/LTXVideoDirector/ASRGate.swift` — every decision on top of the raw
  transcript (language match, content-overlap ratio, script classification,
  PASS/WARN/FAIL) is native. Wired into `ltx-video gate --asr-prompt <p>
  [--expected-script traditional|simplified]` (`GateCommand.swift`) and
  exposed through `bun-apps/s2-agent-ext-ltx`'s `gate` schema
  (`check:flags` passes — 0 drift on this command).

**Still bridged to Python (not native):** the transcription itself. New
standalone `run.py video asr-gate --video <path> --prompt <p> --json-out
<f>` (`app/commands/video-asr-gate.py`) wraps the existing
`_run_audio_asr_gate` (`video-t2i2v.py`, `mlx_whisper` /
`mlx-community/whisper-large-v3-mlx`) so it's callable in isolation, not
just from inside the full t2i2v pipeline. `RunPyBridge` invokes it exactly
like the `i2v`/`upscale` commands already bridge their own heavy stages.

**Native Whisper port — actually started this session, not just planned.**
`python/venv` turned out to be recoverable (missing symlink to the shared
`~/proj/video_generation__venv`, not a genuinely absent environment) — once
relinked, a real `mlx_whisper` was available, which changed the plan from
"defer entirely" to "port and verify the first real piece now":
`WhisperMel.swift` (new) ports `mlx_whisper.audio.log_mel_spectrogram`
line-for-line onto `MLXFFT.rfft`/`asStrided` (added `MLXFFT` to
`Package.swift`'s mlx-swift product list), embedding the real precomputed
mel filterbank as an SPM resource. Verified against the REAL
`mlx_whisper.audio.log_mel_spectrogram` output via
`scripts/dump_whisper_mel_reference.py` + `WhisperMelParityTests.swift` —
max abs diff < 1e-3 for both n_mels=80 and n_mels=128 (large-v3's config).
**Encoder also landed same session**, verified TWO ways: (1) against the
real `mlx_whisper.whisper.AudioEncoder` class at a small random-weight
config (architecture check, no giant checkpoint needed) — 2/2 pass; (2)
against the ACTUAL cached `whisper-large-v3-mlx` checkpoint's real conv
stem + block-0 weights, run on real log-mel features from a real generated
clip's speech — max abs diff < 5e-2, 1/1 pass. `WhisperEncoder.swift` +
`WhisperEncoderParityTests.swift` + `WhisperEncoderRealCheckpointTests.swift`.

**Decoder also landed same session** — confirmed it's the SAME
`ResidualAttentionBlock` class as the encoder's (just `cross_attention=true`
added), so `WhisperAttention` only needed a `crossInput`/`mask` generalization,
not a rewrite. `WhisperDecoder.swift` + `WhisperDecoderRealCheckpointTests.swift`
verified against the real large-v3-mlx checkpoint's real token/positional
embeddings + block-0 weights on real special-token ids cross-attending to
real encoder output — max abs diff < 5e-2, 2/2 pass.

**Tokenizer (decode direction) also landed same session** —
`WhisperTokenizer.swift` embeds the real `multilingual.tiktoken` vocab
(816KB SPM resource) and decodes id→bytes→UTF-8 (no BPE-merge algorithm
needed for decode-only; that's an encode-side concern this ASR gate never
exercises). Special-token ids computed via the same closed-form arithmetic
as `get_encoding()` — caught a real gotcha: `num_languages` defaults to 99,
NOT the full 100-entry `LANGUAGES` dict (drops `"yue"`), confirmed via a
live `get_tokenizer(language="ja")` call. Verified against real
`mlx_whisper.tokenizer` output for 3 languages' SOT sequences + real decode
of two id sequences — 7/7 pass.

**Decode loop landed too — full native pipeline now exists and is wired
in.** `WhisperModel.swift`: real-checkpoint loader (all 32+32 layers) +
greedy decode (no KV cache — documented perf tradeoff, not a correctness
gap). `WhisperModelRealCheckpointTests.testTranscribesRealClipEndToEndNatively`
runs the WHOLE pipeline (mel → encoder → decode loop → tokenizer) on a
real clip's real audio with zero Python involved, bit-exact matching the
real `mlx_whisper.whisper.Whisper` class run with the identical naive
greedy strategy. Found+fixed a real bug along the way: naive greedy
predicted `<|endoftext|>` immediately (empty transcript) until the port
added mlx_whisper's `SuppressBlank` filter (mask EOT + the space token at
step 0 only). Separately confirmed (not a bug): this port's naive decode
gets a WORSE result than mlx_whisper's polished `transcribe()` on
short/ambiguous clips (temperature-fallback retries), verified by getting
the bit-identical output from real Python running the same naive strategy.
Real language auto-detection also landed (`WhisperModel.detectLanguage`,
ports `mlx_whisper.decoding.detect_language` exactly, bit-exact verified).

**`ASRGate.swift`'s default engine is now native Swift** —
`ASRGateEngine.autoDetect()` picks `.nativeSwift` whenever a converted
local checkpoint exists, `.pythonBridge` only as an availability fallback.
`WhisperMel.loadAudio(url:)` added native (AVFoundation + `LinearResampler`,
no ffmpeg) audio extraction so the default path is zero-Python end-to-end.
**Real, documented consequence**: a live `ltx-video gate --asr-prompt` run
against this port's own reference clip now FAILS (content ratio 0.00)
where the old Python-bridge default PASSED (ratio 1.0) — the naive-greedy
quality gap (no temperature-fallback) showing up as a real behavior change,
not a bug. `engine: .pythonBridge` remains available as an explicit
override until temperature-fallback retries close that gap.

**Still open**: a real KV cache (perf only) and temperature-fallback
retries (the actual remaining quality gap). Tiktoken ENCODE direction not
needed for decode-only ASR gating. Logged in `PLAN.md`'s matching entry.

Not yet done (follow-up, not this iteration): a `s2-agent-ext-ltx-self-improve`
workflow (no `.claude/workflows/s2-agent-ext-ltx-self-improve.js` exists yet —
`s2-agent-ext-flux2-self-improve.js` is the reference template) whose
live-e2e lane would exercise this new gate end-to-end.

# All four ComfyUI FFLF+Custom-Audio parity gaps — SOLVED (2026-07-04)

`/goal solve this gaps` — closes out all four gaps found by the function
audit below. Three shipped real code + regression tests; the fourth was
confirmed to already be correct (not actually a gap).

1. **FFLF per-slot strength + auto-resize — IMPLEMENTED.**
   `NativeI2VStage.Request` gained `lastFrameStrength: Float = 1.0` and
   `lastFrameAutoResize: Bool = false`. The last-frame conditioner is now
   applied as its OWN `VideoConditionByLatentIndex` call (chained after
   frame-0's, not concatenated into one shared-strength call), so it can
   carry an independent strength. Auto-resize uses a new
   `FrameLoad.resizeAspectFillCenterCrop` (bicubic, aspect-fill + center
   crop, matching the reference `MultiImageLoader`'s convention) — opt-in
   via `--last-frame-auto-resize`, default off (preserves the existing
   fail-fast-on-mismatch convention). New CLI flags: `--last-frame-strength`,
   `--last-frame-auto-resize`. Two new real-checkpoint regression tests in
   `NativeI2VStageFFLFTests.swift`: auto-resize (wrong-size + wrong-aspect
   input, still matches within the existing tight tolerance since a solid
   color survives resize losslessly) and strength (0.0 vs 1.0 measurably
   diverge — 1.0 stays under the existing 0.04 tolerance, 0.0 is
   significantly higher). Both pass on real generation (56.9s, 353.4s).

2. **Half-res `ImageScaleBy` "guide pass" — RESOLVED, wasn't a quality
   pass at all.** Traced the actual link graph (not just widget values):
   `ImageScaleBy(bilinear, 0.5)` feeds `GetImageSize`, which feeds
   `EmptyLTXVLatentVideo`'s width/height inputs directly. This is pure
   resolution auto-derivation — the reference computes the BASE generation
   resolution as half the user's FFLF image size, then its Stage #2 2x
   upscale brings it back to that image's own resolution. Implemented the
   equivalent: `native-i2v --last-frame-derives-resolution` derives
   `--width`/`--height` as half the `--last-frame` image's dimensions
   (snapped to the nearest 32), overriding any explicit `--width`/`--height`,
   and implies `--last-frame-auto-resize` (the full-resolution image must
   still be downscaled to the derived base resolution for conditioning).

3. **`LTXSequencer`'s per-frame denoise-mask schedule in refine — WAS A
   MISREAD, real gap found underneath it once corrected.** Read
   `ltx_sequencer.py`'s actual node source (from the WhatDreamsCost-ComfyUI
   checkout, not just the workflow JSON's widget arrays) — `LTXSequencer`
   subclasses `LTXVAddGuide` and is the SAME keyframe-insertion mechanism
   as `MultiImageLoader`, just reused inside Stage #2/#3 to RE-APPLY the
   FFLF first/last-frame guides onto the newly-upscaled latent, not a novel
   per-frame refine-strength schedule. The real, previously-undocumented
   gap this exposes: `NativeUpscaleStage.refine()` had NO re-pinning at
   all — an FFLF-conditioned clip's first/last frames could drift during
   the low-strength re-denoise. Fixed: `refine()`/`generate()` gained
   `preserveFirstAndLastFrame: Bool`, which re-applies
   `VideoConditionByLatentIndex(strength: 1.0)` at frames `[0, F-1]` using
   the ALREADY-UPSCALED clean tokens (not the original images — they
   already represent the pinned content at the new resolution; this only
   stops the refine denoise from letting it drift). Wired from both
   `native-i2v --upscale --refine --last-frame` (automatic) and standalone
   `native-upscale --preserve-first-last-frame` (opt-in, for chaining after
   a separate `native-i2v --last-frame` run).

4. **`VAEDecodeTiled`'s spatial tiling vs. this package's temporal-only
   tiling — CONFIRMED NOT A GAP.** `VideoTiling.swift`'s own header already
   states the vendor reference's real AUTO-tiling logic
   (`_compute_decode_tiling`) is temporal-axis only — "spatial tiling
   exists there but is never auto-selected." `VAEDecodeTiled`'s spatial
   tile/overlap parameters are a ComfyUI-specific MANUAL override knob, not
   part of the automatic behavior this package mirrors. No code change;
   this package already matches the reference's real tiling strategy.

Full writeup with exact link-graph traces and source-code citations in
`docs/reference/comfyui_workflows/README.md`'s "Fourth pass" section.

# Exhaustive function audit vs ComfyUI FFLF+Custom-Audio workflow — VERIFIED (2026-07-04)

`/goal verify if we have implemented all function of the ComfyUI workflow`
against `LTX I2V FFLF Custom Audio Workflow ... V3.json` specifically (not
a general survey — a real function-by-function checklist). Full writeup in
`docs/reference/comfyui_workflows/README.md`'s "Third pass" section and a
matching `PLAN.md` entry.

**Bottom line**: the large majority of this file's functionality is
already implemented and matches (euler sampler, Stage #1's schedule, the
2x latent upsampler + checkpoint, `--lora` strength, the text/audio/video
encoders+VAEs, custom-audio mask-preservation, FFLF conditioning, the mp4
mux, CFG=1). Four gaps found, none previously documented:
1. Upscale refine's per-frame denoise-mask schedule (`LTXSequencer`) —
   Swift uses one uniform mask, not a per-segment schedule.
2. A half-res `ImageScaleBy` guide/preview pass with no Swift equivalent —
   purpose (preview-only vs. quality-affecting) not yet confirmed.
3. FFLF's per-slot strength/resize-mode/crop-position — Swift requires an
   exact-size input and hardcodes strength 1.0.
4. `VAEDecodeTiled`'s spatial tiling vs. this package's temporal-only
   tiling — a different strategy, not confirmed to be a functional gap.

Also corrected a cross-file conflation from the first research pass: this
V3 file has only Stage #1/#2 (no Stage #3), and its Stage #2 runs 4
steps/shift 0.42 — the "6 steps" figure in the first pass's diagram was
from the sibling 3-stage workflow, not this one.

Nothing implemented this pass — pure verification. See
`bun-apps/s2-agent-ext-ltx/TODO.md` if any of the four gaps get scoped into
that package's wrapper surface once ported.

# `MP4Writer` deadlocked on real audio+video FFLF clips — FIXED (2026-07-04)

Driven by a live, user-directed proof: "prove FFLF works" via the real
`s2-agent` CLI + `ltx` tool, same pattern as an independent Flux-tool
verification the user ran in parallel (`t2i` → `t2i` → `native-i2v
--last-frame`, natural-language prompt, local model, real generation, no
mocks). The run hung indefinitely — `video.mp4` sat at 0 bytes for 15+
minutes with the `ltx-video` process at ~0% CPU.

Diagnosed with `sample` (not guessed): the process's stack showed the main
thread parked in `MP4Writer.write(...) → appendVideoFrames → NSThread
sleepForTimeInterval → nanosleep`, i.e. permanently stuck in
`appendVideoFrames`'s `while !input.isReadyForMoreMediaData { Thread.sleep
(...) }` poll — before `appendAudio` had even been called once. Root cause:
`write()` appended **all** video frames to completion first, only starting
the audio input afterward. AVAssetWriter throttles `isReadyForMoreMediaData`
on whichever input runs furthest ahead in presentation time, to bound its
own internal buffering, and expects the *other* declared input to be
actively draining in parallel to relieve that throttle — video, with a
never-touched audio input sitting at zero samples, ran far enough ahead to
trip that throttle and never got released.

**Why the existing tests missed it**: `MP4WriterTests.testWriteVideoWithAudio`
uses an 8-frame/1s synthetic clip — small enough that the writer's internal
threshold for "one track is too far ahead" is never crossed. It took a real
~2s/49-frame 640×960 FFLF clip (the same reproduction size as the actual
user-facing failure) to hit it.

Fix (`MP4Writer.swift`): video and audio inputs are now fed **concurrently**
— a `DispatchGroup` with one `DispatchQueue.global` task per track, instead
of a sequential video-then-audio append — matching how AVAssetWriter
actually expects multi-track muxing to be driven.

New regression test,
`MP4WriterTests.testWriteVideoWithAudioAtRealisticScaleDoesNotDeadlock`:
49 frames at 320×480 with a duration-matched real audio track, wrapped in
an `XCTestExpectation` with a 60s timeout so a reintroduced deadlock **fails
fast** instead of hanging the whole test suite. Passes in 1.1s post-fix (an
infinite hang pre-fix). `MP4WriterTests`: 4/4 pass.

**Re-verified end-to-end, not just unit-tested**: reran the exact same FFLF
proof (`native-i2v --last-frame`, real generation, real audio) through the
rebuilt release binary via the real `s2-agent` CLI. Completed cleanly.
Independent `ffprobe` on the output (not the tool's own self-report):
`video: h264, 1280×1920, 49 frames` / `audio: aac, 97 frames` / `duration:
2.041667s` (requested `--seconds 2.0`) — both tracks present, valid
container, matches the requested duration.

**Scope**: this deadlock would have hit *every* real `--mp4` output that
also carries audio at non-trivial scale (any `native-i2v` run without
`--no-mp4`/`--no-refine-audio` shenanigans, not just FFLF specifically) —
it was silent (no error, no crash, just an unbounded hang) until reproduced
live at real generation scale.

# `gate --json` false negative on audio-less clips — FIXED (2026-07-04)

Driven by `s2-agent-ext-ltx`'s live A/B upscale-verification run (chain
`native-i2v` → `native-upscale` → independent `ffprobe` cross-check → `gate`
on both outputs, through the real s2-agent `ltx` tool — see that package's
`TODO.md` items 7-10). `native-upscale`'s own mp4 output (video-only, no
`--refine-audio` given) came back from `gate --json --no-expect-voice` as
`"could not read/probe video"` — but an independent `ffprobe` AND a
standalone AVFoundation probe both confirmed the file was completely valid
(1 video track, correct dims, readable).

Traced rather than guessed, in order: (1) reproduced directly against the
release binary, ruled out the voice-check business-logic path (fails
identically with `--expect-voice`/`--no-expect-voice`); (2) a standalone
AVFoundation probe confirmed both the base and upscaled files parse fine —
`isReadable=true`, correct track counts; (3) instrumented
`VideoGate.evaluate()`'s `try?` with a real `do/catch` + stderr print,
rebuilt, reran on the failing file — **nothing printed**, meaning
`evaluate()` never actually throws for this file; (4) re-read
`GateCommand.swift`'s JSON branch with that constraint and found it treats
*any* JSON-encoding failure of the verdict the same as "couldn't read the
file," not just a thrown `evaluate()` error; (5) confirmed with a minimal
isolated repro that `JSONEncoder` throws `EncodingError.invalidValue` on a
non-finite `Double` — and `VideoGateVerdict.meanDBFS` is set to
`-.infinity` whenever a clip has no audio track (exactly this file's
situation). The thrown encoding error was silently caught by `try?
encoder.encode($0)` and mapped to the wrong, misleading reason string.

Fix (`GateCommand.swift`): `encoder.nonConformingFloatEncodingStrategy =
.convertToString(positiveInfinity: "inf", negativeInfinity: "-inf", nan:
"nan")` before encoding each verdict. The real verdict now survives
encoding intact — re-run on the same file reports its honest reasons
(`"video duration too short"`, `"no audio track present"` when
`--expect-voice`) instead of the false "unreadable" message.

New `Tests/LTXVideoDirectorTests/VideoGateTests.swift` (2 tests): builds a
real audio-less mp4 via `MP4Writer` (same convention as
`MP4WriterTests.swift` — read the write path's own output back, don't just
check it didn't throw), asserts `VideoGate.evaluate` returns a normal
verdict with `meanDBFS == -.infinity`, and asserts the **default**
`JSONEncoder` throws on that verdict while the fixed
`.convertToString`-configured one succeeds — documents both why the bug
happened and that the fix holds. Full suite: **124/124 pass** (1 skipped —
the unrelated hd-mode real-checkpoint test, still blocked on missing LoRA
files, see `NativeUpscaleStageRealCheckpointTests`).

**Not fixed by this, and not a bug**: `native-upscale` without
`--refine-audio` still produces a video-only mp4 — `gate`'s default
`--expect-voice` correctly FAILs it with `"no audio track present"`. Pass
`--no-expect-voice` when gating a deliberately video-only output, or
`--refine-audio <base>/audio.wav` to `native-upscale` if the upscaled clip
should carry sound.

## Second confirmed instance found + fixed the same day: `I2VCommand.swift`'s `--json-out`

A grep for other `JSONEncoder`/`VideoGateVerdict` call sites (prompted by
the fix above) turned up `I2VCommand.swift:108` — `i2v --self-verify
--json-out` encoded the same `VideoGateVerdict` with the same bare `try?
JSONEncoder().encode(v)`. Worse than the gate command's version: this one
doesn't even emit a misleading error, it silently **omits the whole `gate`
key** from the JSON output whenever the generated clip's gate verdict has
`meanDBFS == -.infinity` (i.e. any audio-less video, though `i2v`'s own
production path normally generates audio so this was rarer to hit than
`native-upscale`'s case). Fixed with the identical
`nonConformingFloatEncodingStrategy` before encoding. No dedicated test
added here (no existing CLI-level test harness for `I2VCommand`'s
`--json-out` — it bridges through `RunPyBridge`, real generation only); the
`VideoGateTests.swift` coverage of the underlying `JSONEncoder` behavior
already documents why this class of fix is needed.

Any *other* `Codable` struct with a `Double`/`Float` field that could
plausibly be `.infinity`/`.nan` (e.g. `VLMVerify`'s score types, if any) is
still worth a scan before it causes a third silent incident — but the two
known real call sites (`gate`, `i2v --json-out`) are both fixed now.

# Upscale refine pass — DONE (2026-07-03)

Driven by `/goal generate high quality First-Last-Frame image generation`.
Closes the exact gap `NativeUpscaleStage`'s own header had been documenting
since it landed ("no refine pass... a bounded follow-up... not implemented
here yet") and that the ComfyUI reference-workflow research (finding 1)
quantified: the real two-stage pipeline follows its neural upscale with a
LOW-STRENGTH transformer denoise refinement (not a fresh generation) —
without it, `native-i2v --upscale`'s output (which FFLF runs through by
default) is visibly over-sharpened/halo-prone, undermining "high quality"
for exactly the FFLF+upscale combination the goal asked about.

`NativeUpscaleStage.generate` gained optional `refinePrompt`/
`refineAudioURL` params (+ `native-upscale`'s `--refine-prompt`/
`--refine-audio` CLI flags, and `native-i2v`'s `--refine`/`--no-refine`,
on by default alongside `--upscale`): when supplied, the upscaled
(still-normalized) video latent is forward-noised to
`SigmaSchedule.stage2Sigmas[0]` (an existing, already-named-for-this
constant, previously unused) and re-run through the real 48-block
distilled transformer over that 3-step schedule via
`DenoiseLoop.runStreaming` — the same mechanism `NativeI2VStage` uses for
the base generation, just starting from partial noise instead of pure
noise, with a uniform (not per-token) denoise mask since nothing is
"preserved," everything is lightly re-denoised. The audio track (e.g.
`native-i2v`'s own `audio.wav`) is re-encoded via the audio VAE encoder
from this session's `--audio-track` work and pinned fully preserved
(denoiseMask=0 everywhere) — audio itself isn't refined, it's only there
so the joint audio-video transformer has a valid audio branch to attend
to, which is why refine requires an audio track even though it doesn't
change it.

Verified real-checkpoint: same synthetic input frames, upscale-only vs.
upscale+refine produce measurably different first-frame output (mean abs
diff well above the 1e-4 threshold — same "prove it's wired" bar
`NativeI2VStageAudioTrackTests` established for `--audio-track`), plus a
fast-path validation test confirming `--refine-prompt` without
`--refine-audio` throws a clear `.refineNeedsAudioTrack` error before any
expensive work. 3 new tests, all passing (full-suite re-run separately
confirmed the touched real-checkpoint suites — `NativeI2VStageFFLFTests`,
`NativeI2VStageAudioTrackTests`, `NativeUpscaleStageRealCheckpointTests`
— all still green; a from-scratch full run was interrupted by an
unrelated background-shell timeout mid-way through, not a test failure).

**Visually confirmed at production resolution** (640x960 FFLF -> 2x
upscale, real T2I-generated `source.png` pinned as `--last-frame`, real
prompt/text-encode/transformer throughout): upscale-only output shows
exactly the artifact this session set out to fix — hair strands have
visible sharpening halos, skin has a painterly/oil-canvas texture, and
the jacket's woven pattern is muddy and semi-incoherent. The SAME frame
through the refine pass shows natural skin texture, a coherent plaid
weave on the jacket, and clean hair strands with no halos — a clear,
unambiguous quality improvement, not just a numerically-different output.
This directly answers the `/goal generate high quality First-Last-Frame
image generation` — FFLF's default `native-i2v` output path
(`--upscale --refine`, both on by default) now produces meaningfully
higher-quality results than before this session.

# Custom audio injection (`--audio-track`) — DONE (2026-07-03)

Follow-up to the ComfyUI reference-workflow research (finding 5, "Custom
Audio" subgraph: `LTXVAudioVAEEncode` + `SetLatentNoiseMask`). Ported the
reverse (encode) direction of the audio path so a user-supplied WAV can be
pinned as preserved audio conditioning instead of letting audio generate
from scratch — the audio-modality analogue of FFLF's video-frame pinning.

New pieces, all in `Sources/LTXVideoDirector/`:
- `WAVReader.swift` — minimal canonical PCM WAV reader (PCM16/Float32), the
  inverse of the existing `WAVWriter.swift`.
- `Vocoder/LinearResampler.swift` — arbitrary-ratio linear-interpolation
  resampler (any input rate → 16kHz `AudioProcessor` expects). Documented
  as a deliberate "honest limitation": not anti-aliased, adequate for
  speech/dialogue, same convention as `NativeUpscaleStage`'s no-refine-pass
  note.
- `AudioVAE/AudioProcessor.swift` — native STFT + Slaney mel filterbank
  matching `torchaudio.transforms.MelSpectrogram`. No learned weights;
  verified deterministic-computation parity against
  `scripts/dump_audio_processor_reference.py` (max abs diff < 1e-2, basis/
  window diffs < 1e-4/1e-5).
- `AudioVAE/AudioVAEEncoder.swift` + `AudioVAEEncoderLoader.swift` —
  structural inverse of the existing `AudioVAEDecoder.swift`, reusing its
  `WrappedConv2d`/`AudioResBlock` building blocks. Same checkpoint file as
  the decoder (`audio_vae.safetensors` has both `.encoder.*` and
  `.decoder.*` prefixes) — no new download needed. Verified against
  `scripts/dump_audio_vae_encoder_reference.py` (real checkpoint, real
  vendor `AudioVAEEncoder.encode()`, max abs diff < 1e-2).

Wiring: `NativeI2VStage.Request.audioTrackPath` (+ `NativeI2VCommand`'s
`--audio-track <path>`) resamples the WAV to 16kHz, mono→stereo-duplicates
if needed, encodes via `AudioVAEEncoder`, patchifies with the existing
`AudioPatchifier`, and pins the resulting tokens via
`VideoConditionByLatentIndex` — the same generic conditioning mechanism
FFLF uses for video frames, reused here with `spatialDims=(N,1,1)` since
audio tokens have no spatial extent to group by frame. If the track is
shorter than the generated clip's audio-token count, only the covered
prefix is preserved; the rest still generates normally. Validates the
track file's existence before any expensive generation work (same
fail-fast convention as `--last-frame`).

Verified real-checkpoint, same-seed/prompt A/B (no reliable sample-level
diff exists for the lossy mel→VAE→vocoder roundtrip, unlike FFLF's direct
pixel diff): baseline vs. `--audio-track` output differ with mean abs diff
well above the 1e-4 threshold, proving the injected track actually reaches
generation rather than being silently ignored. Full suite: **113/113
pass** (5 new tests: 1 `AudioProcessorParityTests`, 2
`AudioVAEEncoderRealCheckpointTests`, 2 `NativeI2VStageAudioTrackTests`).

# Gemma-3-12b native text encoder — COMPLETE ✅

> **Commit/merge status (2026-07-03):** committed on branch
> `feat/swift-ltx-video-director` (final commit `2e207c9`). **NOT merged into
> `main` yet** — awaiting merge/PR decision. Gemma work itself is done; the
> unmerged branch also carries the rest of the native-port milestone
> (T2I/VLM/audio/video-decode stages, TextEmbeddingProjection, the 48-layer
> LTX transformer).

The entire Gemma-3-12b text encoder is now native Swift/MLX and verified
end-to-end against the real production model. This was the last piece blocking
a fully-native distilled I2V path (everything else — VAEs, 48-layer LTX
transformer, sampling loop, full audio stack, T2I stage, VLM prompt stage,
TextEmbeddingProjection, Embeddings1DConnector — was already native).

## Verified path: text → hidden states, all native

| Step | Component | Verified against |
|------|-----------|------------------|
| text → token_ids | `GemmaTokenizer` (standalone SentencePiece-BPE) | **byte-identical** to mlx-lm tokenizer |
| token_ids → h0 | `GemmaEmbedding` (embed + sqrt scaling) | < 0.13% relative |
| h0 → h1 | `GemmaBlock` layer 0 (attn+RoPE+MLP+norms) | < 0.5% relative |
| h1 → h48 | `GemmaEncoder` (48 streaming blocks) | < 5% relative over full depth |
| RoPE isolation | `GemmaAttention` dual sliding/global configs | < 1e-4 |

Four parity tests, all passing: `GemmaTokenizerParityTests`,
`GemmaRoPEParityTests`, `GemmaLayer0ParityTests`, `GemmaFullEncoderParityTests`.
68/68 package tests green.

## The tokenizer resolution (the last piece)

Gemma uses SentencePiece-BPE, not Tiktoken. z-image-director's `BPETokenizer`
(Tiktoken-style: GPT-2 bytes_to_unicode + regex pretokenizer) produced wrong
token_ids. `GemmaTokenizer` is a standalone implementation parsing the HF
`tokenizer.json` directly, implementing the verified-correct algorithm:
1. split text on special tokens (`<start_of_turn>` etc.), preserving them
2. normalize: `" "` → `"▁"` (SentencePiece metaspace)
3. BPE: initial tokens = chars (byte_fallback → `<0xNN>` for unknown chars),
   greedily merge lowest-rank adjacent pair
4. prepend `<bos>` (Gemma `add_bos_token=True`, no eos)

## Two earlier bugs (documented for future porters)

1. **Wrong tolerance metric**: Gemma's residual stream is un-normalized between
   layers, so |h| grows to absmax ~10000 by layer 48. The original "diff 32"
   failure was 0.32% relative — use RELATIVE error (diff/absmax) for deep
   residual stacks, not absolute.
2. **fp32-vs-bf16 compute**: mlx-lm dequantizes 4-bit weights to **bfloat16**;
   an fp32 port diverges to 26% over the chaotic 48-layer residual stack.
   Match bf16 compute (also cast the attention mask to bf16 for sdpa promotion).

## Next: wire into the pipeline — text-encode half DONE (2026-07-03)

The encode produces concatenated all-layer hidden states (B, T, 188160) →
`TextEmbeddingProjection` (native) → `Embeddings1DConnector` (native) → DiT
conditioning embeds. `NativeTextEncodeStage.swift` now wires `GemmaTokenizer`
+ `GemmaEncoder` + `TextEmbeddingProjection` + `Embeddings1DConnector` into
one native encode call (`ConnectorCheckpointLoader.swift` loads the real
connector checkpoint — int4/group_size=32, 8 blocks per side, see PLAN.md's
"NativeTextEncodeStage" milestone). Verified end-to-end via
`NativeTextEncodeStageRealCheckpointTests` (real checkpoints, finite +
correctly-shaped output). 69/69 package tests pass.

Still open: `I2VCommand` still uses `RunPyBridge` for actual generation —
wiring `videoEmbeds`/`audioEmbeds` into `LTXModel`/`DenoiseLoop` and adding
memory-bounded VAE tiling for real-resolution output remain before
`RunPyBridge` can be retired there.

## NativeI2VStage landed (2026-07-03) — can it run without run.py/Python yet?

**Yes, for a real (if quality-limited) generation — via the new,
separate, explicitly experimental `ltx-video native-i2v` command. `i2v`
(the production command) still uses `RunPyBridge`/`run.py`.**

`NativeI2VStage` composes every native piece (T2I, VAE-encode
conditioning, Gemma text encoder, `DenoiseLoop.runStreaming` against the
real 48-block distilled transformer, VAE/vocoder decode) into one call —
zero run.py, zero Python. Ran it for real at production resolution
(640×960, 9 frames, 45.0s wall time): frame 0 (the I2V conditioning
frame) came out pixel-perfect; frames 1+ show a real color-distortion
artifact traced to `DenoiseLoop.runStreaming` not yet supporting
per-token timesteps (see PLAN.md's "NativeI2VStage" milestone for the
full diagnosis and the concrete next fix). 77/77 package tests pass,
including a real-checkpoint end-to-end smoke test
(`NativeI2VStageRealCheckpointTests`).

Remaining before `native-i2v` output is quality-comparable to `run.py`,
and before `I2VCommand` itself could ever consider dropping
`RunPyBridge`: VAE tiling for larger/longer clips, VLM prompt expansion
wiring, and an actual mp4 muxer (still PNG sequence + WAV).

## Color-distortion artifact — FIXED (2026-07-03)

**Status: RESOLVED.** The frame 1+ color-distortion bug reported above is
fixed. Root cause was exactly as diagnosed: `LTXModel.streamingForward`
only accepted a scalar batch timestep, so during I2V-conditioned
streaming denoise every token — including the preserved conditioning
frame — was AdaLN-modulated with the same sigma. Other tokens'
cross-attention therefore perceived the "clean" frame as still-noisy at
every step; `applyDenoiseMask` only patched the OUTPUT afterward, not
what other tokens saw internally.

Fix: gave `LTXModel.streamingForward` the same `videoTimesteps`/
`audioTimesteps` (B, N) per-token-timestep parameters `callAsFunction`
already had (preserved tokens' own AdaLN branch), and updated
`DenoiseLoop.runStreaming` to compute them via the same
`isUniformMask`/`perTokenTimesteps` helpers the non-streaming
conditioned `run` already used. Now the streaming and non-streaming
conditioned paths are at parity.

Verified: re-ran `ltx-video native-i2v` at production resolution
(640×960, 9 frames) — visually inspected `source.png` and all 9 output
frames; no color distortion in any frame, output matches source
composition/colors correctly throughout. 77/77 package tests still
pass after the change.

## Auto resolution resolve — DONE (2026-07-03)

**Status: RESOLVED.** Bad user-supplied resolutions (not a multiple of
32) used to hard-fail `native-i2v`. `NativeI2VStage.generate` now calls
new `ResolutionResolver.optimize(width:height:)` unconditionally, which
snaps to the nearest 32-multiple (LTX-2.3's video VAE spatial
compression factor) and logs the adjustment — mirroring what
`run.py video generate`'s `_adjust_resolution` already does for the
Python path. Only non-positive dimensions still throw. 6 new
`ResolutionResolverTests` + 2 new `NativeI2VStageRealCheckpointTests`
cases (misaligned-resolution real run, zero-dimension rejection). Suite
now **85/85**.

## Native spatial upscaler — LANDED, a different (smaller) mechanism than first researched (2026-07-03)

**Does LTX-2.3 support a native spatial upscaler?** Yes — two different
mechanisms, actually:
1. `Lightricks/LTX-2.3-22b-IC-LoRA-Pixel-Spatial-Upscaler`, an official
   IC-LoRA (2×/4×, generative, also removes watermarks/subtitles/blur)
   fused onto the full 22B transformer. This package exposes it via
   `ltx-video upscale` → `UpscaleEngine` → `RunPyBridge` → `run.py video
   restore` → vendor `ICLoraPipeline` — real, correct output, but still
   bridges through Python. Porting this natively remains a large,
   unstarted undertaking (LoRA fusion + whole-clip reference
   conditioning — see PLAN.md's "Research: native spatial upscaling"
   milestone for the 5-step plan).
2. **`LatentUpsampler`** — the small, dedicated neural upscaler LTX's
   own two-stage pipeline uses between its half-res generation and
   refinement passes. Much smaller (Conv3d/Conv2d ResNet operating
   directly on the 128-channel VAE latent — comparable to
   `VideoDecoder`, not to the full transformer). Checkpoint already
   present at `mlx-models/vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors`.

**Is #2 natively ported to Swift (no run.py)? Yes, done and verified.**
New `Sources/LTXVideoDirector/Upsampler/LatentUpsampler.swift` (spatial_x2
variant), parity-tested against the real checkpoint's actual Python
output (max abs diff < 1e-3), assembled into `NativeUpscaleStage.swift`
(`VideoEncoder → LatentUpsampler → VideoDecoder`) and exposed as
`ltx-video native-upscale`. Manual real-checkpoint run + visual
inspection caught and fixed a real bug along the way: `LatentUpsampler`
needs its input DENORMALIZED (raw VAE scale) — feeding it
`VideoEncoder`'s normalized output directly produced severe
color-fringing artifacts, invisible to the numerical parity test (which
used tiny random values) but obvious on a real photo. Fixed by
denormalizing before / renormalizing after, matching the vendor
pipeline's actual Stage-1→2 handoff exactly. Verified clean: a
320×320→640×640 real upscale run shows genuinely more detail, no
artifacts, ~1.8s wall time. See PLAN.md's "NativeUpscaleStage" milestone
for the full story. Suite: **87/87 pass.**

`native-upscale` is upscale-only — no refinement denoise pass after the
neural upscale (the real two-stage pipeline follows it with one; not
implemented here yet, see PLAN.md). #1 (IC-LoRA restoration/dewatermark)
remains the only native-port gap.

## Sub-production-resolution corruption — FOUND AND FIXED (2026-07-03)

**Status: RESOLVED.** A manual `native-i2v` demo at 384x576 (same 2:3
aspect as the validated 640x960 default, just smaller — both multiples of
32) produced a clean frame 0 but progressively worse color/texture
corruption over the following frames. An identical run (same
seed/prompt/fps, 17 frames) at 640x960 stayed completely clean throughout,
isolating the cause to resolution, not frame count or fps. Root cause: the
distilled transformer's streaming denoise destabilizes over multi-frame
sequences when run well below its validated training resolution.

Fix: `ResolutionResolver.optimize` now enforces a minimum pixel area —
`modelOptimalDefault`'s own area (640x960 = 614,400px) — scaling any
smaller request up (preserving aspect ratio) before snapping to the
nearest 32-multiple, instead of just snapping the too-small request in
place. Verified: rerunning the exact 384x576 request now logs
`auto-adjusted 384x576 -> 640x960` and produces output identical in
quality to the direct 640x960 run (clean throughout, correct zh-TW
subtitle rendering, no corruption). 2 new `ResolutionResolverTests` cases
added (area-floor scale-up, real-world regression case). Suite: **89/89
pass.**

## Temporal VAE decode tiling — DONE (2026-07-03)

**Status: LANDED.** Long clips no longer die during decode: a 41-frame
(5s @ 8fps) 640x960 `native-i2v` run — the case that previously crashed
silently — now completes end-to-end (79.5s wall, exit 0, 41 clean frames
+ audio). New `Sources/LTXVideoDirector/VAE/VideoTiling.swift` ports the
vendor reference's temporal decode tiling (ltx-2-mlx
`video_vae/tiling.py` + `_compute_decode_tiling`/`tiled_decode`),
temporal axis only — same scope the vendor auto-path uses. Preserved
reference subtleties: causal 1-latent-frame back-shift on non-first
tiles, latent→frame mapping `[begin*8, 1+(end-1)*8)`, and
`left_starts_from_0` trapezoid masks. `VideoDecoder` gained
`materializeStages:` (force-eval after each upsample stage, tiled path
only). `NativeI2VStage` auto-selects tiling via the same
`LTX2_VAE_DECODE_BUDGET_GB` env knob run.py uses (default 8 GB; budget
model uses 4 bytes/element since the Swift decoder runs fp32).

Verified: (1) forced-tiling real run (`LTX2_VAE_DECODE_BUDGET_GB=0.4`,
tile_frames=40 overlap=8) visually indistinguishable from the untiled
run — frames at the blend seam (24/28) and ends inspected, no seams or
color shift; (2) tiled-vs-untiled real-checkpoint parity test (bounded
max/mean deviation — NOT bit-exact by design: the decoder is non-causal,
so tile boundaries truncate the temporal receptive field; the vendor has
the same property); (3) 10 pure-arithmetic layout/mask/budget tests
mirroring vendor test_decode_tiling.py. Suite: **100/100 pass.**

Note: encode-side tiling and spatial decode tiling are NOT ported (the
vendor auto-path never selects spatial tiling either; encode here only
ever sees a single conditioning frame).

# Default auto-upscale + multi-LoRA fusion — DONE (2026-07-03)

Driven by an explicit `/goal`. Four asks, four outcomes:

1. **"Runs full pure Swift"** — confirmed still true: `native-i2v` has
   zero `run.py`/`RunPyBridge` calls anywhere in its call chain (only
   `i2v` still bridges). Re-verified with a real end-to-end run.
2. **Resolution auto-align** — already landed in an earlier session
   (`ResolutionResolver.optimize`, snaps to the nearest 32-multiple,
   scales up below the validated area). No new work needed; re-verified.
3. **Default auto-upscale** — `NativeUpscaleStage` (native `LatentUpsampler`,
   2x spatial) existed but was never chained after `native-i2v`.
   `NativeI2VCommand` now runs it automatically after decode
   (`--upscale`/`--no-upscale`, on by default). **Quality caveat found
   and documented, not glossed over**: the upscale is visibly
   over-sharpened/halo-prone vs. the base frame (no refine denoise pass
   — see `NativeUpscaleStage`'s own header). Real run: 74.5s base + 10.5s
   upscale, 640×960 → 1280×1920.
4. **Multi-LoRA support** — inventory: only ONE real LTX LoRA exists in
   `mlx-models/lora/` (`ltx-2.3-22b-distilled-lora-384(-1.1).int8.safetensors`
   — the structural dev→distilled LoRA, not a style pack; every other
   entry under `mlx-models/lora/` is a z-image/Klein9B image LoRA).
   Ported `ltx_core_mlx.loader.fuse_loras`'s delta math + the
   `LTXV_LORA_COMFY_RENAMING_MAP` key remap + `app/vendor_patches.py`'s
   int8-LoRA dequant patch (all three confirmed by reading the actual
   vendor/app source, not assumed) into `LoRAWeights.swift`/
   `LoRAFusion.swift`. Wired into `TransformerCheckpointLoader`/
   `NativeI2VStage.Request.loraPaths` + a repeatable `--lora
   path[:strength]` CLI flag. Verified against the real vendor
   `apply_loras` + the real distilled LoRA file, both single-LoRA and
   multi-LoRA (same file stacked twice at different strengths) — max-abs-diff
   < 1e-3, plus a guard against a same-strength-for-every-source bug.

Full suite green after all four changes (build + targeted LoRA test run
confirmed 100% pass; see PLAN.md's matching milestone for exact test
names and counts).

# First-Last-Frame (FFLF) conditioning — DONE (2026-07-03)

Follow-up to the ComfyUI reference-workflow research above. Confirmed the
research doc's prediction: `VideoConditionByLatentIndex` already generalized
to multiple frame indices — only `NativeI2VStage` needed a second
conditioning image wired in, not a new conditioning mechanism.

`NativeI2VStage.Request.lastFrameImagePath` (+ `NativeI2VCommand`'s
`--last-frame <path>`): when set, VAE-encodes the given image the same way
the existing T2I-generated frame-0 source is encoded, and conditions on
`[0, fLat - 1]` instead of `[0]`. Frame 0's existing behavior (always
T2I-generated from `--prompt`) is unchanged. Validates the image's
existence + exact size BEFORE any expensive generation work, matching this
package's fail-fast convention.

Verified real-checkpoint: a synthetic flat-color PNG pinned as the last
frame comes back out of the DECODED output within mean abs diff < 0.04 in
[0,1] pixel space (same order as the VAE round-trip loss already
documented for frame-0 conditioning) — proves the last frame is genuinely
the pinned image, not model-generated content. Passed on the first run.

# V2V restyle — `native-restyle` (2026-07-04)

Follow-up to "Research: scoping the general IC-LoRA video-conditioning
primitive" — picked the top item of its "easy tier" (V2V, near-zero new
preprocessing beyond what `generateHD` already does). New
`NativeUpscaleStage.generateRestyle` + `ltx-video native-restyle` CLI
command: `generateHD`'s reference-conditioning core with the
restoration-specific two-LoRA/two-stage structure stripped to a single,
always user-supplied style IC-LoRA, one stage, output at input resolution.

New `.restyleLoraNotFound` `StageError` case (no bundled default LoRA
exists for this path, unlike `generateHD`'s restoration pair) +
`testGenerateRestyleMissingLoraThrowsNamedError`, checked in
`NativeUpscaleStageRealCheckpointTests` (7/7 pass). UNVERIFIED end-to-end
against a real style checkpoint — none found under that description on
HuggingFace/CivitAI as of this session; likely needs a community-trained
adapter rather than an official Lightricks release. Full writeup:
PLAN.md's matching milestone.

# Ingredients IC-LoRA — `native-ingredients` (2026-07-04)

Follow-up to the milestone above — the sibling "easy tier" item. New
`NativeUpscaleStage.generateIngredients` + `ltx-video native-ingredients`
CLI command: same reference-conditioning core as `generateRestyle`, but the
"reference" is a single still image tiled across the full generation frame
count (confirmed via the reference ComfyUI graph's actual node links, not
just names — `RepeatImageBatch`'s tile count is driven by the same
`PrimitiveInt` as the generation's own frame count) instead of a real input
video clip. Audio is generated from scratch (reusing `NativeI2VStage`'s
default t2v audio-decode path) rather than preserved from an input track.

New `.ingredientsLoraNotFound` / `.referenceImageNotFound` `StageError`
cases + two contract tests, checked in
`NativeUpscaleStageRealCheckpointTests` (9/9 pass). Checkpoint search this
time found an EXACT match by name on HuggingFace
(`Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients`,
`ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors`) — but the repo is
gate-flagged and returns HTTP 403 even with a valid `HF_TOKEN`, since this
account hadn't accepted the license on huggingface.co (a one-time human
click, not something the CIVITAI_TOKEN-only download path supports or is
worth automating around).

**Update (2026-07-05)**: user accepted the HF license gate same-day.
Downloaded the checkpoint via authenticated `curl` + imported locally via
`import-lora`. Real end-to-end run against a fresh `t2i`-generated reference
photo: PASS — frame 0 reproduces the reference image's content almost
exactly (the key IC-LoRA reference-conditioning signal), stable/coherent
across all 33 frames, audio + mp4 mux clean. No longer UNVERIFIED. Full
writeup: PLAN.md's matching milestone.
