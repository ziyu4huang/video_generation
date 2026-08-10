/// Splits arbitrary-sized input into fixed-size micro-batches before handing
/// each one to the backend. This is a first-class requirement, not an
/// optimization: embedding an unbounded number of texts in one padded batch
/// caused a real Metal OOM (~107GB allocation attempt) in the Python
/// benchmark harness this server followed on from (PR #1128).
public final class EmbeddingEngine: Sendable {
    private let backend: any EmbeddingBackend
    private let microBatchSize: Int

    public init(backend: any EmbeddingBackend, microBatchSize: Int) {
        precondition(microBatchSize > 0, "microBatchSize must be positive")
        self.backend = backend
        self.microBatchSize = microBatchSize
    }

    public func embed(texts: [String]) async throws -> [[Float]] {
        var results: [[Float]] = []
        results.reserveCapacity(texts.count)

        for start in stride(from: 0, to: texts.count, by: microBatchSize) {
            let end = min(start + microBatchSize, texts.count)
            let vectors = try await backend.embedMicroBatch(Array(texts[start..<end]))
            results.append(contentsOf: vectors)
        }

        return results
    }
}
