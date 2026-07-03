//
//  VideoTiling.swift
//  LTXVideoDirector
//
//  Temporal VAE decode tiling — the memory fix that lets `native-i2v`
//  decode long clips (the untiled path lazily builds the whole decode
//  graph; at ~41 frames of 640x960 it exhausts memory and the process
//  dies silently).
//
//  Ported from the vendor reference (ltx-2-mlx
//  ltx_core_mlx/model/video_vae/tiling.py + video_vae.py's
//  `_compute_decode_tiling` / `tiled_decode`), TEMPORAL AXIS ONLY —
//  the auto-tiling entry point upstream (`decode_and_stream` →
//  `_compute_decode_tiling`) also only ever produces temporal tiling;
//  spatial tiling exists there but is never auto-selected. Three
//  reference behaviors that are easy to get wrong, preserved exactly:
//
//    1. `split_temporal_latents`: non-first tiles start 1 latent frame
//       EARLIER than the symmetric split (causal decode needs the prior
//       frame), with the left blend ramp extended by 1 to compensate.
//    2. `map_temporal_interval_to_frame`: latent interval [begin, end)
//       maps to pixel frames [begin*8, 1+(end-1)*8) — NOT [begin*8, end*8)
//       — because each temporal upsample drops its first frame, so n
//       latent frames decode to 1+(n-1)*8 pixel frames.
//    3. The first tile's mask has no left ramp and every tile's
//       trapezoid uses `left_starts_from_0=True` semantics (fade-in
//       begins at exactly 0), so overlapping weights always sum to a
//       positive total everywhere.
//
//  Budget model: peak decode memory is the block-3 intermediate
//  (second DepthToSpaceUpsample output), 512ch x 4 temporal x
//  (4*H_lat) x (4*W_lat) per latent frame. The Swift decoder runs
//  float32 (4 bytes/element), not the reference's bf16 — the
//  bytes-per-frame constant here reflects that.
//

import Foundation
import MLX

public enum VideoDecodeTiling {
    /// Temporal scale factor: 8 pixel frames per latent frame.
    public static let temporalScale = 8

    /// Mirrors the reference `TemporalTilingConfig` (frame-space units).
    public struct TemporalConfig: Equatable {
        public let tileSizeInFrames: Int
        public let tileOverlapInFrames: Int

        public init(tileSizeInFrames: Int, tileOverlapInFrames: Int) {
            precondition(tileSizeInFrames >= 16, "tileSizeInFrames must be >= 16, got \(tileSizeInFrames)")
            precondition(tileSizeInFrames % 8 == 0, "tileSizeInFrames must be divisible by 8, got \(tileSizeInFrames)")
            precondition(tileOverlapInFrames % 8 == 0, "tileOverlapInFrames must be divisible by 8, got \(tileOverlapInFrames)")
            precondition(tileOverlapInFrames < tileSizeInFrames,
                         "overlap \(tileOverlapInFrames) must be < tile size \(tileSizeInFrames)")
            self.tileSizeInFrames = tileSizeInFrames
            self.tileOverlapInFrames = tileOverlapInFrames
        }
    }

    /// One temporal tile: which latent frames to decode, where the decoded
    /// pixel frames land in the output, and the 1D temporal blend mask
    /// (frame-space, same length as the output range).
    public struct TemporalTile: Equatable {
        public let latentRange: Range<Int>
        public let frameRange: Range<Int>
        public let mask: [Float]
    }

    // MARK: - Auto budget (reference `_compute_decode_tiling`)

    /// Decide whether decoding `latentShape` (B, C, F', H', W') needs temporal
    /// tiling to stay under the memory budget. Returns nil when the full
    /// volume fits (no tiling, no overhead). Budget defaults to 8 GB and is
    /// overridable via LTX2_VAE_DECODE_BUDGET_GB (same env var as run.py's
    /// path, so one knob tunes both).
    public static func computeAuto(
        latentShape: [Int], frameRate: Double, budgetGB: Double? = nil
    ) -> TemporalConfig? {
        let budget = budgetGB
            ?? ProcessInfo.processInfo.environment["LTX2_VAE_DECODE_BUDGET_GB"].flatMap(Double.init)
            ?? 8.0
        let fLat = latentShape[2], hLat = latentShape[3], wLat = latentShape[4]
        let budgetBytes = Int(budget * 1024 * 1024 * 1024)

        // Block-3 peak tensor: 512ch x 4 temporal x (4H x 4W spatial) x 4 bytes (float32).
        let block3BytesPerLatFrame = 512 * 4 * (hLat * 4) * (wLat * 4) * 4
        if block3BytesPerLatFrame * fLat <= budgetBytes { return nil }

        let maxLatFrames = max(2, budgetBytes / block3BytesPerLatFrame)
        let tileFrames = max(16, maxLatFrames * temporalScale)

        // Overlap ~1 second of pixel frames, multiple of 8, at most 25% of tile size.
        let oneSecondFrames = max(8, (Int(frameRate) / 8) * 8)
        let overlap = min(oneSecondFrames, (tileFrames / 32) * 8)
        return TemporalConfig(tileSizeInFrames: tileFrames, tileOverlapInFrames: overlap)
    }

    // MARK: - Tile layout (reference `split_temporal_latents` + `map_temporal_interval_to_frame`)

    /// Split `fLat` latent frames into overlapping temporal tiles per `config`.
    /// Returns a single full-range tile when no split is needed.
    public static func makeTiles(latentFrames fLat: Int, config: TemporalConfig) -> [TemporalTile] {
        let size = config.tileSizeInFrames / temporalScale
        let overlap = config.tileOverlapInFrames / temporalScale

        var starts: [Int]
        var ends: [Int]
        var leftRamps: [Int]
        var rightRamps: [Int]

        if fLat <= size {
            starts = [0]; ends = [fLat]; leftRamps = [0]; rightRamps = [0]
        } else {
            // split_with_symmetric_overlaps
            let amount = (fLat + size - 2 * overlap - 1) / (size - overlap)
            starts = (0..<amount).map { $0 * (size - overlap) }
            ends = starts.map { $0 + size }
            ends[amount - 1] = fLat
            leftRamps = [0] + Array(repeating: overlap, count: amount - 1)
            rightRamps = Array(repeating: overlap, count: amount - 1) + [0]
            // split_temporal_latents causal shift: non-first tiles start 1
            // latent frame earlier, left ramp extended by 1.
            for i in 1..<amount {
                starts[i] -= 1
                leftRamps[i] += 1
            }
        }

        return (0..<starts.count).map { i in
            let begin = starts[i], end = ends[i]
            // map_temporal_interval_to_frame
            let frameStart = begin * temporalScale
            let frameStop = 1 + (end - 1) * temporalScale
            let leftRampFrames = leftRamps[i] == 0 ? 0 : 1 + (leftRamps[i] - 1) * temporalScale
            let rightRampFrames = rightRamps[i] * temporalScale
            let mask = trapezoidalMask(
                length: frameStop - frameStart,
                rampLeft: leftRampFrames, rampRight: rightRampFrames,
                leftStartsFromZero: true)
            return TemporalTile(
                latentRange: begin..<end, frameRange: frameStart..<frameStop, mask: mask)
        }
    }

    /// 1D trapezoidal blend mask (reference `compute_trapezoidal_mask_1d`).
    /// `leftStartsFromZero: true` → fade-in values are i/rampLeft for
    /// i in 0..<rampLeft (first element exactly 0); the fade-out values are
    /// 1 - k/(rampRight+1) for k in 1...rampRight (never reaches 0).
    public static func trapezoidalMask(
        length: Int, rampLeft: Int, rampRight: Int, leftStartsFromZero: Bool
    ) -> [Float] {
        precondition(length > 0, "mask length must be positive")
        let left = max(0, min(rampLeft, length))
        let right = max(0, min(rampRight, length))
        var mask = [Float](repeating: 1.0, count: length)
        for i in 0..<left {
            // linspace(0, 1, left+1)[:-1] when starting from zero;
            // linspace(0, 1, left+2)[1:-1] otherwise.
            mask[i] = leftStartsFromZero
                ? Float(i) / Float(left)
                : Float(i + 1) / Float(left + 1)
        }
        if right > 0 {
            for k in 1...right {
                mask[length - right + (k - 1)] *= 1.0 - Float(k) / Float(right + 1)
            }
        }
        return mask
    }

    // MARK: - Tiled decode driver (reference `tiled_decode`, temporal-only)

    /// Decode `latentBCFHW` (B, 128, F', H', W') through `decoder` one temporal
    /// tile at a time, force-evaluating after each tile so its intermediate
    /// activations are freed before the next tile begins, and blending the
    /// overlaps with trapezoidal masks. `config == nil` (or a single tile)
    /// falls through to one whole-volume decode — zero overhead.
    public static func decode(
        decoder: VideoDecoder, latentBCFHW: MLXArray, config: TemporalConfig?
    ) -> MLXArray {
        guard let config else { return decoder(latentBCFHW) }
        let fLat = latentBCFHW.dim(2)
        let tiles = makeTiles(latentFrames: fLat, config: config)
        guard tiles.count > 1 else { return decoder(latentBCFHW) }

        let b = latentBCFHW.dim(0)
        let outF = 1 + (fLat - 1) * temporalScale
        let outH = latentBCFHW.dim(3) * 32
        let outW = latentBCFHW.dim(4) * 32

        var buffer = MLXArray.zeros([b, 3, outF, outH, outW]).asType(.float32)
        var weights = MLXArray.zeros([b, 3, outF, outH, outW]).asType(.float32)

        for tile in tiles {
            let tileLatent = latentBCFHW[0..., 0..., tile.latentRange.lowerBound..<tile.latentRange.upperBound, 0..., 0...]
            let decoded = decoder(tileLatent, materializeStages: true).asType(.float32)
            MLX.eval(decoded)

            let mask = MLXArray(tile.mask).reshaped([1, 1, tile.mask.count, 1, 1])
            let fr = tile.frameRange
            buffer[0..., 0..., fr.lowerBound..<fr.upperBound, 0..., 0...] =
                buffer[0..., 0..., fr.lowerBound..<fr.upperBound, 0..., 0...] + decoded * mask
            weights[0..., 0..., fr.lowerBound..<fr.upperBound, 0..., 0...] =
                weights[0..., 0..., fr.lowerBound..<fr.upperBound, 0..., 0...] + mask
            // Materialize the accumulators so this tile's decode graph can be freed.
            MLX.eval(buffer, weights)
        }

        return buffer / MLX.maximum(weights, MLXArray(Float(1e-8)))
    }
}
