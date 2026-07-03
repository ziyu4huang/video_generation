import XCTest
import MLX
@testable import LTXVideoDirector

/// Pure-arithmetic tests for VideoDecodeTiling's tile layout / mask / budget
/// math (mirrors the vendor test_decode_tiling.py cases), plus one
/// real-checkpoint parity test proving tiled decode == untiled decode where
/// it matters most: the tile boundaries.
final class VideoTilingTests: XCTestCase {
    // MARK: computeAuto (budget)

    func testNoTilingWhenVideoFitsBudget() {
        // 2 latent frames of 4x4 latent: 512*4*16*16*4 = 2 MB/frame << 1 GB
        let cfg = VideoDecodeTiling.computeAuto(
            latentShape: [1, 128, 2, 4, 4], frameRate: 24.0, budgetGB: 1.0)
        XCTAssertNil(cfg)
    }

    func testTilingTriggersAboveBudget() {
        // 100 latent frames x 2 MB = 200 MB > 50 MB budget
        let cfg = VideoDecodeTiling.computeAuto(
            latentShape: [1, 128, 100, 4, 4], frameRate: 24.0, budgetGB: 0.05)
        XCTAssertNotNil(cfg)
    }

    func testAutoConfigSatisfiesConstraints() {
        for fps in [24.0, 30.0, 48.0, 60.0] {
            guard let cfg = VideoDecodeTiling.computeAuto(
                latentShape: [1, 128, 100, 4, 4], frameRate: fps, budgetGB: 0.05) else {
                XCTFail("expected tiling at fps \(fps)"); continue
            }
            XCTAssertGreaterThanOrEqual(cfg.tileSizeInFrames, 16)
            XCTAssertEqual(cfg.tileSizeInFrames % 8, 0)
            XCTAssertEqual(cfg.tileOverlapInFrames % 8, 0)
            XCTAssertLessThan(cfg.tileOverlapInFrames, cfg.tileSizeInFrames)
        }
    }

    func testTinyBudgetForcesMinimumTileSize() {
        guard let cfg = VideoDecodeTiling.computeAuto(
            latentShape: [1, 128, 100, 4, 4], frameRate: 24.0, budgetGB: 1e-6) else {
            return XCTFail("expected tiling")
        }
        XCTAssertEqual(cfg.tileSizeInFrames, 16)
        XCTAssertEqual(cfg.tileOverlapInFrames, 0, "(16/32)*8 == 0 -> no overlap at minimum tile size")
    }

    // MARK: makeTiles (layout)

    func testSingleTileWhenLatentFitsInOneTile() {
        let cfg = VideoDecodeTiling.TemporalConfig(tileSizeInFrames: 80, tileOverlapInFrames: 24)
        let tiles = VideoDecodeTiling.makeTiles(latentFrames: 6, config: cfg)
        XCTAssertEqual(tiles.count, 1)
        XCTAssertEqual(tiles[0].latentRange, 0..<6)
        XCTAssertEqual(tiles[0].frameRange, 0..<41)
        XCTAssertTrue(tiles[0].mask.allSatisfy { $0 == 1.0 })
    }

    func testCausalShiftOnNonFirstTiles() {
        // 6 latent frames, tile size 2 latent (16 pixel frames), no overlap:
        // symmetric split [0,2),[2,4),[4,6) -> causal shift makes non-first
        // tiles start 1 latent frame earlier with a 1-latent left ramp.
        let cfg = VideoDecodeTiling.TemporalConfig(tileSizeInFrames: 16, tileOverlapInFrames: 0)
        let tiles = VideoDecodeTiling.makeTiles(latentFrames: 6, config: cfg)
        XCTAssertEqual(tiles.map(\.latentRange), [0..<2, 1..<4, 3..<6])
        XCTAssertEqual(tiles.map(\.frameRange), [0..<9, 8..<25, 24..<41])
    }

    func testTileWeightsSumToPositiveEverywhere() {
        // Every output frame must receive positive total weight — otherwise
        // the final buffer/weights division amplifies numerical garbage.
        for fLat in [4, 6, 7, 10, 16] {
            for (size, overlap) in [(16, 0), (16, 8), (32, 8), (48, 16)] {
                let cfg = VideoDecodeTiling.TemporalConfig(
                    tileSizeInFrames: size, tileOverlapInFrames: overlap)
                let tiles = VideoDecodeTiling.makeTiles(latentFrames: fLat, config: cfg)
                let outF = 1 + (fLat - 1) * 8
                var total = [Float](repeating: 0, count: outF)
                for tile in tiles {
                    XCTAssertEqual(tile.mask.count, tile.frameRange.count)
                    for (i, f) in tile.frameRange.enumerated() { total[f] += tile.mask[i] }
                }
                for (f, w) in total.enumerated() {
                    XCTAssertGreaterThan(w, 0.0, "frame \(f) has zero weight (fLat=\(fLat), size=\(size), overlap=\(overlap))")
                }
            }
        }
    }

    func testTilesCoverAllLatentFrames() {
        let cfg = VideoDecodeTiling.TemporalConfig(tileSizeInFrames: 16, tileOverlapInFrames: 8)
        let tiles = VideoDecodeTiling.makeTiles(latentFrames: 11, config: cfg)
        var covered = Set<Int>()
        for tile in tiles { covered.formUnion(tile.latentRange) }
        XCTAssertEqual(covered, Set(0..<11))
        XCTAssertEqual(tiles.last!.latentRange.upperBound, 11)
    }

    // MARK: trapezoidalMask

    func testTrapezoidLeftStartsFromZero() {
        let m = VideoDecodeTiling.trapezoidalMask(length: 8, rampLeft: 4, rampRight: 0, leftStartsFromZero: true)
        XCTAssertEqual(m[0], 0.0)
        XCTAssertEqual(m[1], 0.25, accuracy: 1e-6)
        XCTAssertEqual(m[3], 0.75, accuracy: 1e-6)
        XCTAssertEqual(m[4], 1.0)
        XCTAssertEqual(m[7], 1.0)
    }

    func testTrapezoidRightRampNeverReachesZero() {
        let m = VideoDecodeTiling.trapezoidalMask(length: 8, rampLeft: 0, rampRight: 4, leftStartsFromZero: true)
        XCTAssertEqual(m[3], 1.0)
        XCTAssertEqual(m[4], 0.8, accuracy: 1e-6)
        XCTAssertEqual(m[7], 0.2, accuracy: 1e-6)
        XCTAssertGreaterThan(m[7], 0.0)
    }

    // MARK: tiled == untiled parity (real checkpoint)

    func testTiledDecodeMatchesUntiledOnRealCheckpoint() throws {
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real checkpoint not found — skipping tiled-decode parity test")
        }
        let decoder = try VideoDecoderLoader.loadReal(checkpointURL: checkpointURL)

        // 6 latent frames, small spatial extent; force 3 tiles with overlap 8
        // frames so both the causal shift AND the trapezoid blend paths run.
        let key = MLXRandom.key(7)
        let latent = MLXRandom.normal([1, 128, 6, 4, 4], key: key).asType(.float32) * 0.5
        let untiled = decoder(latent)
        MLX.eval(untiled)

        let cfg = VideoDecodeTiling.TemporalConfig(tileSizeInFrames: 24, tileOverlapInFrames: 8)
        let tiled = VideoDecodeTiling.decode(decoder: decoder, latentBCFHW: latent, config: cfg)
        MLX.eval(tiled)

        XCTAssertEqual(tiled.shape, untiled.shape)
        let flat = tiled.asArray(Float.self)
        XCTAssertTrue(flat.allSatisfy { $0.isFinite }, "tiled decode produced NaN/Inf")

        // Tiled decode is NOT bit-exact vs untiled: the decoder is non-causal
        // (symmetric padding), so every tile boundary truncates the temporal
        // receptive field and the overlap blend only mitigates — the vendor
        // tiled_decode has the same property. On this deliberately tiny latent
        // (2-3 latent frames/tile, random noise input — worst case: the whole
        // tile sits inside the boundary's receptive field) deviations up to a
        // few tenths are expected. What must hold: bounded deviation (layout/
        // mask errors produce garbage or doubled/zeroed weight -> diffs >> 1)
        // and a small mean (only boundary-adjacent regions deviate).
        let maxAbsDiff = MLX.max(MLX.abs(tiled - untiled)).item(Float.self)
        let meanAbsDiff = MLX.mean(MLX.abs(tiled - untiled)).item(Float.self)
        XCTAssertLessThan(maxAbsDiff, 0.5, "tiled decode deviates too much (max abs diff \(maxAbsDiff))")
        XCTAssertLessThan(meanAbsDiff, 0.02, "tiled decode mean deviation too high (\(meanAbsDiff))")
    }
}
