// swift-tools-version: 6.0
//
// common-image-director — shared infrastructure for the image-director Swift apps.
//
// Holds the model-AGNOSTIC plumbing reused across z-image-director and
// flux2-image-director: manifest/audit trail, run-config persistence, output
// path resolution, the shared models-tree locator (ModelPaths), the
// FlowMatch-Euler scheduler (used by BOTH Z-Image and Flux2 Klein — both are
// rectified-flow models), PNG save, quality metrics, and resolution presets.
//
// Model-SPECIFIC code (transformer architectures, VAE per architecture, LoRA
// loading, controlnet) lives in each app's own package, NOT here.

import PackageDescription

let package = Package(
    name: "common-image-director",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "CommonImageDirector", targets: ["CommonImageDirector"]),
    ],
    dependencies: [
        // Apple MLX Swift bindings — array framework + Metal acceleration.
        // Pinned to the SAME version z-image-director uses, so both apps share
        // one resolved dependency set (no duplicate mlx-swift in the graph).
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
    ],
    targets: [
        .target(
            name: "CommonImageDirector",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
            ],
            path: "Sources/CommonImageDirector"
        ),
    ]
)
