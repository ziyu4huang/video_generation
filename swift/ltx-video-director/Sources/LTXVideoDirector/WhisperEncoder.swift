//
//  WhisperEncoder.swift
//  LTXVideoDirector
//
//  Second real piece of the native Swift/MLX Whisper port (after
//  WhisperMel.swift's feature extraction) — ports mlx_whisper.whisper's
//  AudioEncoder / ResidualAttentionBlock / MultiHeadAttention (self-
//  attention only; the encoder never uses cross-attention or a causal
//  mask) line-for-line. Verified against the REAL mlx_whisper module
//  classes at a small config with random weights (not real pretrained
//  large-v3 weights — same "verify the architecture, not the checkpoint"
//  split as scripts/dump_timestep_embedding_reference.py; see
//  scripts/dump_whisper_encoder_reference.py's header for why) — see
//  Tests/LTXVideoDirectorTests/WhisperEncoderParityTests.swift.
//
//  Still open to make transcription itself native (see PLAN.md Phase 3 /
//  docs/TODO.md): loading a REAL large-v3 checkpoint into this encoder,
//  the TextDecoder (causal self-attn + cross-attn + KV cache), the
//  tokenizer, and the decode loop. ASRGate.swift keeps bridging to
//  mlx_whisper until those land.
//

import Foundation
import MLX
import MLXNN

/// Self-attention-only multi-head attention (mlx_whisper's
/// MultiHeadAttention with xa=nil) — query/value have bias, key does not,
/// matching the Python reference exactly.
public struct WhisperAttention {
    public let numHeads: Int
    public let queryWeight: MLXArray, queryBias: MLXArray
    public let keyWeight: MLXArray  // no bias, per mlx_whisper.MultiHeadAttention
    public let valueWeight: MLXArray, valueBias: MLXArray
    public let outWeight: MLXArray, outBias: MLXArray

    public init(
        numHeads: Int,
        queryWeight: MLXArray, queryBias: MLXArray,
        keyWeight: MLXArray,
        valueWeight: MLXArray, valueBias: MLXArray,
        outWeight: MLXArray, outBias: MLXArray
    ) {
        self.numHeads = numHeads
        self.queryWeight = queryWeight; self.queryBias = queryBias
        self.keyWeight = keyWeight
        self.valueWeight = valueWeight; self.valueBias = valueBias
        self.outWeight = outWeight; self.outBias = outBias
    }

    private func linear(_ x: MLXArray, weight: MLXArray, bias: MLXArray?) -> MLXArray {
        let y = MLX.matmul(x, weight.transposed(1, 0))
        return bias.map { y + $0 } ?? y
    }

    /// Mirrors MultiHeadAttention.__call__/qkv_attention exactly: scale
    /// applied to BOTH q and k by `headDim ** -0.25` (not the usual single
    /// `1/sqrt(d)` on the dot product) — using MLX's fused SDPA with that
    /// same asymmetric-pre-scale would double-apply differently, so this
    /// uses the raw matmul+softmax form to stay bit-for-bit faithful to the
    /// reference rather than an equivalent-but-differently-rounded fused op.
    /// - Parameters:
    ///   - x: query input (decoder's own hidden states, or encoder input)
    ///   - crossInput: if set, K/V come from this instead of `x`
    ///     (cross-attention to encoder output — `xa` in the Python reference)
    ///   - mask: additive mask added to QK^T before softmax (causal mask for
    ///     decoder self-attention; nil for encoder self-attn and cross-attn)
    public func callAsFunction(_ x: MLXArray, crossInput: MLXArray? = nil, mask: MLXArray? = nil) -> MLXArray {
        let b = x.dim(0)
        let n = x.dim(1)
        let kvInput = crossInput ?? x
        let nKV = kvInput.dim(1)
        let headDim = queryWeight.dim(0) / numHeads
        let scale = Float(pow(Double(headDim), -0.25))

        let q = linear(x, weight: queryWeight, bias: queryBias)
        let k = linear(kvInput, weight: keyWeight, bias: nil)
        let v = linear(kvInput, weight: valueWeight, bias: valueBias)

        let qh = (q.reshaped([b, n, numHeads, headDim]).transposed(0, 2, 1, 3)) * scale
        let kh = (k.reshaped([b, nKV, numHeads, headDim]).transposed(0, 2, 3, 1)) * scale
        let vh = v.reshaped([b, nKV, numHeads, headDim]).transposed(0, 2, 1, 3)

        var qk = MLX.matmul(qh, kh)
        if let mask {
            qk = qk + mask[0..<n, 0..<n]
        }
        let w = MLX.softmax(qk, axis: -1, precise: true)
        var out = MLX.matmul(w, vh)
        out = out.transposed(0, 2, 1, 3).reshaped([b, n, numHeads * headDim])
        return linear(out, weight: outWeight, bias: outBias)
    }

    /// Same Q/K projection + scaled QK + softmax-weighted output as
    /// `callAsFunction`, but ALSO returns the scaled pre-softmax QK matrix
    /// `(b, numHeads, n, nKV)` — the cross-attention score matrix mlx_whisper's
    /// DTW word-alignment consumes (`forward_with_cross_qk` → `cross_qk`).
    /// Computes Q/K once and derives both the attention output and the score
    /// matrix from it (no duplicate projection). `qk` is the SCALED
    /// (headDim**-0.25 on both q and k, matching qkv_attention) but
    /// pre-softmax, pre-mask matrix — exactly what `find_alignment` re-softmaxes
    /// with its own qk_scale.
    public func callWithQK(_ x: MLXArray, crossInput: MLXArray?, mask: MLXArray?) -> (output: MLXArray, qk: MLXArray) {
        let b = x.dim(0)
        let n = x.dim(1)
        let kvInput = crossInput ?? x
        let nKV = kvInput.dim(1)
        let headDim = queryWeight.dim(0) / numHeads
        let scale = Float(pow(Double(headDim), -0.25))

        let q = linear(x, weight: queryWeight, bias: queryBias)
        let k = linear(kvInput, weight: keyWeight, bias: nil)
        let v = linear(kvInput, weight: valueWeight, bias: valueBias)

        let qh = (q.reshaped([b, n, numHeads, headDim]).transposed(0, 2, 1, 3)) * scale
        let kh = (k.reshaped([b, nKV, numHeads, headDim]).transposed(0, 2, 3, 1)) * scale
        let vh = v.reshaped([b, nKV, numHeads, headDim]).transposed(0, 2, 1, 3)

        var qk = MLX.matmul(qh, kh)
        if let mask {
            qk = qk + mask[0..<n, 0..<n]
        }
        let w = MLX.softmax(qk, axis: -1, precise: true)
        var out = MLX.matmul(w, vh)
        out = out.transposed(0, 2, 1, 3).reshaped([b, n, numHeads * headDim])
        return (linear(out, weight: outWeight, bias: outBias), qk)
    }
}

func layerNorm(_ x: MLXArray, weight: MLXArray, bias: MLXArray, eps: Float = 1e-5) -> MLXArray {
    let mean = x.mean(axis: -1, keepDims: true)
    let variance = MLX.pow(x - mean, 2).mean(axis: -1, keepDims: true)
    let normalized = (x - mean) / MLX.sqrt(variance + eps)
    return normalized * weight + bias
}

/// mlx_whisper's ResidualAttentionBlock with cross_attention=false (the
/// encoder never sets it true) — self-attn + MLP, both pre-LayerNorm.
public struct WhisperEncoderBlock {
    public let attn: WhisperAttention
    public let attnLnWeight: MLXArray, attnLnBias: MLXArray
    public let mlp1Weight: MLXArray, mlp1Bias: MLXArray
    public let mlp2Weight: MLXArray, mlp2Bias: MLXArray
    public let mlpLnWeight: MLXArray, mlpLnBias: MLXArray

    public init(
        attn: WhisperAttention,
        attnLnWeight: MLXArray, attnLnBias: MLXArray,
        mlp1Weight: MLXArray, mlp1Bias: MLXArray,
        mlp2Weight: MLXArray, mlp2Bias: MLXArray,
        mlpLnWeight: MLXArray, mlpLnBias: MLXArray
    ) {
        self.attn = attn
        self.attnLnWeight = attnLnWeight; self.attnLnBias = attnLnBias
        self.mlp1Weight = mlp1Weight; self.mlp1Bias = mlp1Bias
        self.mlp2Weight = mlp2Weight; self.mlp2Bias = mlp2Bias
        self.mlpLnWeight = mlpLnWeight; self.mlpLnBias = mlpLnBias
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = x
        h = h + attn(layerNorm(h, weight: attnLnWeight, bias: attnLnBias))
        let mlpIn = layerNorm(h, weight: mlpLnWeight, bias: mlpLnBias)
        let mlpHidden = MLXNN.gelu(MLX.matmul(mlpIn, mlp1Weight.transposed(1, 0)) + mlp1Bias)
        let mlpOut = MLX.matmul(mlpHidden, mlp2Weight.transposed(1, 0)) + mlp2Bias
        h = h + mlpOut
        return h
    }
}

/// mlx_whisper.whisper.AudioEncoder: two Conv1d+GELU stages (second strided
/// 2x), + fixed sinusoidal positional embedding, N self-attention blocks,
/// final LayerNorm.
public struct WhisperEncoder {
    public let conv1Weight: MLXArray, conv1Bias: MLXArray
    public let conv2Weight: MLXArray, conv2Bias: MLXArray
    public let blocks: [WhisperEncoderBlock]
    public let lnPostWeight: MLXArray, lnPostBias: MLXArray

    public init(
        conv1Weight: MLXArray, conv1Bias: MLXArray,
        conv2Weight: MLXArray, conv2Bias: MLXArray,
        blocks: [WhisperEncoderBlock],
        lnPostWeight: MLXArray, lnPostBias: MLXArray
    ) {
        self.conv1Weight = conv1Weight; self.conv1Bias = conv1Bias
        self.conv2Weight = conv2Weight; self.conv2Bias = conv2Bias
        self.blocks = blocks
        self.lnPostWeight = lnPostWeight; self.lnPostBias = lnPostBias
    }

    /// Sinusoidal positional embedding, mirrors mlx_whisper.whisper.sinusoids
    /// exactly: concat(sin(scaled_time), cos(scaled_time)) along channels.
    public static func sinusoids(length: Int, channels: Int, maxTimescale: Double = 10000) -> MLXArray {
        precondition(channels % 2 == 0, "channels must be even")
        let logTimescaleIncrement = log(maxTimescale) / Double(channels / 2 - 1)
        let invTimescales = MLX.exp(MLXArray(-logTimescaleIncrement) * MLXArray(Array(0..<(channels / 2)).map { Float($0) }))
        let time = MLXArray(Array(0..<length).map { Float($0) }).expandedDimensions(axis: 1)
        let scaledTime = time * invTimescales.expandedDimensions(axis: 0)
        return MLX.concatenated([MLX.sin(scaledTime), MLX.cos(scaledTime)], axis: 1)
    }

    /// - Parameter mel: (batch, n_frames, n_mels) — NOTE this layout (frames,
    ///   mels), matching mlx_whisper's own convention of feeding
    ///   `mx.conv1d` channel-last (its log_mel_spectrogram output is
    ///   (n_frames, n_mels) with no transpose before encoder input either).
    public func callAsFunction(_ mel: MLXArray) -> MLXArray {
        // float16 in — mlx_whisper casts mel_segment to dtype (float16) before
        // the encoder, and its audio positional embedding is
        // `sinusoids(...).astype(dtype)`. Casting BOTH here keeps the whole
        // encoder (and thus the cross-attention QK the DTW word-aligner reads)
        // in float16 to match mlx_whisper; without these casts the float32
        // sinusoids upcast the activations back to float32 and the alignment
        // distribution drifts. See WhisperModel.load for the full rationale.
        var x = MLX.conv1d(mel.asType(.float16), conv1Weight, stride: 1, padding: 1)
        x = x + conv1Bias
        x = MLXNN.gelu(x)
        x = MLX.conv1d(x, conv2Weight, stride: 2, padding: 1)
        x = x + conv2Bias
        x = MLXNN.gelu(x)

        let posEmbedding = Self.sinusoids(length: x.dim(1), channels: x.dim(2)).asType(.float16)
        x = x + posEmbedding

        for block in blocks {
            x = block(x)
        }

        return layerNorm(x, weight: lnPostWeight, bias: lnPostBias)
    }
}
