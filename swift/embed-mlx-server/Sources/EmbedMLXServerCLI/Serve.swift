import ArgumentParser
import EmbedMLXServer

extension EmbedMLXServerCLI {
    struct Serve: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "serve",
            abstract: "Start the OpenAI-compatible /v1/embeddings HTTP server."
        )

        @Option(help: "Port to listen on.")
        var port: Int = ServerConfig.defaultPort

        @Option(help: "HuggingFace repo id of the embedding model.")
        var model: String = ServerConfig.defaultModelRepo

        @Option(name: .customLong("micro-batch-size"), help: "Max texts embedded per MLX forward pass.")
        var microBatchSize: Int = ServerConfig.defaultMicroBatchSize

        @Option(name: .customLong("max-length"), help: "Max tokens per input before truncation.")
        var maxLength: Int = ServerConfig.defaultMaxLength

        // Every numeric flag is validated here, not just --port. Without this,
        // bad values crash instead of erroring: --micro-batch-size 0 trips
        // EmbeddingEngine's precondition (which is live in release builds, so
        // it's a hard crash), and --max-length 0 produces a zero-width forward
        // pass into MLX. Under the launchd plist's KeepAlive:true, a
        // crash-at-startup becomes a respawn loop into an unrotated log.
        // Port floor is 1, not 0: port 0 binds an arbitrary ephemeral port and
        // then logs the misleading "listening on 127.0.0.1:0".
        mutating func validate() throws {
            guard (1...65535).contains(port) else {
                throw ValidationError("--port must be between 1 and 65535, got \(port).")
            }
            guard microBatchSize > 0 else {
                throw ValidationError("--micro-batch-size must be positive, got \(microBatchSize).")
            }
            guard maxLength > 0 else {
                throw ValidationError("--max-length must be positive, got \(maxLength).")
            }
        }

        func run() async throws {
            let config = ServerConfig(
                port: port, modelRepo: model, microBatchSize: microBatchSize, maxLength: maxLength)

            let engine = try await EngineLoader.load(config: config, commandName: "serve")
            let server = HTTPServer(engine: engine, modelName: config.modelRepo)

            try await server.run(port: config.port) {
                print("[embed-mlx-server serve] listening on 127.0.0.1:\(config.port)")
            }
        }
    }
}
