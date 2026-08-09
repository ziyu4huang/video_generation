// swift-tools-version: 6.0
//
// embed-mlx-server — self-built Swift MLX OpenAI-compatible embedding server
// (BGE-M3 via mlx-swift-lm's MLXEmbedders), deployed as a macOS launchd
// background service. See docs/superpowers/specs/2026-08-09-embed-mlx-server-design.md
// for the full design, and the Phase 0 benchmark (PR #1128) that motivated it.
//
// Pinned to mlx-swift-lm 2.31.3, NOT the latest 3.x line: 3.x introduced a
// breaking Downloader/TokenizerLoader protocol refactor whose HuggingFace-backed
// concrete implementations are not present in the tagged 3.31.4 source tree.
// 2.31.3's `loadModelContainer(configuration:)` is the last verified-working,
// self-contained convenience API — do not bump this without re-verifying
// against the target tag's actual source, not just its README.

import PackageDescription

let package = Package(
    name: "embed-mlx-server",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "embed-mlx-server", targets: ["EmbedMLXServerCLI"]),
        .library(name: "EmbedMLXServer", targets: ["EmbedMLXServer"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        .package(url: "https://github.com/ml-explore/mlx-swift-lm.git", exact: "2.31.3"),
        .package(url: "https://github.com/huggingface/swift-transformers", .upToNextMinor(from: "1.2.0")),
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", exact: "2.26.0"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
    ],
    targets: [
        .target(
            name: "EmbedMLXServer",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXEmbedders", package: "mlx-swift-lm"),
                .product(name: "Transformers", package: "swift-transformers"),
                .product(name: "Hummingbird", package: "hummingbird"),
            ],
            path: "Sources/EmbedMLXServer"
        ),
        .executableTarget(
            name: "EmbedMLXServerCLI",
            dependencies: [
                "EmbedMLXServer",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/EmbedMLXServerCLI"
        ),
        .testTarget(
            name: "EmbedMLXServerTests",
            dependencies: [
                "EmbedMLXServer",
                .product(name: "HummingbirdTesting", package: "hummingbird"),
            ],
            path: "Tests/EmbedMLXServerTests"
        ),
    ]
)
