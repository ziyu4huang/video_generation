/// A source of embeddings for a single micro-batch of text. Implementations
/// own their own internal padding/truncation for that batch only — callers
/// (`EmbeddingEngine`) are responsible for splitting large inputs into
/// micro-batches before calling this.
public protocol EmbeddingBackend: Sendable {
    func embedMicroBatch(_ texts: [String]) async throws -> [[Float]]
}
