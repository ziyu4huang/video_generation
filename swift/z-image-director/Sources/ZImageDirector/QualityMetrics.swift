//
//  QualityMetrics.swift
//  ZImageDirector
//
//  7 no-reference image quality metrics, ported from Python quality_metrics.py.
//  Pure Swift + Accelerate (no OpenCV). Operates on an MLXArray (1,3,H,W) float32 [0,1].
//

import Foundation
import MLX
import Accelerate

/// 7 no-reference image quality metrics, mirroring run.py's `analyze_frame`.
/// All values are computed on float64 grayscale (luminance) unless noted.
public struct QualityMetrics: Codable, Equatable {

    /// Laplacian variance — total high-frequency energy (higher = sharper OR noisier).
    public let sharpness: Double
    /// Sobel gradient-magnitude mean — edge presence (higher = more edges).
    public let edgeDensity: Double
    /// Grayscale standard deviation — dynamic range (higher = more contrast).
    public let contrast: Double
    /// MAD-based noise estimate (lower = cleaner).
    public let noiseSigma: Double
    /// Signal-to-noise ratio in dB (higher = cleaner relative to signal).
    public let snrDb: Double
    /// 8×8 JPEG-style block-boundary artifact strength (lower = cleaner).
    public let blockiness: Double
    /// Std of HSV saturation channel (higher = more color variation).
    public let saturationStd: Double

    /// JSON-friendly dictionary (all keys match run.py metric names exactly).
    public var dictionary: [String: Double] {
        [
            "sharpness": sharpness,
            "edge_density": edgeDensity,
            "contrast": contrast,
            "noise_sigma": noiseSigma,
            "snr_db": snrDb,
            "blockiness": blockiness,
            "saturation_std": saturationStd,
        ]
    }

    /// Compute all 7 metrics on an MLXArray of shape (1, 3, H, W) in [0, 1].
    public static func analyze(_ image: MLXArray) -> QualityMetrics {
        let dims = image.shape
        precondition(dims.count == 4 && dims[0] == 1 && dims[1] == 3,
                     "expected (1, 3, H, W), got \(dims)")
        let height = dims[2]
        let width = dims[3]

        let flat = image.reshaped([3, height, width]).asType(.float32)
        MLX.eval(flat)
        let redArr = flat[0].asArray(Float.self)
        let greenArr = flat[1].asArray(Float.self)
        let blueArr = flat[2].asArray(Float.self)

        // Luminance (Rec.601, matches cv2.cvtColor BGR2GRAY weights): 0.299R+0.587G+0.114B.
        let count = width * height
        var gray = [Double](repeating: 0, count: count)
        var saturation = [Double](repeating: 0, count: count)  // OpenCV uint8 HSV S / 255
        for idx in 0..<count {
            let red = Double(redArr[idx])
            let green = Double(greenArr[idx])
            let blue = Double(blueArr[idx])
            gray[idx] = 0.299 * red + 0.587 * green + 0.114 * blue

            // OpenCV HSV saturation: (max-min)/max, 0 when max==0.
            let channelMax = max(red, max(green, blue))
            let channelMin = min(red, min(green, blue))
            saturation[idx] = channelMax > 0
                ? (channelMax - channelMin) / channelMax
                : 0.0
        }

        // 1. Sharpness — Laplacian variance (kernel: center -4, 4-neighbors +1).
        let laplacian = convolve3x3(gray, width: width, height: height,
                                    kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0])
        let sharpness = variance(laplacian)

        // 2. Edge density — mean of sqrt(sobelX^2 + sobelY^2).
        let sobelX = convolve3x3(gray, width: width, height: height,
                                 kernel: [-1, 0, 1, -2, 0, 2, -1, 0, 1])
        let sobelY = convolve3x3(gray, width: width, height: height,
                                 kernel: [-1, -2, -1, 0, 0, 0, 1, 2, 1])
        let edgeDensity = meanGradientMagnitude(gradientX: sobelX, gradientY: sobelY)

        // 3. Contrast — grayscale std.
        let contrast = std(gray)

        // 4. Noise — MAD-based sigma: median(|lap - median(lap)|) * 1.4826.
        let lapMedian = median(laplacian)
        let absDevs = laplacian.map { abs($0 - lapMedian) }
        let noiseSigma = median(absDevs) * 1.4826

        // 5. SNR (dB).
        let signalMean = mean(gray)
        let noiseEst = noiseSigma > 0 ? noiseSigma : 0.01
        let snrDb = signalMean > 0 ? 20.0 * log10(signalMean / noiseEst) : 0.0

        // 6. Blockiness — 8×8 boundary differences.
        let blockiness = computeBlockiness(gray, width: width, height: height)

        // 7. Saturation std.
        let saturationStd = std(saturation)

        return QualityMetrics(
            sharpness: sharpness, edgeDensity: edgeDensity, contrast: contrast,
            noiseSigma: noiseSigma, snrDb: snrDb, blockiness: blockiness,
            saturationStd: saturationStd
        )
    }

    // MARK: - Convolution (zero-padded borders)

    /// 3×3 convolution with zero-padding, matching OpenCV BORDER_CONSTANT==0 semantics
    /// closely enough for relative metric comparison. Kernel is row-major [k00,k01,...,k22].
    private static func convolve3x3(
        _ src: [Double], width: Int, height: Int, kernel: [Double]
    ) -> [Double] {
        var dst = [Double](repeating: 0, count: src.count)
        for rowY in 0..<height {
            for colX in 0..<width {
                var sum = 0.0
                for ky in -1...1 {
                    for kx in -1...1 {
                        let srcY = rowY + ky
                        let srcX = colX + kx
                        guard srcY >= 0, srcY < height, srcX >= 0, srcX < width else { continue }
                        let kernelIdx = (ky + 1) * 3 + (kx + 1)
                        sum += src[srcY * width + srcX] * kernel[kernelIdx]
                    }
                }
                dst[rowY * width + colX] = sum
            }
        }
        return dst
    }

    // MARK: - Statistics (Accelerate vDSP)

    private static func mean(_ values: [Double]) -> Double {
        vDSP.mean(values)
    }

    private static func variance(_ values: [Double]) -> Double {
        let avg = mean(values)
        let squaredDiffs = values.map { ($0 - avg) * ($0 - avg) }
        return vDSP.sum(squaredDiffs) / Double(values.count)
    }

    private static func std(_ values: [Double]) -> Double {
        sqrt(variance(values))
    }

    private static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        return sorted.count.isMultiple(of: 2)
            ? (sorted[mid - 1] + sorted[mid]) / 2.0
            : sorted[mid]
    }

    private static func meanGradientMagnitude(gradientX: [Double], gradientY: [Double]) -> Double {
        var accum = 0.0
        for idx in 0..<gradientX.count {
            accum += (gradientX[idx] * gradientX[idx] + gradientY[idx] * gradientY[idx]).squareRoot()
        }
        return accum / Double(gradientX.count)
    }

    // MARK: - Blockiness

    /// Sum of horizontal + vertical 8×8 block-boundary differences (JPEG artifact probe).
    private static func computeBlockiness(
        _ gray: [Double], width: Int, height: Int
    ) -> Double {
        let heightAligned = (height / 8) * 8
        let widthAligned = (width / 8) * 8
        guard heightAligned >= 16, widthAligned >= 16 else { return 0 }

        // Vertical boundaries: compare col (b*8 - 1) vs (b*8) within each block row.
        var verticalDiffSum = 0.0
        var verticalPairs = 0
        for blockRow in 0..<(heightAligned / 8) {
            for rowWithin in 0..<8 {
                let rowY = blockRow * 8 + rowWithin
                for blockCol in 1..<(widthAligned / 8) {
                    let leftCol = blockCol * 8 - 1
                    let rightCol = blockCol * 8
                    verticalDiffSum += abs(
                        gray[rowY * width + leftCol] - gray[rowY * width + rightCol]
                    )
                    verticalPairs += 1
                }
            }
        }

        // Horizontal boundaries: compare row (b*8 - 1) vs (b*8) within each block col.
        var horizontalDiffSum = 0.0
        var horizontalPairs = 0
        for blockCol in 0..<(widthAligned / 8) {
            for colWithin in 0..<8 {
                let colX = blockCol * 8 + colWithin
                for blockRow in 1..<(heightAligned / 8) {
                    let topRow = blockRow * 8 - 1
                    let bottomRow = blockRow * 8
                    horizontalDiffSum += abs(
                        gray[topRow * width + colX] - gray[bottomRow * width + colX]
                    )
                    horizontalPairs += 1
                }
            }
        }

        let verticalMean = verticalPairs > 0 ? verticalDiffSum / Double(verticalPairs) : 0
        let horizontalMean = horizontalPairs > 0
            ? horizontalDiffSum / Double(horizontalPairs) : 0
        return verticalMean + horizontalMean
    }
}
