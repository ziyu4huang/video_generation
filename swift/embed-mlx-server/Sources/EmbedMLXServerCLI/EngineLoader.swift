import EmbedMLXServer
import Foundation

/// The one place a model repo becomes a ready-to-use `EmbeddingEngine`.
///
/// Both subcommands go through it deliberately. `self-test`'s entire purpose
/// is to validate what `serve` actually runs, so if the two load paths ever
/// drift, the self-test keeps passing while silently checking a different
/// configuration than the one in production.
///
/// Lives in the CLI target rather than the library: unbuffering stdout and
/// the `[embed-mlx-server <cmd>]` log prefix are presentation concerns, and
/// the library deliberately keeps I/O policy out of its surface.
enum EngineLoader {
    static func load(config: ServerConfig, commandName: String) async throws -> EmbeddingEngine {
        setbuf(stdout, nil)
        print("[embed-mlx-server \(commandName)] loading \(config.modelRepo)...")
        let backend = try await MLXEmbeddingBackend.load(
            repo: config.modelRepo, maxLength: config.maxLength)
        return EmbeddingEngine(backend: backend, microBatchSize: config.microBatchSize)
    }
}
