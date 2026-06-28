import Foundation
import Accelerate
import CoreImage
import CoreGraphics

public struct ImageMetrics {
    public struct Result {
        public let mse: Float
        public let psnr: Float
        public let ssim: Float
    }

    /// Computes MSE, PSNR, and SSIM between two grayscale Float32 buffers.
    public static func compute(buffer1: [Float32], buffer2: [Float32], width: Int, height: Int) -> Result {
        let count = width * height
        guard count > 0 else {
            return Result(mse: 0, psnr: 0, ssim: 0)
        }

        // 1. MSE (Mean Squared Error)
        var sumSq: Float = 0
        vDSP_svesq(buffer1, 1, &sumSq, vDSP_Length(count))
        var mse: Float = sumSq / Float(count)
        if !mse.isFinite { mse = 0 }

        // 2. PSNR (Peak Signal-to-Noise Ratio)
        let psnr: Float = mse == 0 ? 99.0 : 20 * log10(1.0 / sqrt(mse))

        // 3. SSIM (Global statistics implementation)
        let ssimVal = calculateSSIM(buffer1: buffer1, buffer2: buffer2, count: count)

        return Result(mse: mse, psnr: psnr, ssim: ssimVal)
    }

    private static func calculateSSIM(buffer1: [Float32], buffer2: [Float32], count: Int) -> Float {
        var mean1: Float = 0
        var mean2: Float = 0
        vDSP_meanv(buffer1, 1, &mean1, vDSP_Length(count))
        vDSP_meanv(buffer2, 1, &mean2, vDSP_Length(count))

        var var1: Float = 0
        var var2: Float = 0
        // vDSP_normalize returns standard deviation in the 4th arg
        vDSP_normalize(buffer1, 1, nil, 1, &var1, &mean1, vDSP_Length(count))
        vDSP_normalize(buffer2, 1, nil, 1, &var2, &mean2, vDSP_Length(count))

        let K1: Float = 0.01
        let K2: Float = 0.03
        let L: Float = 1.0 // Buffers are normalized 0.0 to 1.0
        let C1 = pow(K1 * L, 2)
        let C2 = pow(K2 * L, 2)

        let numerator = (2 * mean1 * mean2 + C1) * (2 * sqrt(var1) * sqrt(var2) + C2)
        let denominator = (pow(mean1, 2) + pow(mean2, 2) + C1) * (var1 + var2 + C2)

        return numerator / denominator
    }
}

/// Helper to load images and extract Float32 grayscale buffers for metrics.
public enum ImageProcessor {
    public static func extractGrayscaleBuffer(url: URL, targetWidth: Int, targetHeight: Int) throws -> [Float32] {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw NSError(domain: "ImageProcessor", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to load image"])
        }

        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let context = CGContext(data: nil,
                                      width: targetWidth,
                                      height: targetHeight,
                                      bitsPerComponent: 8,
                                      bytesPerRow: targetWidth,
                                      space: colorSpace,
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
            throw NSError(domain: "ImageProcessor", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create CGContext"])
        }
        
        context.interpolationQuality = .high
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        
        guard let dataPtr = context.data else {
            throw NSError(domain: "ImageProcessor", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to get context data"])
        }
        
        let uint8Buffer = dataPtr.bindMemory(to: UInt8.self, capacity: targetWidth * targetHeight)
        
        var floatBuffer = [Float32](repeating: 0, count: targetWidth * targetHeight)
        vDSP_vfltu8(uint8Buffer, 1, &floatBuffer, 1, vDSP_Length(targetWidth * targetHeight))
        
        var divisor: Float = 255.0
        vDSP_vsdiv(floatBuffer, 1, &divisor, &floatBuffer, 1, vDSP_Length(floatBuffer.count))
        
        return floatBuffer
    }
}
