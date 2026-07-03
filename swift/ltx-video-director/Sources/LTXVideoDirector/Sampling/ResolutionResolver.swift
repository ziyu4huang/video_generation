//
//  ResolutionResolver.swift
//  LTXVideoDirector
//
//  Native-path counterpart to run.py's video-generate `_adjust_resolution`
//  (round to nearest 64) and image-t2i's `_resolve_resolution` tiers
//  (app/commands/_shared.py, app/commands/video-generate.py). LTX-2.3's
//  video VAE has a spatial compression factor of 32 (Positions.videoSpatialScale
//  / VideoLatentShape), so any width/height that isn't a multiple of 32
//  either fails patchify or silently truncates a partial-token row/column at
//  the latent boundary — this snaps to the nearest valid resolution instead
//  of erroring or degrading silently on arbitrary user input.
//
//  Minimum-area floor (2026-07-03): a real-world native-i2v run at 384x576
//  (same 2:3 aspect as modelOptimalDefault, just smaller) produced clean
//  output on frame 0 but progressively worse color/texture corruption over
//  the following frames — while an identical run at 640x960 (17 frames, same
//  seed/prompt/fps) stayed clean throughout. The distilled transformer's
//  streaming denoise appears to destabilize over multi-frame sequences when
//  run well below its validated training resolution. Since we don't have
//  evidence of *where* between 384x576 and 640x960 it becomes safe, `optimize`
//  now scales any request below modelOptimalDefault's pixel area up
//  (preserving aspect ratio) to at least that area before snapping — trading
//  "honor small requests literally" for "don't silently hand back corrupted
//  frames." Requests at or above the validated area pass through unscaled.
//

import Foundation

public enum ResolutionResolver {
    /// LTX-2.3 video VAE spatial compression factor (matches
    /// Positions.videoSpatialScale / VideoLatentShape.compute's default).
    public static let spatialScale = 32

    /// The distilled transformer's training-optimal default (matches
    /// NativeI2VStage.Request's and NativeT2IStage's own defaults) — used
    /// when a caller has no explicit target and just wants "the safe
    /// default", mirroring app/commands/_shared.py's "model" resolution tier.
    public static let modelOptimalDefault = (width: 640, height: 960)

    /// Empirically-validated minimum pixel area for stable multi-frame
    /// streaming denoise (see header) — modelOptimalDefault's own area.
    public static let minimumValidatedArea = modelOptimalDefault.width * modelOptimalDefault.height

    /// Snap `width`/`height` to the nearest multiple of `spatialScale`
    /// (rounding, not just ceiling — matches run.py's `_adjust_resolution`
    /// use of `round(x / 64) * 64`, applied here at LTX's real 32-multiple
    /// VAE constraint rather than the two-stage pipeline's 64), after first
    /// scaling up (preserving aspect ratio) any request whose area is below
    /// `minimumValidatedArea`. Never returns less than one `spatialScale`
    /// step in either dimension.
    public static func optimize(width: Int, height: Int) -> (width: Int, height: Int) {
        func snap(_ v: Int) -> Int {
            max(spatialScale, Int((Double(v) / Double(spatialScale)).rounded()) * spatialScale)
        }
        var w = Double(width)
        var h = Double(height)
        let area = w * h
        if area > 0, area < Double(minimumValidatedArea) {
            let scale = (Double(minimumValidatedArea) / area).squareRoot()
            w *= scale
            h *= scale
        }
        return (snap(Int(w.rounded())), snap(Int(h.rounded())))
    }
}
