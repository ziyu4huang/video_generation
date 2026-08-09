import ArgumentParser
import EmbedMLXServer
import Foundation

extension EmbedMLXServerCLI {
    struct SelfTestCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "self-test",
            abstract: "Boot the real model in-process and sanity-check embedding quality."
        )

        @Option(help: "HuggingFace repo id of the embedding model.")
        var model: String = ServerConfig.defaultModelRepo

        @Option(name: .customLong("max-length"), help: "Max tokens per input before truncation.")
        var maxLength: Int = ServerConfig.defaultMaxLength

        func run() async throws {
            setbuf(stdout, nil)
            let config = ServerConfig(
                port: ServerConfig.defaultPort, modelRepo: model,
                microBatchSize: ServerConfig.defaultMicroBatchSize, maxLength: maxLength)

            print("[embed-mlx-server self-test] loading \(config.modelRepo)...")
            let backend = try await MLXEmbeddingBackend.load(
                configuration: config.modelConfiguration, maxLength: config.maxLength)
            let engine = EmbeddingEngine(backend: backend, microBatchSize: config.microBatchSize)

            let results = try await SelfTest.run(engine: engine)

            var allPassed = true
            for result in results {
                let status = result.passed ? "PASS" : "FAIL"
                print(
                    "[\(status)] \(result.label): near=\(result.nearSimilarity) far=\(result.farSimilarity)")
                if !result.passed { allPassed = false }
            }

            if !allPassed {
                print("[embed-mlx-server self-test] FAILED")
                throw ExitCode.failure
            }
            print("[embed-mlx-server self-test] all cases passed")
        }
    }
}
