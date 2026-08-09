import MLX
import MLXEmbedders
import Tokenizers

/// Wraps `mlx-swift-lm`'s `MLXEmbedders.ModelContainer` as an `EmbeddingBackend`.
///
/// Padding is computed independently per call to `embedMicroBatch` (never
/// across the caller's full input list) — `EmbeddingEngine` is what bounds
/// the size of each call. `maxLength` truncates before padding so a single
/// abnormally long input in a batch can't blow up every other item's
/// padded length within that same micro-batch.
public final class MLXEmbeddingBackend: EmbeddingBackend {
    private let container: ModelContainer
    private let maxLength: Int

    private init(container: ModelContainer, maxLength: Int) {
        self.container = container
        self.maxLength = maxLength
    }

    /// Loads the model once. This is the only place model loading happens —
    /// call it exactly once at process startup, before serving any requests.
    public static func load(configuration: ModelConfiguration, maxLength: Int) async throws -> MLXEmbeddingBackend {
        let container = try await loadModelContainer(configuration: configuration)
        return MLXEmbeddingBackend(container: container, maxLength: maxLength)
    }

    public func embedMicroBatch(_ texts: [String]) async throws -> [[Float]] {
        let maxLength = self.maxLength
        return await container.perform { model, tokenizer, pooling -> [[Float]] in
            let encoded = texts.map { text -> [Int] in
                var tokens = tokenizer.encode(text: text, addSpecialTokens: true)
                if tokens.count > maxLength {
                    tokens = Array(tokens.prefix(maxLength))
                }
                return tokens
            }

            let batchMaxLength = encoded.map(\.count).max() ?? 0
            let padValue = tokenizer.eosTokenId ?? 0

            let padded = stacked(
                encoded.map { tokens in
                    MLXArray(tokens + Array(repeating: padValue, count: batchMaxLength - tokens.count))
                })
            // Built from each sequence's real (pre-padding) length, NOT from
            // comparing against padValue: `tokenizer.encode` appends a real EOS
            // token to every sequence, and that EOS token's id is the same as
            // padValue — comparing against padValue would incorrectly mask out
            // every sequence's real trailing EOS token as if it were padding,
            // corrupting both self-attention and .mean/.max/.last pooling.
            let lengths = encoded.map(\.count)
            let maskInts = lengths.map { length in
                Array(repeating: 1, count: length) + Array(repeating: 0, count: batchMaxLength - length)
            }
            let mask = stacked(maskInts.map { MLXArray($0) }) .!= 0
            let tokenTypes = MLXArray.zeros(like: padded)

            let output = model(padded, positionIds: nil, tokenTypeIds: tokenTypes, attentionMask: mask)
            let result = pooling(output, mask: mask, normalize: true, applyLayerNorm: true)
            result.eval()

            return result.map { $0.asArray(Float.self) }
        }
    }
}
