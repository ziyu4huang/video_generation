// swift-tools-version: 6.0
//
// flux2-image-director — Pure-Swift MLX port of Flux2 Klein 9B + SAM3.1.
//
// Sibling to z-image-director. Shares all model-AGNOSTIC infrastructure
// (manifest, run-config, output paths, FlowMatch-Euler scheduler, image save,
// quality metrics, resolution presets) via the common-image-director package.
// Owns the Flux2-SPECIFIC code: the MMDiT transformer (8 double + 24 single
// blocks), the Flux2 VAE, qwen3-8b text encoder wiring, Flux2KleinEdit
// reference conditioning, and the SAM3.1 segmenter.
//
// Porting strategy: FULL NATIVE SWIFT (no Python subprocess). Each component
// is verified numerically against mflux / mlx-vlm (cos>0.99 / IoU>0.9) before
// the next is begun — the same methodology that made the ZImage port succeed.

import PackageDescription

let package = Package(
    name: "flux2-image-director",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "flux2", targets: ["Flux2DirectorCLI"]),
        .library(name: "Flux2Director", targets: ["Flux2Director"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
        .package(path: "../image-gen-utils"),
        // Shared infra: Manifest/RunConfig/OutputPaths/ModelPaths/
        // FlowMatchEulerScheduler/ImageSave/QualityMetrics/Resolution.
        .package(path: "../common-image-director"),
        // Kontext epic phase 4: reuses ZImageVAEEncoder/ZImageVAEDecoder as-is
        // for the Kontext VAE — the two configs are byte-identical (both trace
        // back to FLUX.1-dev's VAE), see convert_kontext_vae_to_mlx() in
        // python/mlx-movie-director/convert.py for the weight-conversion side.
        .package(path: "../z-image-director"),
    ],
    targets: [
        .executableTarget(
            name: "Flux2DirectorCLI",
            dependencies: [
                "Flux2Director",
                .product(name: "CommonImageDirector", package: "common-image-director"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/Flux2DirectorCLI"
        ),
        .target(
            name: "Flux2Director",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXRandom", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "CommonImageDirector", package: "common-image-director"),
                .product(name: "ZImageDirector", package: "z-image-director"),
            ],
            path: "Sources/Flux2Director"
        ),
        .testTarget(
            name: "Flux2DirectorTests",
            dependencies: [
                "Flux2Director",
                .product(name: "CommonImageDirector", package: "common-image-director"),
            ],
            path: "Tests/Flux2DirectorTests"
        ),
    ]
)
