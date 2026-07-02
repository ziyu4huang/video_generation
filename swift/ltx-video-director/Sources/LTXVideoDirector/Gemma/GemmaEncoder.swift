//
//  GemmaEncoder.swift
//  LTXVideoDirector
//
//  Full Gemma-3-12b text encoder: embed + sqrt scaling + 48 streaming
//  transformer blocks → 49 hidden states concatenated → (B, T, 188160).
//
//  Mirrors base_encoder.get_all_hidden_states exactly. Blocks are built
//  on-demand from the raw (mmap'd) checkpoint and released after each
//  forward, since 48 dequantized blocks (~250 MB each) can't all stay
//  resident. The 49 hidden states (~1 MB each) ARE all retained — they're
//  the encoder's output, concatenated to feed TextEmbeddingProjection.
//
//  No final model-norm: base_encoder collects raw layer outputs; the
//  Gemma3Model.norm is only used for the lm_head path, not encoding.
//

import Foundation
import MLX

public enum GemmaEncoder {
    /// Encode `text` → concatenated all-layer hidden states (B, T, 188160).
    /// `tokenIds`/`attentionMask`: (B, T) int. Returns (B, T, 49*hidden).
    public static func encodeAllLayersConcat(
        raw: [String: MLXArray], tokenIds: MLXArray, attentionMask: MLXArray,
        config: GemmaConfig
    ) -> MLXArray {
        let embed = GemmaEmbedding(
            embedWeight: GemmaCheckpointLoader.embedTokens(raw), hiddenSize: Float(config.hiddenSize))
        var h = embed(tokenIds)
        let mask = GemmaMask.causalCombined(tokenIds: tokenIds, attentionMask: attentionMask)

        // Collect all 49 hidden states. h0 first, then each layer output.
        var states: [MLXArray] = [h]
        for layerIdx in 0..<config.numHiddenLayers {
            let block = GemmaCheckpointLoader.block(raw, layerIdx: layerIdx, config: config)
            h = block(h, mask: mask)
            MLX.eval(h)
            states.append(h)
            // Drop references to this block's dequantized weights so they can
            // be reclaimed before the next block is built.
            MLX.eval()  // force any pending graph
        }

        // Concatenate along the channel (last) axis: (B, T, 49*hidden).
        let concat = MLX.concatenated(states, axis: -1)
        return concat
    }
}
