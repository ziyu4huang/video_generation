// swift-tools-version: 6.0
//
// image-gen-utils — shared utilities for Swift image-generation directors.
//
// Extracted from z-image-director so that the LM-Studio VLM caption/score/review
// integration is reusable by any image-gen tool (z-image-director today,
// flux2-image-director next, others later). Pure Foundation + CoreGraphics —
// NO MLX dependency, so it builds fast and imports cheaply.
//
// Mirrors the user-facing surface of `python/mlx-movie-director run.py caption`
// (styles: default | photography | t2i | score | review) on top of a local
// OpenAI-compatible vision API (LM Studio, Qwen3-VL / Gemma-4).

import PackageDescription

let package = Package(
    name: "image-gen-utils",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "ImageGenUtils", targets: ["ImageGenUtils"]),
        .executable(name: "image-gen-utils", targets: ["ImageGenUtilsCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
    ],
    targets: [
        .target(
            name: "ImageGenUtils",
            dependencies: [],
            path: "Sources/ImageGenUtils"
        ),
        .executableTarget(
            name: "ImageGenUtilsCLI",
            dependencies: [
                "ImageGenUtils",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/ImageGenUtilsCLI"
        ),
        .testTarget(
            name: "ImageGenUtilsTests",
            dependencies: ["ImageGenUtils"],
            path: "Tests/ImageGenUtilsTests"
        ),
    ]
)
