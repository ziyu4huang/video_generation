//
//  Positions.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.utils.positions — computes the (F, H, W)
//  video / (T,) audio token positions LTXModel's RoPE consumes.
//  Pure arithmetic (no checkpoint weights), verified against
//  scripts/dump_positions_patchify_reference.py in PositionsParityTests.
//

import Foundation
import MLX

public enum Positions {
    public static let videoTemporalScale: Float = 8
    public static let videoSpatialScale: Float = 32
    public static let audioDownsampleFactor: Float = 4
    public static let audioHopLength: Float = 160
    public static let audioSampleRate: Float = 16000
    public static let audioLatentsPerSecond: Float = audioSampleRate / audioHopLength / audioDownsampleFactor  // 25.0

    /// Number of audio latent tokens for a given video pixel-frame count.
    public static func computeAudioTokenCount(numVideoFrames: Int, frameRate: Float = 24.0) -> Int {
        let duration = Float(numVideoFrames) / frameRate
        return Int((duration * audioLatentsPerSecond).rounded())
    }

    /// 3D positions for video tokens in pixel-space with causal fix.
    /// Returns (1, F*H*W, 3) float32 positions [time, height, width].
    public static func computeVideoPositions(numFrames: Int, height: Int, width: Int, frameRate: Float = 24.0) -> MLXArray {
        let idx = (0..<numFrames).map { Float($0) }
        let fStarts = idx.map { max($0 * videoTemporalScale + 1 - videoTemporalScale, 0.0) }
        let fEnds = idx.map { max(($0 + 1) * videoTemporalScale + 1 - videoTemporalScale, 0.0) }
        let fMids = zip(fStarts, fEnds).map { ($0 + $1) / 2.0 / frameRate }

        let hMids = (0..<height).map { Float($0) * videoSpatialScale + videoSpatialScale / 2.0 }
        let wMids = (0..<width).map { Float($0) * videoSpatialScale + videoSpatialScale / 2.0 }

        var flat: [Float] = []
        flat.reserveCapacity(numFrames * height * width * 3)
        for f in 0..<numFrames {
            for h in 0..<height {
                for w in 0..<width {
                    flat.append(fMids[f])
                    flat.append(hMids[h])
                    flat.append(wMids[w])
                }
            }
        }
        return MLXArray(flat, [1, numFrames * height * width, 3])
    }

    /// 1D positions for audio tokens in real-time seconds (causal fix).
    /// Returns (1, T, 1) float32.
    public static func computeAudioPositions(numTokens: Int) -> MLXArray {
        let idx = (0..<numTokens).map { Float($0) }
        let starts = idx.map { max($0 * audioDownsampleFactor + 1 - audioDownsampleFactor, 0.0) * audioHopLength / audioSampleRate }
        let ends = idx.map { max(($0 + 1) * audioDownsampleFactor + 1 - audioDownsampleFactor, 0.0) * audioHopLength / audioSampleRate }
        let mids = zip(starts, ends).map { ($0 + $1) / 2.0 }
        return MLXArray(mids, [1, numTokens, 1])
    }
}
