// swift-tools-version: 6.0
//
// ltx-video-director — Swift front-end for LTX-2.3 I2V generation on Apple
// Silicon, plus a native (Python-free) video/image/voice quality gateway.
//
// Porting strategy (see PLAN.md): Phase 0 bridges the actual LTX-2.3
// transformer denoising to the already-verified `python/mlx-movie-director`
// engine (Process subprocess) so the CLI is useful immediately and reuses
// the already-converted mlx-models/ltx-mlx/{dev,distilled,dasiwa}
// checkpoints without re-deriving them. Phases 1+ replace the bridge with a
// native MLX Swift transformer + VAE port, verified against the Python
// reference at each step — the same methodology that shipped
// z-image-director and flux2-image-director. Everything OTHER than the
// denoising loop (config, model discovery, the quality gateway, VLM
// keyframe verification, upscaling) is native Swift from day one.

import PackageDescription

let package = Package(
    name: "ltx-video-director",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "ltx-video", targets: ["LTXVideoDirectorCLI"]),
        .library(name: "LTXVideoDirector", targets: ["LTXVideoDirector"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
        .package(path: "../image-gen-utils"),
        .package(path: "../common-image-director"),
        // Linked so the T2I half of the t2i2v pipeline can run through
        // ZImageDirector's already-native (Qwen3 text encoder + transformer +
        // VAE, zero Python) T2IPipeline in-process instead of shelling out to
        // `run.py image t2i` — see NativeT2IStage.swift / PLAN.md.
        .package(path: "../z-image-director"),
    ],
    targets: [
        .target(
            name: "LTXVideoDirector",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "CommonImageDirector", package: "common-image-director"),
                .product(name: "ZImageDirector", package: "z-image-director"),
            ],
            path: "Sources/LTXVideoDirector"
        ),
        .executableTarget(
            name: "LTXVideoDirectorCLI",
            dependencies: [
                "LTXVideoDirector",
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "CommonImageDirector", package: "common-image-director"),
                .product(name: "ZImageDirector", package: "z-image-director"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/LTXVideoDirectorCLI"
        ),
        .testTarget(
            name: "LTXVideoDirectorTests",
            dependencies: ["LTXVideoDirector"],
            path: "Tests/LTXVideoDirectorTests"
        ),
    ]
)
