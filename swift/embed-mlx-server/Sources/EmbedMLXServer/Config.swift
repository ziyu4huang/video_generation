import MLXEmbedders

public struct ServerConfig: Sendable {
    public let port: Int
    public let modelRepo: String
    public let microBatchSize: Int
    public let maxLength: Int

    public init(port: Int, modelRepo: String, microBatchSize: Int, maxLength: Int) {
        self.port = port
        self.modelRepo = modelRepo
        self.microBatchSize = microBatchSize
        self.maxLength = maxLength
    }

    public static let defaultPort = 8090
    public static let defaultModelRepo = "BAAI/bge-m3"
    public static let defaultMicroBatchSize = 32
    // BGE-M3's real context window (see PR #1128 — this exact value was
    // verified NOT to change recall vs. the harness's old hardcoded 512, but
    // it removes the truncation as a confound; keep it at the model's real max).
    public static let defaultMaxLength = 8192

    public var modelConfiguration: ModelConfiguration {
        modelRepo == "BAAI/bge-m3" ? .bge_m3 : .init(id: modelRepo)
    }
}
