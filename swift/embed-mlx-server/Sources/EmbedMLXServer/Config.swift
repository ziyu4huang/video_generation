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
    // NOT "BAAI/bge-m3" (MLXEmbedders' own pre-registered `.bge_m3` default):
    // that repo only ships `pytorch_model.bin`, no `.safetensors`, and this
    // library only downloads/loads safetensors — loading it fails with
    // "Key ... not found" because no weights were ever fetched. This is the
    // same MLX-converted repo the Python Phase 0 harness (PR #1128) already
    // validated (models.json's mlx_hf_repo), confirmed independently here by
    // checking its file listing has real model.safetensors + quantization
    // metadata this loader's quantize() path is built to consume.
    public static let defaultModelRepo = "mlx-community/bge-m3-mlx-8bit"
    public static let defaultMicroBatchSize = 32
    // BGE-M3's real context window (see PR #1128 — this exact value was
    // verified NOT to change recall vs. the harness's old hardcoded 512, but
    // it removes the truncation as a confound; keep it at the model's real max).
    public static let defaultMaxLength = 8192

    public var modelConfiguration: ModelConfiguration {
        .init(id: modelRepo)
    }
}
