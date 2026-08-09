import ArgumentParser

// AsyncParsableCommand, not ParsableCommand: the `Serve` subcommand's `run()`
// is async, and swift-argument-parser requires the root command to be async
// too in that case (a synchronous root never calls an async subcommand's
// `run()` — it errors at runtime instead). See swift-argument-parser's
// "Asynchronous subcommand of a synchronous root" diagnostic.
@main
struct EmbedMLXServerCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "embed-mlx-server",
        abstract: "OpenAI-compatible /v1/embeddings server over BGE-M3 (native MLX).",
        version: "0.1.0",
        subcommands: [Serve.self, SelfTestCommand.self]
    )
}
