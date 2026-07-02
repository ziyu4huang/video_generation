//
//  TextEmbeddingProjection.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.text_encoders.gemma.feature_extractor.
//  TextEmbeddingProjection — the projection that sits BETWEEN the
//  Gemma-3-12b LLM's concatenated multi-layer hidden states and the
//  Embeddings1DConnector (already ported) that feeds the DiT.
//
//  Forward (verbatim from feature_extractor.py):
//    v_scale = sqrt(video_dim / embedding_dim)    # embedding_dim = 3840
//    video_embeds = video_aggregate_embed(hidden_states * v_scale)
//    a_scale = sqrt(audio_dim / embedding_dim)
//    audio_embeds = audio_aggregate_embed(hidden_states * a_scale)
//  where video_aggregate_embed / audio_aggregate_embed are nn.Linear
//  (input_dim=188160 = 49 layers * 3840 hidden, bias=True) projecting to
//  video_dim (4096) / audio_dim (2048) respectively.
//
//  With this + Embeddings1DConnector both native, the ENTIRE text-encoder
//  connector stack (Gemma hidden states → DiT conditioning embeds) is
//  native Swift except for the Gemma-3-12b LLM forward pass itself — and
//  that is a standard HF MLX model (mlx-community/gemma-3-12b-it-4bit,
//  ~7.5 GB) loadable via mlx-swift's LLM support, NOT a hand-port.
//  See PLAN.md's text-encoder section.
//

import Foundation
import MLX

public struct TextEmbeddingProjection {
    public let videoAggregateEmbedWeight: MLXArray
    public let videoAggregateEmbedBias: MLXArray
    public let audioAggregateEmbedWeight: MLXArray
    public let audioAggregateEmbedBias: MLXArray
    /// Gemma's per-layer hidden dim (3840). Used for the rescale factor
    /// `sqrt(target_dim / embedding_dim)` applied before each projection.
    public let embeddingDim: Float

    public init(
        videoAggregateEmbedWeight: MLXArray,
        videoAggregateEmbedBias: MLXArray,
        audioAggregateEmbedWeight: MLXArray,
        audioAggregateEmbedBias: MLXArray,
        embeddingDim: Float = 3840
    ) {
        self.videoAggregateEmbedWeight = videoAggregateEmbedWeight
        self.videoAggregateEmbedBias = videoAggregateEmbedBias
        self.audioAggregateEmbedWeight = audioAggregateEmbedWeight
        self.audioAggregateEmbedBias = audioAggregateEmbedBias
        self.embeddingDim = embeddingDim
    }

    /// Build from a raw weights dict keyed by `video_aggregate_embed.{weight,bias}`
    /// and `audio_aggregate_embed.{weight,bias}` (the checkpoint key scheme).
    public init(weights: [String: MLXArray], embeddingDim: Float = 3840) {
        self.init(
            videoAggregateEmbedWeight: weights["video_aggregate_embed.weight"]!,
            videoAggregateEmbedBias: weights["video_aggregate_embed.bias"]!,
            audioAggregateEmbedWeight: weights["audio_aggregate_embed.weight"]!,
            audioAggregateEmbedBias: weights["audio_aggregate_embed.bias"]!,
            embeddingDim: embeddingDim
        )
    }

    /// Project multi-layer hidden states (B, seq_len, input_dim) →
    /// (video_embeds, audio_embeds). Matches the reference's rescale-then-
    /// project exactly, including deriving each target_dim from its own
    /// Linear weight's output axis (not a stored field).
    public func callAsFunction(_ hiddenStates: MLXArray) -> (video: MLXArray, audio: MLXArray) {
        let h = hiddenStates.asType(.float32)
        let vDim = Float(videoAggregateEmbedWeight.dim(0))
        let vScale = Foundation.sqrt(vDim / embeddingDim)
        let video = MLX.matmul(h * vScale, videoAggregateEmbedWeight.transposed(-1, -2)) + videoAggregateEmbedBias

        let aDim = Float(audioAggregateEmbedWeight.dim(0))
        let aScale = Foundation.sqrt(aDim / embeddingDim)
        let audio = MLX.matmul(h * aScale, audioAggregateEmbedWeight.transposed(-1, -2)) + audioAggregateEmbedBias

        return (video, audio)
    }
}
