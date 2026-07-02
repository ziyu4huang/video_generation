//
//  TransformerCheckpointLoader.swift
//  LTXVideoDirector
//
//  Builds Attention/FeedForward/AdaLayerNormSingle/BasicAVTransformerBlock/
//  LTXModel instances from a raw (already `transformer.`-prefix-stripped)
//  checkpoint dict, matching the real key scheme confirmed against
//  transformer-distilled-1.1.safetensors. Centralizes the loading logic
//  that was duplicated across LTXModelParityTests/LTXModelRealCheckpointTests
//  so real callers (the eventual native `i2v` path) and tests share it.
//
//  Real production checkpoints store block-level Linear weights MLX-
//  quantized (see QuantizedWeights.swift) — `blockWeights(raw:blockIndex:)`
//  dequantizes ONLY the requested block's slice, which is what makes
//  `LTXModel.streamingForward` able to run all 48 blocks without holding
//  48 blocks' worth of dequantized float32 weights resident at once.
//

import MLX

public enum TransformerCheckpointLoader {
    /// Dequantized weights for a single `transformer_blocks.N` slice (plus
    /// nothing else — top-level keys are loaded separately via
    /// `topLevelWeights`). Filters `raw` to just this block's prefix before
    /// dequantizing, so memory cost is one block, not the whole checkpoint.
    public static func blockWeights(raw: [String: MLXArray], blockIndex: Int) -> [String: MLXArray] {
        let prefix = "transformer_blocks.\(blockIndex)."
        let filtered = raw.filter { $0.key.hasPrefix(prefix) }
        let dequantized = QuantizedWeights.dequantizeLinearWeights(filtered)
        // Strip the "transformer_blocks.N." prefix so keys match makeBlock's expectations.
        return Dictionary(uniqueKeysWithValues: dequantized.map { (String($0.key.dropFirst(prefix.count)), $0.value) })
    }

    /// Dequantized top-level (non-block) weights: patchify/proj_out/AdaLN
    /// singles/scale_shift_tables.
    public static func topLevelWeights(raw: [String: MLXArray]) -> [String: MLXArray] {
        let filtered = raw.filter { !$0.key.hasPrefix("transformer_blocks.") }
        return QuantizedWeights.dequantizeLinearWeights(filtered)
    }

    public static func makeAdaLN(_ arrays: [String: MLXArray], prefix: String) -> AdaLayerNormSingle {
        let embedder = TimestepEmbedder(
            linear1Weight: arrays["\(prefix).emb.timestep_embedder.linear1.weight"]!,
            linear1Bias: arrays["\(prefix).emb.timestep_embedder.linear1.bias"]!,
            linear2Weight: arrays["\(prefix).emb.timestep_embedder.linear2.weight"]!,
            linear2Bias: arrays["\(prefix).emb.timestep_embedder.linear2.bias"]!)
        return AdaLayerNormSingle(emb: embedder, linearWeight: arrays["\(prefix).linear.weight"]!, linearBias: arrays["\(prefix).linear.bias"]!)
    }

    public static func makeAttention(_ arrays: [String: MLXArray], prefix: String, numHeads: Int, headDim: Int, useRope: Bool) -> Attention {
        Attention(
            numHeads: numHeads, headDim: headDim, useRope: useRope,
            toQWeight: arrays["\(prefix).to_q.weight"]!, toQBias: arrays["\(prefix).to_q.bias"],
            toKWeight: arrays["\(prefix).to_k.weight"]!, toKBias: arrays["\(prefix).to_k.bias"],
            toVWeight: arrays["\(prefix).to_v.weight"]!, toVBias: arrays["\(prefix).to_v.bias"],
            toOutWeight: arrays["\(prefix).to_out.weight"]!, toOutBias: arrays["\(prefix).to_out.bias"]!,
            toGateLogitsWeight: arrays["\(prefix).to_gate_logits.weight"], toGateLogitsBias: arrays["\(prefix).to_gate_logits.bias"],
            qNormWeight: arrays["\(prefix).q_norm.weight"]!, kNormWeight: arrays["\(prefix).k_norm.weight"]!)
    }

    public static func makeFF(_ arrays: [String: MLXArray], prefix: String) -> FeedForward {
        FeedForward(
            projInWeight: arrays["\(prefix).proj_in.weight"]!, projInBias: arrays["\(prefix).proj_in.bias"]!,
            projOutWeight: arrays["\(prefix).proj_out.weight"]!, projOutBias: arrays["\(prefix).proj_out.bias"]!)
    }

    /// Build one BasicAVTransformerBlock from an already-dequantized,
    /// prefix-stripped block weight dict (see `blockWeights`).
    public static func makeBlock(_ arrays: [String: MLXArray], config: LTXModelConfig) -> BasicAVTransformerBlock {
        BasicAVTransformerBlock(
            attn1: makeAttention(arrays, prefix: "attn1", numHeads: config.videoNumHeads, headDim: config.videoHeadDim, useRope: true),
            audioAttn1: makeAttention(arrays, prefix: "audio_attn1", numHeads: config.audioNumHeads, headDim: config.audioHeadDim, useRope: true),
            attn2: makeAttention(arrays, prefix: "attn2", numHeads: config.videoNumHeads, headDim: config.videoHeadDim, useRope: false),
            audioAttn2: makeAttention(arrays, prefix: "audio_attn2", numHeads: config.audioNumHeads, headDim: config.audioHeadDim, useRope: false),
            audioToVideoAttn: makeAttention(arrays, prefix: "audio_to_video_attn", numHeads: config.avCrossNumHeads, headDim: config.avCrossHeadDim, useRope: true),
            videoToAudioAttn: makeAttention(arrays, prefix: "video_to_audio_attn", numHeads: config.avCrossNumHeads, headDim: config.avCrossHeadDim, useRope: true),
            ff: makeFF(arrays, prefix: "ff"),
            audioFF: makeFF(arrays, prefix: "audio_ff"),
            scaleShiftTable: arrays["scale_shift_table"]!,
            audioScaleShiftTable: arrays["audio_scale_shift_table"]!,
            promptScaleShiftTable: arrays["prompt_scale_shift_table"]!,
            audioPromptScaleShiftTable: arrays["audio_prompt_scale_shift_table"]!,
            scaleShiftTableA2VCAVideo: arrays["scale_shift_table_a2v_ca_video"]!,
            scaleShiftTableA2VCAAudio: arrays["scale_shift_table_a2v_ca_audio"]!,
            normEps: config.normEps)
    }

    /// Build the top-level LTXModel's non-block components from a
    /// dequantized top-level weight dict (see `topLevelWeights`). Callers
    /// still supply `transformerBlocks` — for `LTXModel.streamingForward`
    /// they pass an empty array since blocks are streamed per-iteration.
    public static func makeModel(_ arrays: [String: MLXArray], config: LTXModelConfig, transformerBlocks: [BasicAVTransformerBlock]) -> LTXModel {
        LTXModel(
            config: config,
            patchifyProjWeight: arrays["patchify_proj.weight"]!, patchifyProjBias: arrays["patchify_proj.bias"]!,
            audioPatchifyProjWeight: arrays["audio_patchify_proj.weight"]!, audioPatchifyProjBias: arrays["audio_patchify_proj.bias"]!,
            projOutWeight: arrays["proj_out.weight"]!, projOutBias: arrays["proj_out.bias"]!,
            audioProjOutWeight: arrays["audio_proj_out.weight"]!, audioProjOutBias: arrays["audio_proj_out.bias"]!,
            scaleShiftTable: arrays["scale_shift_table"]!, audioScaleShiftTable: arrays["audio_scale_shift_table"]!,
            adalnSingle: makeAdaLN(arrays, prefix: "adaln_single"),
            audioAdalnSingle: makeAdaLN(arrays, prefix: "audio_adaln_single"),
            promptAdalnSingle: makeAdaLN(arrays, prefix: "prompt_adaln_single"),
            audioPromptAdalnSingle: makeAdaLN(arrays, prefix: "audio_prompt_adaln_single"),
            avCaVideoScaleShiftAdalnSingle: makeAdaLN(arrays, prefix: "av_ca_video_scale_shift_adaln_single"),
            avCaAudioScaleShiftAdalnSingle: makeAdaLN(arrays, prefix: "av_ca_audio_scale_shift_adaln_single"),
            avCaA2VGateAdalnSingle: makeAdaLN(arrays, prefix: "av_ca_a2v_gate_adaln_single"),
            avCaV2AGateAdalnSingle: makeAdaLN(arrays, prefix: "av_ca_v2a_gate_adaln_single"),
            transformerBlocks: transformerBlocks)
    }
}
