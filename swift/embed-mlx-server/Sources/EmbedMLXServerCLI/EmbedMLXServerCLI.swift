import ArgumentParser

@main
struct EmbedMLXServerCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "embed-mlx-server",
        abstract: "OpenAI-compatible /v1/embeddings server over BGE-M3 (native MLX).",
        version: "0.1.0",
        subcommands: []
    )
}
