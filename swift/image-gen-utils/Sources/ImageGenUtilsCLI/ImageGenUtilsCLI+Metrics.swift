import ArgumentParser
import Foundation
import ImageGenUtils

extension ImageGenUtilsCLI {
    struct Metrics: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "metrics",
            abstract: "Compute SSIM, PSNR, and MSE between two images."
        )

        @Argument(help: "Path to the first image.")
        var image1: String

        @Argument(help: "Path to the second image.")
        var image2: String

        @Option(help: "Width to scale images to before comparison (default: 512).")
        var width: Int = 512

        @Option(help: "Height to scale images to before comparison (default: 512).")
        var height: Int = 512

        @Option(help: "Output path for JSON results (default: stdout).")
        var output: String?

        func run() throws {
            let url1 = URL(fileURLWithPath: image1)
            let url2 = URL(fileURLWithPath: image2)

            guard FileManager.default.fileExists(atPath: url1.path),
                  FileManager.default.fileExists(atPath: url2.path) else {
                throw ValidationError("One or both image files do not exist.")
            }

            print("Calculating metrics for:")
            print("  1: \(image1)")
            print("  2: \(image2)")

            let buf1 = try ImageProcessor.extractGrayscaleBuffer(url: url1, targetWidth: width, targetHeight: height)
            let buf2 = try ImageProcessor.extractGrayscaleBuffer(url: url2, targetWidth: width, targetHeight: height)

            let result = ImageMetrics.compute(buffer1: buf1, buffer2: buf2, width: width, height: height)

            let json: [String: Any] = [
                "mse": result.mse,
                "psnr": result.psnr,
                "ssim": result.ssim
            ]
            let data = try JSONSerialization.data(withJSONObject: json, options: .prettyPrinted)
            let jsonString = String(data: data, encoding: .utf8) ?? "{}"

            if let outputPath = output {
                try jsonString.write(toFile: outputPath, atomically: true, encoding: .utf8)
                print("Saved JSON to \(outputPath)")
            } else {
                print("\nResults (JSON):")
                print(jsonString)
            }
        }
    }
}
