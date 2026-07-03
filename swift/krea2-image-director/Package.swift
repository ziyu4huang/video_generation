// swift-tools-version: 6.0
//
// krea2-image-director — Swift front-end for Krea 2 Turbo T2I/I2I on Apple
// Silicon. Mirrors swift/ltx-video-director's methodology: Phase 0 bridges to
// the already-verified python/mlx-movie-director engine (which is parity-
// validated end-to-end) so the CLI is useful immediately; Phases 1+ replace
// the bridge with a native MLX Swift DiT + VAE + Qwen3 encoder port, verified
// against the Python reference component-by-component (the same methodology
// that shipped z-image-director / flux2-image-director / ltx-video-director).
//
// See PLAN.md for the port log. Krea 2 architecture (single-stream MMDiT,
// 28 blocks x 6144 dim, Qwen3-VL text path, qwen_image_vae) is fully ported
// and parity-validated in python/mlx-movie-director/app/krea2_*.py.

import PackageDescription

let package = Package(
    name: "krea2-image-director",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "krea2", targets: ["Krea2ImageDirectorCLI"]),
        .library(name: "Krea2ImageDirector", targets: ["Krea2ImageDirector"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
        .package(path: "../image-gen-utils"),
        .package(path: "../common-image-director"),
        // Qwen3 text-encoder + WeightStore are already native in z-image-director;
        // the native Krea2 port reuses them (Qwen3MultiLayer tap is the only new
        // text-encoder piece). Linked from day one.
        .package(path: "../z-image-director"),
    ],
    targets: [
        .target(
            name: "Krea2ImageDirector",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "CommonImageDirector", package: "common-image-director"),
                .product(name: "ZImageDirector", package: "z-image-director"),
            ],
            path: "Sources/Krea2ImageDirector"
        ),
        .executableTarget(
            name: "Krea2ImageDirectorCLI",
            dependencies: [
                "Krea2ImageDirector",
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "CommonImageDirector", package: "common-image-director"),
                .product(name: "ZImageDirector", package: "z-image-director"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/Krea2ImageDirectorCLI"
        ),
        .testTarget(
            name: "Krea2ImageDirectorTests",
            dependencies: ["Krea2ImageDirector"],
            path: "Tests/Krea2ImageDirectorTests"
        ),
    ]
)
