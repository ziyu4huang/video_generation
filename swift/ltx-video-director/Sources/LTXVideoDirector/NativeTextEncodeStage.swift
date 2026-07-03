//
//  NativeTextEncodeStage.swift
//  LTXVideoDirector
//
//  Composes the four already-verified text-encoder pieces into ONE call:
//  GemmaTokenizer -> GemmaEncoder (48-layer streaming Gemma-3-12b) ->
//  TextEmbeddingProjection -> Embeddings1DConnector (video + audio sides)
//  -> the (video, audio) conditioning embeds LTXModel's cross-attention
//  consumes. This is the last unwired piece of the distilled I2V path
//  described in PLAN.md's Gemma-3-12b milestone / docs/TODO.md's "Next:
//  wire into the pipeline" section — every component here was already
//  independently parity-tested; this struct only assembles them in the
//  order base_encoder.get_all_hidden_states -> feature_extractor ->
//  embeddings_connector actually runs.
//
//  NOT yet wired into I2VCommand/RunPyBridge — that additionally needs
//  memory-bounded VAE tiling for real-resolution output, so it stays a
//  separate step (see PLAN.md).
//

import Foundation
import MLX

public struct NativeTextEncodeStage {
    public enum StageError: Error, CustomStringConvertible {
        case tokenizerNotFound(URL)
        public var description: String {
            switch self {
            case .tokenizerNotFound(let url): return "Gemma tokenizer.json not found at \(url.path)"
            }
        }
    }

    public let config: GemmaConfig
    public let maxLength: Int

    public init(config: GemmaConfig = GemmaConfig(), maxLength: Int = 1024) {
        self.config = config
        self.maxLength = maxLength
    }

    public struct Result {
        /// (B, seqLen + numVideoRegisters, videoDim) — feeds the DiT's video text cross-attn.
        public let videoEmbeds: MLXArray
        /// (B, seqLen + numAudioRegisters, audioDim) — feeds the DiT's audio text cross-attn.
        public let audioEmbeds: MLXArray
    }

    /// Runs the full text→conditioning-embeds chain natively (no run.py,
    /// no mlx-lm bridge). Loads and dequantizes the ~7.5GB Gemma checkpoint
    /// and the connector checkpoint fresh on every call — callers that
    /// encode multiple prompts per process should cache `GemmaCheckpointLoader
    /// .loadRaw()`/`ConnectorCheckpointLoader.loadRaw()` themselves and call
    /// a lower-level entry point instead (not yet exposed, since nothing
    /// calls this more than once per process today).
    public func encode(_ prompt: String) throws -> Result {
        let snapshot = try GemmaCheckpointLoader.snapshotDir()
        let tokenizerURL = snapshot.appendingPathComponent("tokenizer.json")
        guard FileManager.default.fileExists(atPath: tokenizerURL.path) else {
            throw StageError.tokenizerNotFound(tokenizerURL)
        }
        var tokenizer = try GemmaTokenizer(tokenizerJSON: tokenizerURL, maxLength: maxLength)
        let (tokenIds, attentionMask) = tokenizer.tokenize(prompt)

        let gemmaRaw = try GemmaCheckpointLoader.loadRaw()
        let hiddenStates = GemmaEncoder.encodeAllLayersConcat(
            raw: gemmaRaw, tokenIds: tokenIds, attentionMask: attentionMask, config: config)

        let connectorRaw = try ConnectorCheckpointLoader.loadRaw()
        let projection = ConnectorCheckpointLoader.makeTextEmbeddingProjection(connectorRaw)
        let (videoProjected, audioProjected) = projection(hiddenStates)

        let videoConnector = ConnectorCheckpointLoader.makeConnector(
            connectorRaw, side: "video", dim: 4096, headDim: 128)
        let audioConnector = ConnectorCheckpointLoader.makeConnector(
            connectorRaw, side: "audio", dim: 2048, headDim: 64)

        let videoEmbeds = videoConnector(videoProjected)
        let audioEmbeds = audioConnector(audioProjected)
        MLX.eval(videoEmbeds, audioEmbeds)

        return Result(videoEmbeds: videoEmbeds, audioEmbeds: audioEmbeds)
    }
}
