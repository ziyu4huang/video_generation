//
//  MusicGenEncodecAdapter.swift
//  MusicGenDirector
//
//  Thin wrapper around Blaizzy/mlx-audio-swift's Encodec (MLXAudioCodecs),
//  configured with facebook/encodec_32khz's real numbers — decode-only,
//  since MusicGen T2A never encodes audio. EncodecConfig.swift is fully
//  Codable/data-driven so our audio_encoder_config.json (written verbatim by
//  run.py import-musicgen from the real HF config, see Task 2) decodes
//  directly with zero manual field mapping (confirmed by reading the real
//  EncodecConfig.swift/Encodec.swift/EncodecQuantization.swift/
//  EncodecLayers.swift source in the resolved SPM checkout, not just the
//  plan draft).
//
//  IMPORTANT: two of our real config values differ from EncodecConfig's
//  library defaults (useCausalConv=false, useConvShortcut=false vs defaults
//  true/true) — decoding our real audio_encoder_config.json handles this
//  correctly since EncodecConfig reads every field from the supplied JSON
//  via a custom `init(from:)`.
//
//  A naive `model.update(parameters: ModuleParameters.unflattened(rawWeights),
//  verify: .noUnusedKeys)` (the plan draft's approach, copied from
//  `Encodec.fromModelDirectory`) does NOT work with our real checkpoint and
//  fails immediately with "Unhandled keys [weight_g, weight_v] in
//  encoder.layers.0.conv...". Two real mismatches between our flat HF-derived
//  `audio_encoder.safetensors` (raw PyTorch state_dict, copied verbatim by
//  run.py import-musicgen with zero transformation) and what this Swift
//  Encodec module's `update()` actually consumes:
//
//  1. Every conv/conv-transpose layer here uses PyTorch's `weight_norm`
//     parametrization, stored as separate `weight_g` (per-dim0 magnitude)
//     + `weight_v` (direction) tensors — never a fused `weight`. This
//     Swift port's `EncodecConv1d`/`EncodecBaseConvTranspose1d` wrap plain
//     `MLXNN.Conv1d` (or a bare `weight`/`bias` pair) that only understands
//     a single fused `weight`, with NO weight_norm-aware loading path. We
//     have to fuse `weight = v * (g / ||v||_{dim0})` ourselves (confirmed
//     dim0-based by checking real shapes: weight_g is always (dim0, 1, 1)
//     regardless of whether dim0 is the PyTorch "out_channels" axis
//     (regular Conv1d, weight shape (out, in, kernel)) or the "in_channels"
//     axis (ConvTranspose1d, weight shape (in, out, kernel) in PyTorch) —
//     then transpose into this port's MLX-native (out, kernel, in) layout:
//     `.transposed(0, 2, 1)` for regular convs, `.transposed(1, 2, 0)` for
//     transpose convs (verified against real shapes on disk: e.g.
//     decoder.layers.3 — a ConvTranspose1d, kernel=16, stride=8 upsample —
//     has weight_v (1024, 512, 16) i.e. PyTorch (in=1024, out=512, kernel);
//     EncodecBaseConvTranspose1d.weight's own init produces (out, kernel,
//     in) = (512, 16, 1024), matching `.transposed(1, 2, 0)`).
//
//  2. `EncodecLSTM`'s `Wx`/`Wh`/`bias` are plain (non-`@ModuleInfo`) Swift
//     properties on a `Module` subclass, picked up by Mirror-based
//     reflection under their literal property names — NOT PyTorch
//     `nn.LSTM`'s per-layer-suffixed `weight_ih_l{n}`/`weight_hh_l{n}`/
//     `bias_ih_l{n}`/`bias_hh_l{n}` naming, and NOT its single combined
//     multi-layer module (this port instead uses an ARRAY of per-layer
//     `EncodecLSTM` cells, keyed `lstm.{n}.Wx` etc). `weight_ih`/`weight_hh`
//     map straight across (same shape: (4*hidden, input_or_hidden) — same
//     PyTorch gate order i,f,g,o that this port's manual gate-slicing code
//     also uses, confirmed by reading `EncodecLSTM.callAsFunction`). The
//     bias needs summing: PyTorch's LSTM forward adds `bias_ih + bias_hh`
//     as two separate terms; this port's `EncodecLSTM.callAsFunction` only
//     adds a SINGLE bias (into `xProj`, never into `hProj`) — mathematically
//     equivalent to PyTorch's sum-of-two-biases as long as our combined
//     bias = `bias_ih_l{n} + bias_hh_l{n}` (confirmed by reading the
//     forward-pass code: `gates = xT + hProj` where `xT` already carries
//     the single bias via `addMM`, `hProj` never adds one).
//
//  The remapping in `remapEncodecCheckpoint` below re-derives the exact
//  layer-KIND sequence (conv / conv-transpose / resnet-block / lstm-block /
//  no-params) that `EncodecEncoder.init`/`EncodecDecoder.init` build, purely
//  as a function of `config` — a faithful transcription of that real init
//  code (not a guess), cross-checked directly against the real
//  audio_encoder.safetensors key set (params present at exactly the
//  predicted indices, e.g. encoder.layers.{0,3,6,9,12,15}=conv,
//  {1,4,7,10}=resnet, {13}=lstm; decoder.layers.{0,15}=conv,
//  {1}=lstm, {3,6,9,12}=conv-transpose, {4,7,10,13}=resnet — no others).
//  This can't instead walk the real `Encodec`/`EncodecEncoder`/
//  `EncodecDecoder` instances' own submodule trees at runtime because
//  `Encodec.encoder`/`.decoder`/`.quantizer` and `EncodecEncoder.layers`/
//  `EncodecDecoder.layers`/`EncodecResnetBlock.block`/`.shortcut`/
//  `EncodecLSTMBlock.lstm` are all internal (no `public` modifier on their
//  `@ModuleInfo` property declarations) — invisible outside MLXAudioCodecs,
//  confirmed by reading the real declarations.
//
//  numQuantizers (4, for our real targetBandwidths=[2.2]) is likewise
//  recomputed locally from the same public formula
//  `EncodecResidualVectorQuantizer.init` uses (`quantizer.numQuantizers`
//  itself is unreachable — `Encodec.quantizer` is internal) — confirmed
//  against the real checkpoint's `quantizer.layers.{0..3}` (exactly 4).
//
//  Weight keys: identity mapping vs the flat `audio_encoder.safetensors`
//  produced by run.py import-musicgen (confirmed directly against the real
//  checkpoint: 116 keys — `encoder.layers.{0,1,3,4,6,7,9,10,12,13,15}...`,
//  `decoder.layers.{0,1,3,4,6,7,9,10,12,13,15}...`, `quantizer.layers.{0..3}.
//  codebook.{embed,embed_avg,cluster_size,inited}` — `embed_avg`/
//  `cluster_size`/`inited` are k-means EMA training bookkeeping the library's
//  `EncodecEuclideanCodebook` never declares as a parameter (only `embed`
//  is), so they're dropped, not mapped.
//
//  Numerically verified via `musicgen verify-encodec` against
//  gen_musicgen_encodec_ref.py.
//

import Foundation
import MLX
import MLXNN
import MLXAudioCodecs

public struct MusicGenEncodecAdapter {
    public let codec: Encodec
    /// Codec frame rate in Hz — sampleRate / product(upsamplingRatios).
    /// 32000 / (8*5*4*4) = 50 for encodec_32khz.
    public let frameRate: Int
    public let sampleRate: Int

    /// `configPath`/`weightsPath` — audio_encoder_config.json /
    /// audio_encoder.safetensors from run.py import-musicgen.
    public init(configPath: URL, weightsPath: URL) throws {
        let configData = try Data(contentsOf: configPath)
        let config = try JSONDecoder().decode(EncodecConfig.self, from: configData)
        let model = Encodec(config: config)

        let raw = try loadArrays(url: weightsPath)
        let numQuantizers = Self.computeNumQuantizers(config: config)
        let remapped = Self.remapEncodecCheckpoint(raw: raw, config: config, numQuantizers: numQuantizers)
        // .allModelKeysSet / .shapeMismatch (not just .noUnusedKeys) matter
        // specifically because layerKinds()/remapEncodecCheckpoint() re-derive
        // this library's layer topology from config alone (Encodec's own
        // module tree is `internal`, unreachable for introspection — see file
        // header). If a future mlx-audio-swift version shifts that topology,
        // a wrong-but-plausible key mapping would otherwise fail silently:
        // update(parameters:) only warns on EXTRA unmatched keys by default,
        // leaving any un-matched real parameter at its random init value.
        try model.update(parameters: ModuleParameters.unflattened(remapped),
                          verify: [.noUnusedKeys, .allModelKeysSet, .shapeMismatch])

        self.codec = model
        self.frameRate = config.samplingRate / config.upsamplingRatios.reduce(1, *)
        self.sampleRate = model.samplingRate
    }

    /// `codes`: (numCodebooks, frames) int32 clean (de-interleaved) codebook
    /// indices. Returns the decoded waveform, shape (batch=1, samples,
    /// channels=1) — mlx-audio-swift's Encodec uses MLX-native
    /// channels-last (NLC) convolutions throughout (confirmed by reading
    /// EncodecLayers.swift), unlike HF's PyTorch channels-first convention.
    public func decode(codes: MLXArray) -> MLXArray {
        // Encodec.decode expects audioCodes shape (num_chunks, batch,
        // num_codebooks, frames) (confirmed from Encodec.swift's decode()
        // doc comment and its `audioCodes[0]` chunk-0 access when
        // chunkLength is nil) — we have no chunking (chunkLengthS=nil in
        // our config, since MusicGen decodes short fixed-length clips in
        // one shot), so num_chunks=batch=1.
        let shaped = codes.expandedDimensions(axis: 0).expandedDimensions(axis: 0)
        let waveform = codec.decode(shaped, [nil])
        MLX.eval(waveform)
        return waveform
    }

    // MARK: - Checkpoint remapping (see file header for the full rationale)

    /// Mirrors `EncodecResidualVectorQuantizer.init`'s real formula (that
    /// type's own `numQuantizers` is unreachable from outside MLXAudioCodecs
    /// — `Encodec.quantizer` is internal — so this is recomputed from the
    /// same public config fields).
    private static func computeNumQuantizers(config: EncodecConfig) -> Int {
        let hopLength = config.upsamplingRatios.reduce(1, *)
        let frameRate = Int(ceil(Float(config.samplingRate) / Float(hopLength)))
        let maxBandwidth = config.targetBandwidths.max() ?? 24.0
        return Int(1000 * maxBandwidth / Float(frameRate * 10))
    }

    private enum LayerKind {
        case conv
        case convTranspose
        case resnetBlock
        case lstmBlock
        case none   // ELU or Identity — no learnable params
    }

    /// Re-derives, purely from `config`, the ordered layer-kind sequence
    /// `EncodecEncoder.init`/`EncodecDecoder.init` build (see file header).
    private static func layerKinds(config: EncodecConfig, isDecoder: Bool) -> [LayerKind] {
        var kinds: [LayerKind] = []
        if isDecoder {
            kinds.append(.conv)         // initial conv
            kinds.append(.lstmBlock)
            for _ in config.upsamplingRatios {
                kinds.append(.none)           // ELU
                kinds.append(.convTranspose)  // upsample
                for _ in 0..<config.numResidualLayers {
                    kinds.append(.resnetBlock)
                }
            }
            kinds.append(.none)         // final ELU
            kinds.append(.conv)         // final conv
        } else {
            kinds.append(.conv)         // initial conv
            for _ in config.upsamplingRatios {
                for _ in 0..<config.numResidualLayers {
                    kinds.append(.resnetBlock)
                }
                kinds.append(.none)           // ELU
                kinds.append(.conv)           // downsample
            }
            kinds.append(.lstmBlock)
            kinds.append(.none)         // final ELU
            kinds.append(.conv)         // final conv
        }
        return kinds
    }

    /// Fuses PyTorch `weight_norm` (`weight = v * (g / ||v||)`, norm taken
    /// per-index along dim0 — see file header) and transposes into this
    /// port's MLX-native (out, kernel, in) conv-weight layout.
    private static func fusedConvWeight(g: MLXArray, v: MLXArray, transpose: Bool) -> MLXArray {
        let norm = MLX.sqrt((v * v).sum(axes: [1, 2], keepDims: true))
        let fused = v * (g / norm)
        return transpose ? fused.transposed(1, 2, 0) : fused.transposed(0, 2, 1)
    }

    private static func remapConv(
        prefix: String, raw: [String: MLXArray], transpose: Bool, into out: inout [String: MLXArray]
    ) {
        guard let g = raw["\(prefix).weight_g"], let v = raw["\(prefix).weight_v"] else {
            return
        }
        out["\(prefix).weight"] = fusedConvWeight(g: g, v: v, transpose: transpose)
        if let b = raw["\(prefix).bias"] {
            out["\(prefix).bias"] = b
        }
    }

    private static func remapResnetBlock(
        prefix: String, raw: [String: MLXArray], useConvShortcut: Bool, into out: inout [String: MLXArray]
    ) {
        // block = [ELU, Conv, ELU, Conv] -> convs at sub-indices 1 and 3
        // (see EncodecResnetBlock.init, real source).
        remapConv(prefix: "\(prefix).block.1.conv", raw: raw, transpose: false, into: &out)
        remapConv(prefix: "\(prefix).block.3.conv", raw: raw, transpose: false, into: &out)
        if useConvShortcut {
            remapConv(prefix: "\(prefix).shortcut.conv", raw: raw, transpose: false, into: &out)
        }
    }

    private static func remapLSTMBlock(
        prefix: String, raw: [String: MLXArray], numLstmLayers: Int, into out: inout [String: MLXArray]
    ) {
        let blockPrefix = "\(prefix).lstm"
        for n in 0..<numLstmLayers {
            guard let wih = raw["\(blockPrefix).weight_ih_l\(n)"],
                  let whh = raw["\(blockPrefix).weight_hh_l\(n)"] else { continue }
            out["\(blockPrefix).\(n).Wx"] = wih
            out["\(blockPrefix).\(n).Wh"] = whh
            if let bih = raw["\(blockPrefix).bias_ih_l\(n)"],
               let bhh = raw["\(blockPrefix).bias_hh_l\(n)"] {
                out["\(blockPrefix).\(n).bias"] = bih + bhh
            }
        }
    }

    private static func remapEncodecCheckpoint(
        raw: [String: MLXArray], config: EncodecConfig, numQuantizers: Int
    ) -> [String: MLXArray] {
        var out: [String: MLXArray] = [:]

        for (topPrefix, isDecoder) in [("encoder", false), ("decoder", true)] {
            let kinds = layerKinds(config: config, isDecoder: isDecoder)
            for (i, kind) in kinds.enumerated() {
                let layerPrefix = "\(topPrefix).layers.\(i)"
                switch kind {
                case .conv:
                    remapConv(prefix: "\(layerPrefix).conv", raw: raw, transpose: false, into: &out)
                case .convTranspose:
                    remapConv(prefix: "\(layerPrefix).conv", raw: raw, transpose: true, into: &out)
                case .resnetBlock:
                    remapResnetBlock(prefix: layerPrefix, raw: raw, useConvShortcut: config.useConvShortcut, into: &out)
                case .lstmBlock:
                    remapLSTMBlock(prefix: layerPrefix, raw: raw, numLstmLayers: config.numLstmLayers, into: &out)
                case .none:
                    break
                }
            }
        }

        for i in 0..<numQuantizers {
            if let embed = raw["quantizer.layers.\(i).codebook.embed"] {
                out["quantizer.layers.\(i).codebook.embed"] = embed
            }
        }

        return out
    }
}
