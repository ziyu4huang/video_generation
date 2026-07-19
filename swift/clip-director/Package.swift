// swift-tools-version: 6.0
//
// clip-director — Pure-Swift MLX port of openai/clip-vit-base-patch32 for the
// movie-director ext's `analysis:video_understand` capability. Scores frames
// against a text prompt via CLIP cosine similarity, replacing the former
// python `clip_understand.py` (transformers + torch MPS).

import PackageDescription

let package = Package(
    name: "clip-director",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "clip", targets: ["ClipDirectorCLI"]),
        .library(name: "ClipDirector", targets: ["ClipDirector"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "ClipDirectorCLI",
            dependencies: ["ClipDirector", .product(name: "ArgumentParser", package: "swift-argument-parser")],
            path: "Sources/ClipDirectorCLI"
        ),
        .target(
            name: "ClipDirector",
            dependencies: [.product(name: "MLX", package: "mlx-swift"), .product(name: "MLXNN", package: "mlx-swift"), .product(name: "MLXFast", package: "mlx-swift")],
            path: "Sources/ClipDirector",
            resources: [.copy("Resources/vocab.json"), .copy("Resources/merges.txt")]
        ),
        .testTarget(
            name: "ClipDirectorTests",
            dependencies: ["ClipDirector"],
            path: "Tests/ClipDirectorTests"
        ),
    ]
)
