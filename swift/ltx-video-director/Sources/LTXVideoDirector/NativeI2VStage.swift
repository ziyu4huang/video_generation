//
//  NativeI2VStage.swift
//  LTXVideoDirector
//
//  First end-to-end assembly of the native (no run.py, no Python) I2V
//  path: NativeT2IStage -> VideoEncoder (source frame as I2V conditioning
//  latent) -> NativeTextEncodeStage -> DenoiseLoop.runStreaming (real
//  48-block LTX-2.3 transformer, variant-selectable — see
//  `transformerVariant` below) -> VideoDecoder + AudioVAEDecoder +
//  VocoderWithBWE -> PNG frame sequence + WAV. Every piece here already had
//  its own parity or real-checkpoint test before this file existed (see
//  PLAN.md's milestones); this only composes them.
//
//  Scope, deliberately narrow for this first assembly:
//    - `transformerVariant` (default `.distilled`) selects the checkpoint via
//      LTXModelRegistry, matching the same mlx-models/ltx-mlx/{variant}/ tree
//      `i2v`/RunPyBridge already reads. dev/dasiwa share distilled's exact
//      embedded_config.json (confirmed byte-identical), so `distilledConfig`
//      applies to all three. What does NOT vary yet: sigma schedule is a
//      manifest-derived step count only (no classifier-free guidance) —
//      dev's manifest-recommended cfg_scale=5.0/stg_scale=1.0 need a real
//      CFG/STG implementation this package doesn't have (see
//      docs/native-i2v-dev-variant-study.md). Selecting dev/dasiwa here is
//      real checkpoint-loading wiring, not yet a quality-equivalent dev path.
//    - no VLM prompt expansion (NativeVLMPromptStage) wired in yet — the
//      `prompt` is used verbatim for both the T2I and video stages.
//    - video decode is temporally tiled when needed (VideoDecodeTiling,
//      auto-budgeted via LTX2_VAE_DECODE_BUDGET_GB) — long clips no
//      longer exhaust memory in the decode graph. VideoEncoder still
//      encodes a single conditioning frame, which never needs tiling.
//    - Output is a PNG frame sequence + a separate WAV file (same
//      convention VideoDecodeCommand/AudioDecodeCommand already use).
//      `native-i2v`'s CLI command optionally muxes these into a real
//      `.mp4` via MP4Writer.swift (AVAssetWriter) — on by default,
//      `--no-mp4` to skip.
//    - `DenoiseLoop.runStreaming` rebuilds all 48 blocks from the raw
//      checkpoint on every sigma step (no persistent block cache), so
//      wall-clock is expected to be meaningfully slower than run.py's
//      load-once approach — unmeasured at real resolution/step-count as
//      of this file's introduction.
//

import Foundation
import MLX

public struct NativeI2VStage {
    public enum StageError: Error, CustomStringConvertible {
        case transformerCheckpointNotFound(URL)
        case videoEncoderCheckpointNotFound(URL)
        case invalidDimensions(String)
        case loraNotFound(URL)
        case lastFrameImageNotFound(URL)
        case lastFrameImageWrongSize(expected: (width: Int, height: Int), actual: (width: Int, height: Int))
        case audioTrackNotFound(URL)
        case audioEncoderCheckpointNotFound(URL)
        case inputImageNotFound(URL)
        case inputImageWrongSize(expected: (width: Int, height: Int), actual: (width: Int, height: Int))
        case gridImageNotFound(URL)
        case gridConfigMismatch(String)
        case anchorImageNotFound(URL)
        case anchorImageWrongSize(path: URL, expected: (width: Int, height: Int), actual: (width: Int, height: Int))
        case anchorConfigMismatch(String)

        public var description: String {
            switch self {
            case .transformerCheckpointNotFound(let url): return "LTX-2.3 transformer checkpoint not found at \(url.path)"
            case .videoEncoderCheckpointNotFound(let url): return "LTX-2.3 video VAE encoder checkpoint not found at \(url.path)"
            case .invalidDimensions(let msg): return "NativeI2VStage: \(msg)"
            case .loraNotFound(let url): return "LoRA safetensors not found at \(url.path)"
            case .lastFrameImageNotFound(let url): return "--last-frame image not found at \(url.path)"
            case .lastFrameImageWrongSize(let expected, let actual):
                return "--last-frame image is \(actual.width)x\(actual.height), expected \(expected.width)x\(expected.height) "
                    + "(same resolution as the generated clip — resize it first, e.g. with sips)"
            case .audioTrackNotFound(let url): return "--audio-track file not found at \(url.path)"
            case .audioEncoderCheckpointNotFound(let url): return "LTX-2.3 audio VAE checkpoint not found at \(url.path)"
            case .inputImageNotFound(let url): return "--input-image not found at \(url.path)"
            case .inputImageWrongSize(let expected, let actual):
                return "--input-image is \(actual.width)x\(actual.height), expected \(expected.width)x\(expected.height) "
                    + "(same resolution as the requested clip — resize it first, e.g. with sips)"
            case .gridImageNotFound(let url): return "--grid-image not found at \(url.path)"
            case .gridConfigMismatch(let msg): return "NativeI2VStage grid guide: \(msg)"
            case .anchorImageNotFound(let url): return "--anchor-image not found at \(url.path)"
            case .anchorImageWrongSize(let path, let expected, let actual):
                return "--anchor-image \(path.lastPathComponent) is \(actual.width)x\(actual.height), expected \(expected.width)x\(expected.height) "
                    + "(same resolution as the requested clip — resize it first, e.g. with sips)"
            case .anchorConfigMismatch(let msg): return "NativeI2VStage multi-anchor: \(msg)"
            }
        }
    }

    public struct Request {
        public var prompt: String
        public var seconds: Double
        public var fps: Double
        /// Auto-snapped to the nearest multiple of 32 (VAE spatial
        /// compression factor — see ResolutionResolver / Positions /
        /// Patchifiers' VideoLatentShape) at the start of `generate` if not
        /// already aligned; arbitrary user input is never rejected outright.
        public var width: Int
        public var height: Int
        public var seed: UInt64
        public var t2iTransformer: String
        public var textMaxLength: Int
        /// LTX-2.3 video transformer variant, selected via LTXModelRegistry's
        /// mlx-models/ltx-mlx/{variant}/ tree. Default `.distilled` preserves
        /// this stage's original (and only real-checkpoint-tested) behavior.
        /// `.dev`/`.dasiwa` load their own checkpoint and use the manifest's
        /// 30-step dynamic-shift schedule (SigmaSchedule.ltx2Schedule)
        /// instead of the 8-step distilled table, but there is NO
        /// classifier-free guidance in this native pipeline yet (see this
        /// file's header) — dev's manifest-recommended cfg_scale=5.0 has no
        /// effect. Selecting `.dev`/`.dasiwa` is real checkpoint-loading
        /// wiring, not yet a quality-equivalent dev sampling path.
        public var transformerVariant: LTXTransformerVariant = .distilled
        /// Classifier-free guidance scale for the video stream (Milestone 2a
        /// of the CFG/STG port, see docs/native-i2v-dev-variant-study.md).
        /// `nil` (default) means "use the variant's own default": `1.0`
        /// (off) for `.distilled` — unchanged behavior — or `5.0` for
        /// `.dev`/`.dasiwa`, matching their manifest's `recommended_params
        /// .cfg_scale` and `python/mlx-movie-director/app/ltx_pipeline.py`'s
        /// own `generate(cfg_scale: float = 5.0)` default. Set explicitly to
        /// override (e.g. `1.0` to force CFG off even for `.dev`/`.dasiwa`).
        public var cfgScale: Double?
        /// Variance-preserving rescale strength applied after the CFG/STG
        /// blend (reference: `guiders.py`'s `rescale_scale`, production
        /// constant `_GUIDER_RESCALE_SCALE = 0.7`). `0` disables rescaling.
        /// Ignored when both CFG and STG are inactive.
        public var rescaleScale: Float = 0.7
        /// Spatio-temporal guidance scale for the video stream (Milestone 2b
        /// of the CFG/STG port, see docs/native-i2v-dev-variant-study.md).
        /// `nil` (default) means "use the variant's own default": `0.0`
        /// (off) for `.distilled` — unchanged behavior — or `1.0` for
        /// `.dev`/`.dasiwa`, matching their manifest's `recommended_params
        /// .stg_scale` and `python/mlx-movie-director/app/ltx_pipeline.py`'s
        /// own default. Set explicitly to override (e.g. `0.0` to force STG
        /// off even for `.dev`/`.dasiwa`).
        public var stgScale: Double?
        /// Transformer block indices whose video self-attention is
        /// perturbed when STG is active. Default `[28]` matches
        /// production's `_GUIDER_STG_BLOCKS` constant.
        public var stgBlocks: [Int] = [28]
        /// Modality guidance scale for the video stream (Milestone 2c of the
        /// CFG/STG/modality port, see docs/native-i2v-dev-variant-study.md).
        /// `nil` (default) means "use the variant's own default": `1.0`
        /// (off) for `.distilled` — unchanged behavior — or `3.0` for
        /// `.dev`/`.dasiwa`, matching their manifest's `recommended_params
        /// .modality_scale` (production's `LTX_2_3_PARAMS`). Set explicitly
        /// to override (e.g. `1.0` to force modality guidance off even for
        /// `.dev`/`.dasiwa`).
        public var modalityScale: Double?
        /// Additional LoRA(s) to fuse into the distilled transformer at
        /// block-dequantize time, on top of the checkpoint's own baked-in
        /// distilled behavior (see LoRAFusion.swift / LoRAWeights.swift).
        /// Multiple entries are summed (matches the vendor's
        /// `apply_loras`/`_prepare_deltas`) — supports stacking more than
        /// one LoRA at independent strengths.
        public var loraPaths: [(path: URL, strength: Float)]
        /// First-Last-Frame (FFLF) conditioning: an optional user-supplied
        /// image pinned as the CLIP's LAST frame (frame 0 is always the
        /// T2I-generated `prompt` image, unchanged). Must already be exactly
        /// `width`x`height` — the pipeline doesn't resize it (see
        /// StageError.lastFrameImageWrongSize). Ported from the reference
        /// ComfyUI FFLF workflows' `MultiImageLoader` conditioning — see
        /// docs/reference/comfyui_workflows/README.md. When nil, behaves
        /// exactly as before (frame-0-only I2V conditioning).
        public var lastFrameImagePath: URL?
        /// Conditioning strength for the last-frame image, ported from the
        /// reference ComfyUI workflows' per-slot `MultiImageLoader` strength
        /// (docs/reference/comfyui_workflows/README.md third-pass finding
        /// 3). 1.0 = fully preserved/pinned (the previous, only supported
        /// behavior); lower values partially blend it with generated
        /// content (denoiseMask = 1 - strength, see
        /// VideoConditionByLatentIndex). Ignored when lastFrameImagePath is
        /// nil. Frame 0 has no equivalent knob — unlike the reference, it's
        /// always the T2I-generated `prompt` image, never a second
        /// user-supplied slot, so "strength" isn't a meaningful concept there.
        public var lastFrameStrength: Float = 1.0
        /// When true, a `lastFrameImagePath` that isn't already exactly
        /// `width`x`height` is resized (aspect-fill + center-crop, bicubic)
        /// instead of throwing `lastFrameImageWrongSize` — matches the
        /// reference `MultiImageLoader`'s auto-resize behavior (same
        /// third-pass finding). Default false preserves this package's
        /// established "fail fast on mismatched input, don't silently
        /// degrade" convention; auto-resize is opt-in.
        public var lastFrameAutoResize: Bool = false
        /// Custom audio injection: an optional user-supplied WAV whose
        /// content is preserved through generation instead of the audio
        /// modality being generated from scratch — mirrors the reference
        /// ComfyUI workflows' "Custom Audio" subgraph (LTXVAudioVAEEncode +
        /// SetLatentNoiseMask, see docs/reference/comfyui_workflows/README.md
        /// finding 5). Resampled to 16kHz (AudioProcessor's expected rate)
        /// via LinearResampler, encoded with AudioVAEEncoder, then pinned
        /// as preserved (denoiseMask=0) tokens covering the overlap between
        /// the track's duration and the generated clip's audio-token count
        /// — reuses VideoConditionByLatentIndex with spatialDims=(N,1,1)
        /// since audio tokens have no spatial extent to group by frame.
        /// When nil, audio is generated fresh (unchanged behavior).
        public var audioTrackPath: URL?
        /// Frame 0's conditioning source. When nil (default, unchanged
        /// behavior), frame 0 is generated by `NativeT2IStage` from `prompt`.
        /// When set, that generation is skipped entirely and this image is
        /// VAE-encoded as the frame-0 conditioning latent instead — the
        /// general "I2V from an arbitrary supplied image" case, needed by
        /// any multi-segment chaining caller (e.g. a prompt-relay pipeline
        /// using segment N's last decoded frame as segment N+1's frame 0)
        /// where the source frame is a real image, not something to
        /// generate. Must already be exactly `width`x`height` (same
        /// fail-fast, no-auto-resize convention `lastFrameImagePath` used
        /// before FFLF added its own auto-resize opt-in).
        public var inputImagePath: URL?

        /// Grid-guide conditioning: an optional single image containing an
        /// NxN grid of storyboard panels (e.g. a 2x2 four-panel image), each
        /// panel split in-memory and pinned as its own keyframe guide at an
        /// independent latent frame index + strength — one generation call
        /// conditioned on N keyframes instead of only frame-0/last-frame.
        /// Ported conceptually from the reference ComfyUI custom node
        /// `TD_LTXVAddGuideFromGrid` (`ComfyUI-TDNodes`, MIT), which splits a
        /// grid image and calls the equivalent of this repo's own
        /// `VideoConditionByLatentIndex` once per panel — same generic
        /// mechanism this package's FFLF feature already exercises twice per
        /// call (frame 0 + last frame), generalized here to an arbitrary
        /// panel count. Applied AFTER frame-0 and FFLF conditioning, so a
        /// grid panel's frame index colliding with 0 or the last frame wins
        /// (later `VideoConditionByLatentIndex.apply` calls overwrite the
        /// same token positions). When nil (default), behaves exactly as
        /// before (no grid conditioning).
        public var gridImagePath: URL?
        /// Grid layout: `gridColumns * gridRows` must equal
        /// `gridFrameIndices.count` (and `gridStrengths.count` when
        /// non-empty). Ignored when `gridImagePath` is nil.
        public var gridColumns: Int = 2
        public var gridRows: Int = 2
        /// Latent frame index each grid panel (row-major: top-left,
        /// top-right, ..., bottom-right) is pinned at. Must have exactly
        /// `gridColumns * gridRows` entries, each `< fLat` (the generation's
        /// total latent frame count, only known once `frames`/resolution are
        /// resolved — validated inside `generate`, not at construction
        /// time). Empty (default) disables grid conditioning even if
        /// `gridImagePath` is set.
        public var gridFrameIndices: [Int] = []
        /// Per-panel conditioning strength, same semantics as
        /// `lastFrameStrength` (1.0 = fully pinned, lower values partially
        /// blend with generated content). Empty means "all panels at
        /// strength 1.0"; otherwise must match `gridFrameIndices.count`.
        public var gridStrengths: [Float] = []

        /// Multi-anchor I2V: additional standalone images pinned at
        /// independent latent frame indices, each at its own strength —
        /// the temporal-keyframing generalization of `lastFrameImagePath`
        /// (which only covers frame 0 + the last frame). Mirrors
        /// `run.py video generate --image PATH FRAME_IDX STRENGTH`
        /// (repeatable, Python-side, `python/mlx-movie-director/docs/openmontage-capability-matrix.md`
        /// "reference_to_video" row) but reuses this package's own
        /// `VideoConditionByLatentIndex` primitive already exercised by
        /// grid-guide/FFLF rather than porting new engine code — a CLI +
        /// conditioning-wiring task, not new engine work. Each entry's
        /// image must already be exactly `width`x`height` (same fail-fast
        /// convention `inputImagePath` uses — no auto-resize). Applied
        /// after frame-0/FFLF, before grid-guide, so a grid panel's frame
        /// index wins on collision (same last-writer-wins semantics FFLF
        /// documents). Empty (default) disables multi-anchor conditioning.
        public var anchorImages: [(path: URL, frameIndex: Int, strength: Float)] = []

        public init(
            prompt: String, seconds: Double = 0.5, fps: Double = 24.0,
            width: Int = 640, height: Int = 960, seed: UInt64 = 42,
            t2iTransformer: String = "moody-pro-mix", textMaxLength: Int = 128,
            loraPaths: [(path: URL, strength: Float)] = [],
            lastFrameImagePath: URL? = nil,
            audioTrackPath: URL? = nil,
            inputImagePath: URL? = nil
        ) {
            self.prompt = prompt
            self.seconds = seconds
            self.fps = fps
            self.width = width
            self.height = height
            self.seed = seed
            self.t2iTransformer = t2iTransformer
            self.textMaxLength = textMaxLength
            self.loraPaths = loraPaths
            self.lastFrameImagePath = lastFrameImagePath
            self.audioTrackPath = audioTrackPath
            self.inputImagePath = inputImagePath
        }

        /// LTX frame counts must be 8k+1 (mirrors I2VRequest.frames).
        public var frames: Int {
            let raw = seconds * fps
            let kFloor = max(1, Int(floor((raw - 1) / 8.0)))
            let kCeil = kFloor + 1
            let fFloor = 8 * kFloor + 1
            let fCeil = 8 * kCeil + 1
            return abs(Double(fFloor) - raw) <= abs(Double(fCeil) - raw) ? fFloor : fCeil
        }
    }

    public struct Result {
        public let sourceImageURL: URL
        public let frameDirectory: URL
        public let frameCount: Int
        public let audioURL: URL
    }

    public init() {}

    private func distilledConfig(numLayers: Int) -> LTXModelConfig {
        // Confirmed against mlx-models/ltx-mlx/distilled/embedded_config.json
        // (see LTXModelRealCheckpointTests.realConfig — same values).
        var cfg = LTXModelConfig()
        cfg.numLayers = numLayers
        cfg.videoDim = 4096; cfg.audioDim = 2048
        cfg.videoNumHeads = 32; cfg.audioNumHeads = 32
        cfg.videoHeadDim = 128; cfg.audioHeadDim = 64
        cfg.avCrossNumHeads = 32; cfg.avCrossHeadDim = 64
        cfg.videoPatchChannels = 128; cfg.audioPatchChannels = 128
        cfg.timestepEmbeddingDim = 256
        cfg.timestepScaleMultiplier = 1000.0
        cfg.avCaTimestepScaleMultiplier = 1000.0
        cfg.ropeTheta = 10000.0
        cfg.positionalEmbeddingMaxPos = [20, 2048, 2048]
        cfg.audioPositionalEmbeddingMaxPos = [20]
        return cfg
    }

    public func generate(_ requestIn: Request, outputDir: URL) throws -> Result {
        var request = requestIn
        guard request.width > 0, request.height > 0 else {
            throw StageError.invalidDimensions("width/height must be positive, got \(request.width)x\(request.height)")
        }
        let optimized = ResolutionResolver.optimize(width: request.width, height: request.height)
        if optimized.width != request.width || optimized.height != request.height {
            print("[resolution] auto-adjusted \(request.width)x\(request.height) -> \(optimized.width)x\(optimized.height) "
                + "(nearest multiple of \(ResolutionResolver.spatialScale) — LTX-2.3 VAE spatial compression)")
            request.width = optimized.width
            request.height = optimized.height
        }
        // Fail fast on a bad --last-frame BEFORE any expensive generation
        // work (T2I/text-encode/denoise) — cheap dimension check only, the
        // actual VAE-encode happens later in step 4 once fLat is known.
        if let lastFrameImagePath = request.lastFrameImagePath {
            guard let cgImage = FrameLoad.loadCGImage(from: lastFrameImagePath) else {
                throw StageError.lastFrameImageNotFound(lastFrameImagePath)
            }
            if !request.lastFrameAutoResize {
                guard cgImage.width == request.width, cgImage.height == request.height else {
                    throw StageError.lastFrameImageWrongSize(
                        expected: (request.width, request.height), actual: (cgImage.width, cgImage.height))
                }
            }
        }
        if let audioTrackPath = request.audioTrackPath {
            guard FileManager.default.fileExists(atPath: audioTrackPath.path) else {
                throw StageError.audioTrackNotFound(audioTrackPath)
            }
        }
        if let inputImagePath = request.inputImagePath {
            guard let cgImage = FrameLoad.loadCGImage(from: inputImagePath) else {
                throw StageError.inputImageNotFound(inputImagePath)
            }
            guard cgImage.width == request.width, cgImage.height == request.height else {
                throw StageError.inputImageWrongSize(
                    expected: (request.width, request.height), actual: (cgImage.width, cgImage.height))
            }
        }
        if let gridImagePath = request.gridImagePath, !request.gridFrameIndices.isEmpty {
            guard FileManager.default.fileExists(atPath: gridImagePath.path) else {
                throw StageError.gridImageNotFound(gridImagePath)
            }
            let panelCount = request.gridColumns * request.gridRows
            guard request.gridFrameIndices.count == panelCount else {
                throw StageError.gridConfigMismatch(
                    "gridFrameIndices has \(request.gridFrameIndices.count) entries, expected \(panelCount) (gridColumns=\(request.gridColumns) * gridRows=\(request.gridRows))")
            }
            guard request.gridStrengths.isEmpty || request.gridStrengths.count == panelCount else {
                throw StageError.gridConfigMismatch(
                    "gridStrengths has \(request.gridStrengths.count) entries, expected \(panelCount) or 0 (0 = all panels default to strength 1.0)")
            }
        }
        for anchor in request.anchorImages {
            guard let cgImage = FrameLoad.loadCGImage(from: anchor.path) else {
                throw StageError.anchorImageNotFound(anchor.path)
            }
            guard cgImage.width == request.width, cgImage.height == request.height else {
                throw StageError.anchorImageWrongSize(
                    path: anchor.path, expected: (request.width, request.height), actual: (cgImage.width, cgImage.height))
            }
            guard anchor.frameIndex >= 0 else {
                throw StageError.anchorConfigMismatch("--anchor-image \(anchor.path.lastPathComponent) frameIndex=\(anchor.frameIndex) must be >= 0")
            }
        }

        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        // Per-stage wall-clock instrumentation (load-independent stage
        // *proportions* matter more than absolute times, since this
        // machine's ambient background load has been observed to shift
        // absolute wall-time by ~2x between benchmarking rounds — see
        // DenoiseLoop.runStreaming's doc comment). No existing convention
        // for this in the codebase (checked: no Date()/ContinuousClock/
        // signpost around any stage previously) — printed as
        // `[n/5] ... (Xs)` immediately after each stage completes.
        let stageClock = ContinuousClock()
        var stageStart = stageClock.now

        // 1. Frame 0 source: either a user-supplied image (skips T2I
        // entirely) or the default NativeT2IStage generation from `prompt`.
        let sourceImageURL = outputDir.appendingPathComponent("source.png")
        let imagePixels01: MLXArray
        if let inputImagePath = request.inputImagePath {
            print("[1/5] Using supplied --input-image (skipping T2I): \(inputImagePath.lastPathComponent)")
            let cgImage = FrameLoad.loadCGImage(from: inputImagePath)!  // re-validated above
            imagePixels01 = FrameLoad.toArray(cgImage)  // (1, 3, H, W) in [0, 1]
            if inputImagePath != sourceImageURL {
                try? FileManager.default.removeItem(at: sourceImageURL)
                try FileManager.default.copyItem(at: inputImagePath, to: sourceImageURL)
            }
        } else {
            print("[1/5] NativeT2IStage: generating source frame...")
            let t2i = NativeT2IStage(transformer: request.t2iTransformer, width: request.width, height: request.height, seed: request.seed)
            imagePixels01 = try t2i.generate(prompt: request.prompt, outputURL: sourceImageURL)  // (1, 3, H, W) in [0, 1]
        }
        print("[1/5] done (\(stageStart.duration(to: stageClock.now).formatted()))")
        stageStart = stageClock.now

        // 2. Text encode: native Gemma-3-12b -> connector (no run.py).
        print("[2/5] NativeTextEncodeStage: encoding prompt...")
        let textStage = NativeTextEncodeStage(maxLength: request.textMaxLength)
        let textResult = try textStage.encode(request.prompt)

        // Milestone 2a of the CFG/STG port: `.dev`/`.dasiwa` default to real
        // guidance (cfg_scale=5.0, matching their manifest + ltx_pipeline.py's
        // own default) unless the caller overrides. `.distilled` stays off
        // (cfg_scale=1.0) — unchanged behavior. See CFGGuidance.swift.
        let effectiveCfgScale = Float(request.cfgScale ?? (request.transformerVariant == .distilled ? 1.0 : 5.0))
        let cfgActive = CFGGuidance.isActive(cfgScale: effectiveCfgScale)
        var uncondTextResult: NativeTextEncodeStage.Result?
        if cfgActive {
            print("   [cfg] cfg_scale=\(effectiveCfgScale) active — encoding negative prompt for unconditional pass")
            uncondTextResult = try textStage.encode(CFGGuidance.defaultNegativePrompt)
        }
        // Milestone 2b: same default-by-variant pattern as cfgScale above.
        let effectiveStgScale = Float(request.stgScale ?? (request.transformerVariant == .distilled ? 0.0 : 1.0))
        let stgActive = CFGGuidance.isSTGActive(stgScale: effectiveStgScale) && !request.stgBlocks.isEmpty
        if stgActive {
            print("   [stg] stg_scale=\(effectiveStgScale) active — perturbing self-attention in blocks \(request.stgBlocks)")
        }
        // Milestone 2c: same default-by-variant pattern as cfgScale/stgScale above.
        let effectiveModalityScale = Float(request.modalityScale ?? (request.transformerVariant == .distilled ? 1.0 : 3.0))
        let modalityActive = CFGGuidance.isModalityActive(modalityScale: effectiveModalityScale)
        if modalityActive {
            print("   [modality] modality_scale=\(effectiveModalityScale) active — isolating cross-modal A2V/V2A attention")
        }
        print("[2/5] done (\(stageStart.duration(to: stageClock.now).formatted()))")
        stageStart = stageClock.now

        // 3. VAE-encode the source frame as the I2V conditioning latent.
        print("[3/5] VideoEncoder: encoding source frame as I2V conditioning...")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard FileManager.default.fileExists(atPath: vaeEncoderURL.path) else {
            throw StageError.videoEncoderCheckpointNotFound(vaeEncoderURL)
        }
        let encRaw = try MLX.loadArrays(url: vaeEncoderURL)
        var encWeights: [String: MLXArray] = [:]
        for (key, value) in encRaw {
            let stripped = key.hasPrefix("vae_encoder.") ? String(key.dropFirst("vae_encoder.".count)) : key
            encWeights[stripped] = value.asType(.float32)
        }
        let videoEncoder = VideoEncoder(weights: encWeights)
        let pixelsNeg1to1 = imagePixels01.asType(.float32) * 2.0 - 1.0
        let pixelsBCFHW = pixelsNeg1to1.reshaped([1, 3, 1, request.height, request.width])
        let conditionLatentBCFHW = videoEncoder(pixelsBCFHW)  // (1, 128, 1, H', W')
        MLX.eval(conditionLatentBCFHW)
        let (conditionTokens, _) = VideoLatentPatchifier.patchify(conditionLatentBCFHW)
        print("[3/5] done (\(stageStart.duration(to: stageClock.now).formatted()))")
        stageStart = stageClock.now

        // 4. Build noise + positions, splice in the conditioning frame, denoise.
        print("[4/5] DenoiseLoop.runStreaming: real 48-block distilled transformer...")
        let (fLat, hLat, wLat) = VideoLatentShape.compute(numFrames: request.frames, height: request.height, width: request.width)
        let numAudioTokens = Positions.computeAudioTokenCount(numVideoFrames: request.frames, frameRate: Float(request.fps))

        let key = MLXRandom.key(request.seed)
        let videoNoise = MLXRandom.normal([1, fLat * hLat * wLat, 128], key: key)
        let audioNoise = MLXRandom.normal([1, numAudioTokens, 128], key: MLXRandom.key(request.seed &+ 1))

        let videoPositions = Positions.computeVideoPositions(numFrames: fLat, height: hLat, width: wLat, frameRate: Float(request.fps))
        let audioPositions = Positions.computeAudioPositions(numTokens: numAudioTokens)

        // Frame 0: always the T2I-generated image, always fully preserved
        // (strength 1.0 — this slot has no reference-workflow strength
        // equivalent, see Request.lastFrameStrength's header).
        let videoState0 = LatentState(latent: videoNoise, cleanLatent: videoNoise, denoiseMask: MLXArray.ones([1, fLat * hLat * wLat, 1]), positions: videoPositions)
        let frame0Conditioner = VideoConditionByLatentIndex(frameIndices: [0], cleanLatent: conditionTokens, strength: 1.0)
        var videoState = frame0Conditioner.apply(to: videoState0, spatialDims: (fLat, hLat, wLat))

        // FFLF: pin an optional user-supplied image as the last latent
        // frame, chained on top of frame-0 conditioning above (applying two
        // VideoConditionByLatentIndex calls in sequence is equivalent to one
        // call with combined indices, since neither changes the sequence
        // length — see Request.lastFrameImagePath/lastFrameStrength headers
        // and docs/reference/comfyui_workflows).
        if let lastFrameImagePath = request.lastFrameImagePath {
            guard fLat >= 2 else {
                throw StageError.invalidDimensions("--last-frame needs at least 2 latent frames (increase --seconds) — got \(fLat)")
            }
            // Existence already validated up-front, before any expensive
            // generation work — see the fail-fast check above. Size is only
            // pre-validated when lastFrameAutoResize is false (otherwise
            // resized just below).
            var cgImage = FrameLoad.loadCGImage(from: lastFrameImagePath)!
            if request.lastFrameAutoResize, (cgImage.width != request.width || cgImage.height != request.height) {
                print("[fflf] auto-resizing last frame \(cgImage.width)x\(cgImage.height) -> \(request.width)x\(request.height) (aspect-fill + center-crop)")
                cgImage = FrameLoad.resizeAspectFillCenterCrop(cgImage, targetWidth: request.width, targetHeight: request.height)
            }
            print("[fflf] pinning last frame from \(lastFrameImagePath.lastPathComponent) (strength \(request.lastFrameStrength))")
            let lastPixels01 = FrameLoad.toArray(cgImage)  // (1, 3, H, W) [0, 1]
            let lastPixelsNeg1to1 = lastPixels01.asType(.float32) * 2.0 - 1.0
            let lastPixelsBCFHW = lastPixelsNeg1to1.reshaped([1, 3, 1, request.height, request.width])
            let lastLatentBCFHW = videoEncoder(lastPixelsBCFHW)
            MLX.eval(lastLatentBCFHW)
            let (lastTokens, _) = VideoLatentPatchifier.patchify(lastLatentBCFHW)
            let lastFrameConditioner = VideoConditionByLatentIndex(frameIndices: [fLat - 1], cleanLatent: lastTokens, strength: request.lastFrameStrength)
            videoState = lastFrameConditioner.apply(to: videoState, spatialDims: (fLat, hLat, wLat))
        }

        // Multi-anchor I2V: pin each supplied --anchor-image at its own
        // latent frame index (see Request.anchorImages's header). Applied
        // after frame-0/FFLF, before grid-guide, so a grid panel wins on a
        // colliding frame index (same last-writer-wins semantics FFLF
        // already relies on above).
        for anchor in request.anchorImages {
            guard anchor.frameIndex < fLat else {
                throw StageError.anchorConfigMismatch(
                    "--anchor-image \(anchor.path.lastPathComponent) frameIndex=\(anchor.frameIndex) out of range [0, \(fLat))")
            }
            print("[anchor-image] pinning \(anchor.path.lastPathComponent) -> latent frame \(anchor.frameIndex) (strength \(anchor.strength))")
            let anchorCGImage = FrameLoad.loadCGImage(from: anchor.path)!  // existence + size re-validated up-front
            let anchorPixels01 = FrameLoad.toArray(anchorCGImage)
            let anchorPixelsNeg1to1 = anchorPixels01.asType(.float32) * 2.0 - 1.0
            let anchorPixelsBCFHW = anchorPixelsNeg1to1.reshaped([1, 3, 1, request.height, request.width])
            let anchorLatentBCFHW = videoEncoder(anchorPixelsBCFHW)
            MLX.eval(anchorLatentBCFHW)
            let (anchorTokens, _) = VideoLatentPatchifier.patchify(anchorLatentBCFHW)
            let anchorConditioner = VideoConditionByLatentIndex(frameIndices: [anchor.frameIndex], cleanLatent: anchorTokens, strength: anchor.strength)
            videoState = anchorConditioner.apply(to: videoState, spatialDims: (fLat, hLat, wLat))
        }

        // Grid guide: split one NxN storyboard-panel image into panels and
        // pin each as its own keyframe guide (see Request.gridImagePath's
        // header). Applied after frame-0/FFLF so an overlapping index wins,
        // same last-writer-wins semantics FFLF already relies on above.
        if let gridImagePath = request.gridImagePath, !request.gridFrameIndices.isEmpty {
            guard let gridCGImage = FrameLoad.loadCGImage(from: gridImagePath) else {
                throw StageError.gridImageNotFound(gridImagePath)
            }
            let panels = FrameLoad.splitGrid(gridCGImage, columns: request.gridColumns, rows: request.gridRows)
            let strengths = request.gridStrengths.isEmpty ? Array(repeating: Float(1.0), count: panels.count) : request.gridStrengths
            for (i, frameIdx) in request.gridFrameIndices.enumerated() {
                guard frameIdx >= 0, frameIdx < fLat else {
                    throw StageError.gridConfigMismatch("gridFrameIndices[\(i)]=\(frameIdx) out of range [0, \(fLat))")
                }
                var panel = panels[i]
                if panel.width != request.width || panel.height != request.height {
                    panel = FrameLoad.resizeAspectFillCenterCrop(panel, targetWidth: request.width, targetHeight: request.height)
                }
                print("[grid-guide] panel \(i) -> latent frame \(frameIdx) (strength \(strengths[i]))")
                let panelPixels01 = FrameLoad.toArray(panel)
                let panelPixelsNeg1to1 = panelPixels01.asType(.float32) * 2.0 - 1.0
                let panelPixelsBCFHW = panelPixelsNeg1to1.reshaped([1, 3, 1, request.height, request.width])
                let panelLatentBCFHW = videoEncoder(panelPixelsBCFHW)
                MLX.eval(panelLatentBCFHW)
                let (panelTokens, _) = VideoLatentPatchifier.patchify(panelLatentBCFHW)
                let panelConditioner = VideoConditionByLatentIndex(frameIndices: [frameIdx], cleanLatent: panelTokens, strength: strengths[i])
                videoState = panelConditioner.apply(to: videoState, spatialDims: (fLat, hLat, wLat))
            }
        }
        var audioState = LatentState(latent: audioNoise, cleanLatent: audioNoise, denoiseMask: MLXArray.ones([1, numAudioTokens, 1]), positions: audioPositions)

        // Custom audio injection: pin a user-supplied WAV as preserved audio
        // tokens instead of generating audio from scratch (see
        // Request.audioTrackPath's header and docs/reference/comfyui_workflows).
        if let audioTrackPath = request.audioTrackPath {
            let wav = try WAVReader.read(url: audioTrackPath)
            var channels = wav.channels
            if channels.count == 1 { channels = [channels[0], channels[0]] }
            channels = Array(channels.prefix(2))
            let resampled = channels.map { LinearResampler.resample($0, fromRate: wav.sampleRate, toRate: 16000) }
            let minLen = resampled.map(\.count).min() ?? 0
            guard minLen > 0 else {
                throw StageError.invalidDimensions("--audio-track \(audioTrackPath.lastPathComponent) has zero samples after resampling")
            }
            let waveform = MLX.stacked(resampled.map { MLXArray($0.prefix(minLen)) }, axis: 0)  // (2, T)

            let audioEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
            guard FileManager.default.fileExists(atPath: audioEncoderURL.path) else {
                throw StageError.audioEncoderCheckpointNotFound(audioEncoderURL)
            }
            let audioEncoder = try AudioVAEEncoderLoader.loadReal(checkpointURL: audioEncoderURL)
            let mel = AudioProcessor().waveformToMel(waveform).expandedDimensions(axis: 0)  // (1, 2, T', 64)
            let trackLatent = audioEncoder(mel)  // (1, 8, T, 16)
            MLX.eval(trackLatent)
            let (trackTokens, trackTokenCount) = AudioPatchifier.patchify(trackLatent)

            let preserveCount = min(trackTokenCount, numAudioTokens)
            print("[audio-track] pinning \(preserveCount)/\(numAudioTokens) audio tokens from \(audioTrackPath.lastPathComponent) (preserved, not generated)")
            let preservedTokens = trackTokens[0..., 0..<preserveCount, 0...]
            // spatialDims=(N,1,1): audio tokens have no spatial extent to
            // group by frame (unlike video's H*W-per-frame), so
            // tokensPerFrame=1 and frameIndices addresses individual
            // time-token positions directly — same generic mechanism,
            // reused rather than duplicated.
            let audioConditioner = VideoConditionByLatentIndex(frameIndices: Array(0..<preserveCount), cleanLatent: preservedTokens, strength: 1.0)
            audioState = audioConditioner.apply(to: audioState, spatialDims: (numAudioTokens, 1, 1))
        }

        let variant = request.transformerVariant
        guard let transformerURL = LTXModelRegistry.transformerCheckpointURL(variant),
              FileManager.default.fileExists(atPath: transformerURL.path) else {
            let reportedURL = LTXModelRegistry.variantDir(variant) ?? RepoPaths.ltxModelsRoot.appendingPathComponent(variant.rawValue)
            throw StageError.transformerCheckpointNotFound(reportedURL)
        }
        if variant != .distilled {
            let cfgNote = cfgActive ? "cfg_scale=\(effectiveCfgScale)" : "cfg_scale=1.0 (off)"
            let stgNote = stgActive ? "stg_scale=\(effectiveStgScale)" : "stg_scale=0.0 (off)"
            let modalityNote = modalityActive ? "modality_scale=\(effectiveModalityScale)" : "modality_scale=1.0 (off)"
            print("[transformer] using \(variant.rawValue) — \(cfgNote), \(stgNote), \(modalityNote)")
        }
        let checkpointLoadStart = stageClock.now
        let rawTransformer = try MLX.loadArrays(url: transformerURL)
        var strippedTransformer: [String: MLXArray] = [:]
        for (key, value) in rawTransformer {
            guard key.hasPrefix("transformer.") else { continue }
            strippedTransformer[String(key.dropFirst("transformer.".count))] = value
        }
        print("   [4/5] checkpoint loaded (\(checkpointLoadStart.duration(to: stageClock.now).formatted()))")

        var loraSources: [(weights: LoRAWeights, strength: Float)] = []
        for (path, strength) in request.loraPaths {
            guard FileManager.default.fileExists(atPath: path.path) else {
                throw StageError.loraNotFound(path)
            }
            print("   [lora] fusing \(path.lastPathComponent) at strength \(strength)")
            loraSources.append((weights: try LoRAWeights.load(url: path), strength: strength))
        }

        let numLayers = 48
        let cfg = distilledConfig(numLayers: numLayers)
        let model = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: strippedTransformer, loraSources: loraSources),
            config: cfg, transformerBlocks: [])

        // dev/dasiwa are trained for the manifest's 30-step dynamic-shift
        // schedule, not the distilled 8-step table — using the latter would
        // under-step them badly. CFG/STG/modality guidance (Milestones
        // 2a/2b/2c) all run when active — see docs/native-i2v-dev-variant-study.md.
        let sigmas: [Float] = variant == .distilled
            ? SigmaSchedule.distilledSigmas
            : SigmaSchedule.ltx2Schedule(steps: 30, numTokens: fLat * hLat * wLat)

        let denoiseSubStart = stageClock.now
        let denoiseResult = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers,
            blockProvider: { idx in
                TransformerCheckpointLoader.makeBlock(
                    TransformerCheckpointLoader.blockWeights(raw: strippedTransformer, blockIndex: idx, loraSources: loraSources),
                    config: cfg)
            },
            videoState: videoState, audioState: audioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: sigmas,
            uncondVideoTextEmbeds: uncondTextResult?.videoEmbeds,
            cfgScale: effectiveCfgScale, rescaleScale: request.rescaleScale,
            stgScale: effectiveStgScale, stgBlocks: Set(request.stgBlocks),
            modalityScale: effectiveModalityScale)
        MLX.eval(denoiseResult.videoLatent, denoiseResult.audioLatent)
        print("   [4/5] runStreaming (\(sigmas.count - 1) steps) (\(denoiseSubStart.duration(to: stageClock.now).formatted()))")
        print("[4/5] done (\(stageStart.duration(to: stageClock.now).formatted()))")
        stageStart = stageClock.now

        // 5. Decode both modalities natively and write to disk.
        print("[5/5] VideoDecoder + AudioVAEDecoder + VocoderWithBWE: decoding output...")
        let videoLatentBCFHW = VideoLatentPatchifier.unpatchify(denoiseResult.videoLatent, dims: (fLat, hLat, wLat))
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let tiling = VideoDecodeTiling.computeAuto(latentShape: videoLatentBCFHW.shape, frameRate: request.fps)
        if let tiling {
            print("   [vae-decode] tiled: tile_frames=\(tiling.tileSizeInFrames) overlap=\(tiling.tileOverlapInFrames)")
        }
        let pixels = VideoDecodeTiling.decode(
            decoder: videoDecoder, latentBCFHW: videoLatentBCFHW.asType(.float32), config: tiling)  // (1, 3, T, H, W), [-1, 1]
        MLX.eval(pixels)
        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        let audioLatentB8T16 = AudioPatchifier.unpatchify(denoiseResult.audioLatent)
        let audioDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        let audioDecoder = try AudioVAEDecoderLoader.loadReal(checkpointURL: audioDecoderURL)
        let mel = audioDecoder(audioLatentB8T16.asType(.float32))  // (1, 2, T', 64)
        MLX.eval(mel)

        let vocoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/vocoder.safetensors")
        let vocoder = try VocoderWithBWELoader.loadReal(checkpointURL: vocoderURL)
        let waveform = vocoder(mel)  // (1, 2, T_audio), [-1, 1]
        MLX.eval(waveform)

        let numChannels = waveform.dim(1)
        var channels: [[Float]] = []
        for c in 0..<numChannels {
            channels.append(waveform[0, c, 0...].asArray(Float.self))
        }
        let audioURL = outputDir.appendingPathComponent("audio.wav")
        try WAVWriter.write(channels: channels, sampleRate: 48000, to: audioURL)
        print("[5/5] done (\(stageStart.duration(to: stageClock.now).formatted()))")

        return Result(sourceImageURL: sourceImageURL, frameDirectory: frameDir, frameCount: frameCount, audioURL: audioURL)
    }
}
