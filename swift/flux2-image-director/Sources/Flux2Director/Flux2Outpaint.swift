//
//  Flux2Outpaint.swift
//  Flux2Director
//
//  Phase 8 v3: Outpainting / image expansion (擴圖). Pure-Swift canvas + mask
//  construction for the latent-mask re-injection outpaint recipe (port of
//  python app/flux2_outpaint_pipeline.py).
//
//  Flux2 Klein has no Fill/inpaint variant, so outpaint = latent re-injection:
//  the original region's latent is forced back to its VAE-encoded value each
//  denoise step (mask 0 = keep), only the padded margins (mask 1) denoise.
//
//  This file builds:
//    - the padded canvas (original centered, edge-replicated fill) at a 16-multiple
//    - the latent-space mask (white = regenerate margins, black = keep original),
//      feathered at the seam and block-mean-downsampled to the patch grid
//    - the final pixel composite (bit-perfect kept region + generated margins)
//
//  The denoise loop itself lives in Flux2EditPipeline.outpaint (it reuses the
//  shared scheduler/transformer + Flux2LatentCreator.encodeInitLatent).
//

import Foundation
import MLX

/// Outpaint expansion margins (in pixels) + the resulting canvas size.
public struct OutpaintPlan {
    public let left: Int
    public let right: Int
    public let top: Int
    public let bottom: Int
    public let canvasWidth: Int   // multiple of 16
    public let canvasHeight: Int  // multiple of 16
    public let pasteX: Int        // where the original's left edge lands on the canvas
    public let pasteY: Int        // where the original's top edge lands on the canvas
    public let pasteW: Int        // original width placed (<= input width, clamped to canvas)
    public let pasteH: Int        // original height placed
}

public enum Flux2Outpaint {

    /// Resolve an `--expand` spec + `--pixels` margin into concrete margins and a
    /// 16-multiple canvas size. `expand` accepts:
    ///   "all"                       → every side by `pixels`
    ///   "left,right,top,bottom"     → comma list of sides, each by `pixels`
    ///   "16:9" / "4:3" / "3:2"      → expand the shorter axis to reach that aspect
    public static func plan(expand: String, pixels: Int,
                            inputWidth iw: Int, inputHeight ih: Int) -> OutpaintPlan {
        let p = max(0, pixels)
        var left = 0, right = 0, top = 0, bottom = 0
        let e = expand.lowercased()

        if e == "all" || e.isEmpty {
            left = p; right = p; top = p; bottom = p
        } else if let aspect = parseAspect(e) {
            // Expand to reach target aspect ratio aw:ah, distributing extra to both sides.
            let (aw, ah) = aspect
            var cw = iw, ch = ih
            if iw * ah < ih * aw {
                // too tall → widen
                cw = Int((Double(ih) * Double(aw) / Double(ah)).rounded(.up))
            } else {
                ch = Int((Double(iw) * Double(ah) / Double(aw)).rounded(.up))
            }
            let dx = max(0, cw - iw), dy = max(0, ch - ih)
            left = dx / 2; right = dx - left
            top = dy / 2; bottom = dy - top
        } else {
            let sides = Set(e.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
            if sides.contains("left") { left = p }
            if sides.contains("right") { right = p }
            if sides.contains("top") { top = p }
            if sides.contains("bottom") { bottom = p }
            if sides.isEmpty { left = p; right = p; top = p; bottom = p }
        }

        // Canvas = input + margins, rounded UP to a multiple of 16 (patch grid).
        // Extra rounding slack is added to the trailing/right/bottom margin.
        let rawW = iw + left + right
        let rawH = ih + top + bottom
        let canvasW = roundUp(rawW, 16)
        let canvasH = roundUp(rawH, 16)
        right += canvasW - rawW
        bottom += canvasH - rawH

        let pasteW = min(iw, canvasW)
        let pasteH = min(ih, canvasH)
        return OutpaintPlan(left: left, right: right, top: top, bottom: bottom,
                            canvasWidth: canvasW, canvasHeight: canvasH,
                            pasteX: left, pasteY: top, pasteW: pasteW, pasteH: pasteH)
    }

    /// Build the padded canvas (1,3,canvasH,canvasW) [0,1]: the original pasted at
    /// (pasteX, pasteY), with margins filled by **edge replication** (clamped
    /// sampling of the source). Edge replication gives the model coherent color/
    /// structure context at the seam (better than black for reference conditioning).
    public static func buildPaddedCanvas(input: MLXArray, plan: OutpaintPlan) -> MLXArray {
        // input: (1,3,ih,iw). Source row/col for each canvas pixel = clamp(idx - paste, 0, size-1).
        let ih = input.dim(2), iw = input.dim(3)
        let cH = plan.canvasHeight, cW = plan.canvasWidth
        let rows = clippedOffset(count: cH, paste: plan.pasteY, srcLen: ih)        // (cH,)
        let cols = clippedOffset(count: cW, paste: plan.pasteX, srcLen: iw)        // (cW,)
        // Gather: input[0,0..2, rows[:,None], cols[None,:]] → (1,3,cH,cW) via broadcast.
        let rowsB = rows.reshaped([cH, 1])
        let colsB = cols.reshaped([1, cW])
        return input[0..., 0..., rowsB, colsB]
    }

    /// Build the latent-space mask for re-injection.
    /// Returns (latentMask (1, latentH*latentW, 1) float32 [0,1], pixelMask (1,1,canvasH,canvasW)).
    /// White (1) = padded margins to regenerate; black (0) = original region to keep;
    /// feathered across the seam by `feather` px (block-blur). The latent mask is the
    /// pixel mask block-mean-downsampled to the patch grid (canvasH/16 × canvasW/16),
    /// matching the packed token order (row-major h*latentW + w).
    public static func buildMasks(plan: OutpaintPlan, feather: Int)
        -> (MLXArray, MLXArray)
    {
        let cH = plan.canvasHeight, cW = plan.canvasWidth
        // Pixel mask: 1 everywhere (regenerate), 0 over the pasted original (keep).
        var pixel = MLX.ones([1, 1, cH, cW]).asType(.float32)
        let y0 = plan.pasteY, y1 = min(cH, plan.pasteY + plan.pasteH)
        let x0 = plan.pasteX, x1 = min(cW, plan.pasteX + plan.pasteW)
        pixel[0..., 0..., y0..<y1, x0..<x1] = MLX.zeros([1, 1, y1 - y0, x1 - x0])
        // Feather the seam (box-blur the 0/1 step); re-clip so it stays a clean [0,1] weight.
        let feathered = Flux2Composite.featherMask(pixel.reshaped([cH, cW]), radius: feather)
        let pixelMask = MLX.clip(feathered.reshaped([1, 1, cH, cW]), min: 0.0, max: 1.0)

        // Block-mean downsample to the patch grid. latentH = cH/16, latentW = cW/16.
        let latentH = cH / 16, latentW = cW / 16
        let bh = cH / latentH, bw = cW / latentW
        let m = pixelMask.reshaped([1, 1, latentH, bh, latentW, bw]).asType(.float32)
        let down = m.mean(axis: 3).mean(axis: 4)   // (1,1,latentH,latentW)
        let latentMask = down.reshaped([1, latentH * latentW, 1]).asType(.float32)
        return (latentMask, pixelMask)
    }

    /// Final composite: keep the true original pixels in the kept region (mask 0),
    /// use the generated content in the margins (mask 1), blended across the seam.
    /// `generated` and `padded` are (1,3,H,W) [0,1]; `pixelMask` is (1,1,H,W) [0,1].
    public static func composite(generated: MLXArray, padded: MLXArray, pixelMask: MLXArray)
        -> MLXArray
    {
        let m = pixelMask.asType(generated.dtype)
        return (1.0 - m) * padded + m * generated
    }

    /// Block-mean downsample a pixel mask (1,1,H,W) [0,1] to the packed latent
    /// grid (1, latentH*latentW, 1), matching the row-major token order. Shared
    /// by outpaint (canvas margins) and inpaint (object region) — anywhere a
    /// pixel-space keep/regenerate mask must map to packed latent tokens.
    public static func downsampleMaskToLatent(_ pixelMask: MLXArray, latentH: Int, latentW: Int)
        -> MLXArray
    {
        let cH = pixelMask.dim(2), cW = pixelMask.dim(3)
        let bh = cH / latentH, bw = cW / latentW
        // If the canvas isn't an exact multiple of the latent grid, fall back to a
        // safe integer block size (floor) — callers pass 16-multiple canvases.
        let m = pixelMask.reshaped([1, 1, latentH, max(1, bh), latentW, max(1, bw)]).asType(.float32)
        return m.mean(axis: 3).mean(axis: 4).reshaped([1, latentH * latentW, 1]).asType(.float32)
    }

    /// Dilate a binary pixel mask (1,1,H,W) [0,1] by `radius` px (max-filter via
    /// repeated box-blur threshold). Used to expand the swap region before composite.
    public static func dilateMask(_ mask: MLXArray, radius: Int) -> MLXArray {
        guard radius > 0 else { return mask }
        let h = mask.dim(2), w = mask.dim(3)
        // Reuse the composite feather (box-blur) then re-threshold to a dilated binary.
        let blurred = Flux2Composite.featherMask(mask.reshaped([h, w]).asType(.float32), radius: radius)
        return MLX.clip(blurred.reshaped([1, 1, h, w]), min: 0.0, max: 1.0)
    }

    // MARK: - internals

    private static func parseAspect(_ s: String) -> (Int, Int)? {
        let parts = s.split(separator: ":")
        guard parts.count == 2, let a = Int(parts[0]), let b = Int(parts[1]),
              a > 0, b > 0 else { return nil }
        return (a, b)
    }

    private static func roundUp(_ v: Int, _ m: Int) -> Int {
        ((v + m - 1) / m) * m
    }

    /// arange(count) shifted by `paste` and clamped to [0, srcLen-1] — the source
    /// index each canvas position samples from (edge replication outside the paste).
    private static func clippedOffset(count: Int, paste: Int, srcLen: Int) -> MLXArray {
        let idx = MLX.arange(0, count, dtype: .int32) - Int32(paste)
        let lo = MLX.zeros([count], dtype: .int32)
        let hi = MLX.full([count], values: Int32(srcLen - 1))
        return MLX.maximum(lo, MLX.minimum(idx, hi))
    }
}
