// swift-tools-version: 6.0
//
// vision-ocr-cli — one-shot macOS Vision OCR bridge (ticket 07 #4/#5).
// Usage: vision-ocr-cli <image-path>   (path may also arrive on stdin)
// stdout (exit 0): {"text":"…","width":1024,"height":768,"format":"png"}
// Errors: exit 1 + message on stderr. Zero external dependencies — Vision,
// CoreGraphics and ImageIO are macOS system frameworks. Deliberately a
// standalone CLI: embed-mlx-server stays single-purpose (NOT touched).
import PackageDescription

let package = Package(
    name: "vision-ocr-cli",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "vision-ocr-cli", targets: ["VisionOCRCli"])
    ],
    targets: [
        .executableTarget(
            name: "VisionOCRCli",
            path: "Sources/VisionOCRCli",
            linkerSettings: [
                .linkedFramework("Vision"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
            ]
        )
    ]
)
