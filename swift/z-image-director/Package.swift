// swift-tools-version: 6.0
//
// ZImageDirector — Pure-Swift MLX port of run.py's Z-Image T2I pipeline.
//
// Initial scope: text-to-image generation using the Z-Image (6B S3-DiT) model,
// reusing the MLX weights already converted under
// python/mlx-movie-director/models/transformer/*.

import PackageDescription

let package = Package(
    name: "z-image-director",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "zimage", targets: ["ZImageDirectorCLI"]),
        .library(name: "ZImageDirector", targets: ["ZImageDirector"]),
    ],
    dependencies: [
        // Apple MLX Swift bindings — array framework + Metal acceleration.
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        // Argument parsing for the CLI (mirrors run.py argparse surface).
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
        // Shared LM-Studio VLM caption/score utilities (sibling package).
        // Extracted so the future flux2-image-director reuses the same client.
        .package(path: "../image-gen-utils"),
        // Shared model-AGNOSTIC infra (Manifest, RunConfig, OutputPaths,
        // ModelPaths, FlowMatchEuler scheduler, ImageSave, QualityMetrics).
        // Both z-image-director and flux2-image-director depend on this so the
        // manifest/audit/plumbing is identical across apps.
        .package(path: "../common-image-director"),
        // NOTE: Phase 1 will add `swift-huggingface` (Hub, for HF downloads) and
        // a safetensors reader. Phase 4 will add PNG/image writing. Kept out of
        // the Phase 0 scaffold to keep the dependency closure minimal.
    ],
    targets: [
        .executableTarget(
            name: "ZImageDirectorCLI",
            dependencies: [
                "ZImageDirector",
                .product(name: "CommonImageDirector", package: "common-image-director"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/ZImageDirectorCLI"
        ),
        .target(
            name: "ZImageDirector",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXRandom", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "CommonImageDirector", package: "common-image-director"),
            ],
            path: "Sources/ZImageDirector"
        ),
        .testTarget(
            name: "ZImageDirectorTests",
            dependencies: [
                "ZImageDirector",
                .product(name: "CommonImageDirector", package: "common-image-director"),
            ],
            path: "Tests/ZImageDirectorTests"
        ),
    ]
)
