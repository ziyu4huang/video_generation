// swift-tools-version: 6.0
//
// musicgen-director — Pure-Swift MLX port of Meta's MusicGen (facebook/
// musicgen-small: T5-base text encoder + 24-layer causal/cross-attention LM
// decoder + EnCodec 32kHz audio codec, decode-only). Replaces the
// `run.py music` -> mlx_audiocraft Python bridge (musicgen_music provider,
// registry.ts:352) — see docs/superpowers/specs/2026-07-28-musicgen-swift-
// native-port-design.md.
//
// Text encoder reuses flux2-image-director's KontextT5Encoder skeleton
// (relative-position-bias attention + RMSNorm), re-parameterized for
// t5-base's smaller config and plain (non-gated) FFN. Also reuses
// flux2-image-director's KontextT5Tokenizer (a generic, data-driven T5
// SentencePiece Unigram tokenizer — despite the "Kontext" name it loads any
// T5 tokenizer.json, no Kontext-specific coupling). The LM decoder is a
// genuine from-scratch port (no prior MLX-Swift implementation exists
// anywhere) modeled structurally on ltx-video-director's WhisperDecoder.swift
// (causal self-attn + cross-attn to encoder output).

import PackageDescription

let package = Package(
    name: "musicgen-director",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "musicgen", targets: ["MusicGenDirectorCLI"]),
        .executable(name: "kokoro-tts", targets: ["KokoroTTSCLI"]),
        .library(name: "MusicGenDirector", targets: ["MusicGenDirector"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
        // MLXAudioCodecs product only (not the TTS/STT/VAD products) — its
        // Encodec implementation is fully config-driven (verified by reading
        // EncodecConfig.swift/Encodec.swift/EncodecQuantization.swift, not
        // just its README), and its residual-vector-quantizer math derives
        // numQuantizers=4 automatically from our real config numbers
        // (targetBandwidths=[2.2], frameRate=50 -> floor(2200/(50*10))=4).
        .package(url: "https://github.com/Blaizzy/mlx-audio-swift.git", exact: "0.1.3"),
        // KontextT5Encoder + KontextT5Tokenizer reuse (see header comment).
        .package(path: "../flux2-image-director"),
    ],
    targets: [
        .target(
            name: "MusicGenDirector",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
                .product(name: "MLXRandom", package: "mlx-swift"),
                .product(name: "MLXAudioCodecs", package: "mlx-audio-swift"),
                .product(name: "Flux2Director", package: "flux2-image-director"),
            ],
            path: "Sources/MusicGenDirector"
        ),
        .executableTarget(
            name: "MusicGenDirectorCLI",
            dependencies: [
                "MusicGenDirector",
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/MusicGenDirectorCLI"
        ),
        .executableTarget(
            name: "KokoroTTSCLI",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/KokoroTTSCLI"
        ),
        .testTarget(
            name: "MusicGenDirectorTests",
            dependencies: ["MusicGenDirector"],
            path: "Tests/MusicGenDirectorTests"
        ),
        .testTarget(
            name: "KokoroTTSCLITests",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
            ],
            path: "Tests/KokoroTTSCLITests"
        ),
    ]
)
