import ArgumentParser
import EmbedMLXServer
import Foundation

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

        mutating func validate() throws {
            guard (0...65535).contains(port) else {
                throw ValidationError("--port must be between 0 and 65535, got \(port).")
            }
        }

        func run() async throws {
            setbuf(stdout, nil)
            let config = ServerConfig(
                port: port, modelRepo: model, microBatchSize: microBatchSize, maxLength: maxLength)

            print("[embed-mlx-server serve] loading \(config.modelRepo)...")
            let backend = try await MLXEmbeddingBackend.load(
                configuration: config.modelConfiguration, maxLength: config.maxLength)
            let engine = EmbeddingEngine(backend: backend, microBatchSize: config.microBatchSize)
            let server = HTTPServer(engine: engine, modelName: config.modelRepo)

            try await server.run(port: config.port) {
                print("[embed-mlx-server serve] listening on 127.0.0.1:\(config.port)")
            }
        }
    }
}
