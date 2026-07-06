//
//  ZImageTransformer.swift
//  ZImageDirector
//
//  Port of app/transformer.py:ZImageTransformerMLX (T2I / no-ControlNet path).
//

import Foundation
import MLX
import MLXNN

/// Opt-in per-block breakdown of one transformer forward pass, produced only
/// when `callAsFunction`'s `onBlockTimings` handler is non-nil.
public struct BlockTimings {
    public var noiseRefinerMs: Double = 0
    public var contextRefinerMs: Double = 0
    public var layersMs: Double = 0
}

/// Pure-Swift Z-Image 6B S3-DiT transformer. T2I forward path only (no
/// ControlNet injection — that is a separate model, not part of T2I).
public final class ZImageTransformer: Module {

    public let config: TransformerConfig
    public let tScale: Float

    public let tEmbedder: TimestepEmbedder
    public let xEmbedder: QuantizedLinear       // in_channels*4 → dim
    public let capEmbedderNorm: ZRMSNorm        // cap_embedder.layers[0]
    public let capEmbedderLinear: QuantizedLinear  // cap_embedder.layers[1]: cap_feat_dim → dim
    public let finalLayer: FinalLayer

    public let xPadToken: MLXArray              // (1, dim)
    public let capPadToken: MLXArray            // (1, dim)

    public let noiseRefiner: [ZImageTransformerBlock]   // modulation=true
    public let contextRefiner: [ZImageTransformerBlock] // modulation=false
    public let layers: [ZImageTransformerBlock]         // modulation=true

    /// Build from a loaded weight dictionary (Phase 1 output).
    public init(weights: [String: MLXArray], config: TransformerConfig, groupSize: Int = 64, bits: Int = 8) {
        self.config = config
        self.tScale = Float(config.tScale)

        let loader = TransformerWeightLoader(
            weights: weights, config: config, groupSize: groupSize, bits: bits
        )

        self.tEmbedder = loader.tEmbedder()
        self.xEmbedder = loader.quantLinear("x_embedder")
        self.capEmbedderNorm = loader.rmsNorm("cap_embedder.layers.0")
        self.capEmbedderLinear = loader.quantLinear("cap_embedder.layers.1")
        self.finalLayer = loader.finalLayer()

        self.xPadToken = weights["x_pad_token"]!
        self.capPadToken = weights["cap_pad_token"]!

        self.noiseRefiner = (0..<config.nRefinerLayers).map {
            loader.block("noise_refiner.\($0)", modulation: true)
        }
        self.contextRefiner = (0..<config.nRefinerLayers).map {
            loader.block("context_refiner.\($0)", modulation: false)
        }
        self.layers = (0..<config.nLayers).map {
            loader.block("layers.\($0)", modulation: true)
        }
        super.init()
    }

    // MARK: - RoPE

    /// Compute cos/sin for all positions, matching prepare_rope + _get_fused_args_cached.
    /// positions: (B, L, 3) [h, w, t]. Returns (cos, sin) each (B, L, 1, headDim/2).
    public func prepareRope(positions: MLXArray) -> (cos: MLXArray, sin: MLXArray) {
        // dims = [32, 48, 48] → half = [16, 24, 24], total 64 = headDim/2.
        let dims = config.axesDims  // [32, 48, 48]
        let theta = Float(config.ropeTheta)

        // freqs per axis: exp(-log(theta) * arange(0, d//2) / (d//2))
        let freqsLists: [MLXArray] = dims.map { d in
            let half = d / 2
            return MLX.exp(-MLX.log(MLXArray(theta)) * MLXArray.arange(0, half).asType(.float32) / Float(half))
        }

        // positions[..., 0/1/2] → (B, L), then [..., None, None] * freqs[None,None,None,:]
        let posH = positions[0..., 0..., 0].asType(.float32)
        let posW = positions[0..., 0..., 1].asType(.float32)
        let posT = positions[0..., 0..., 2].asType(.float32)

        let argsH = posH.expandedDimensions(axis: -1).expandedDimensions(axis: -1) * freqsLists[0].expandedDimensions(axis: 0).expandedDimensions(axis: 0)
        let argsW = posW.expandedDimensions(axis: -1).expandedDimensions(axis: -1) * freqsLists[1].expandedDimensions(axis: 0).expandedDimensions(axis: 0)
        let argsT = posT.expandedDimensions(axis: -1).expandedDimensions(axis: -1) * freqsLists[2].expandedDimensions(axis: 0).expandedDimensions(axis: 0)

        let args = MLX.concatenated([argsH, argsW, argsT], axis: -1)  // (B, L, 1, 64)
        return (MLX.cos(args), MLX.sin(args))
    }

    // MARK: - Forward (T2I, no ControlNet)

    /// Forward pass — no-ControlNet path (mirrors Python __call__ with
    /// controlnet_model=None).
    public func callAsFunction(
        x: MLXArray, t: MLXArray, capFeats: MLXArray,
        xPos: MLXArray, capPos: MLXArray, cos: MLXArray, sin: MLXArray,
        xMask: MLXArray? = nil, capMask: MLXArray? = nil,
        controlnet: ZImageControlNet? = nil,
        controlnetContext: MLXArray? = nil,
        controlnetStrength: Float = 1.0,
        // Opt-in per-block breakdown (noiseRefiner / contextRefiner / main
        // layers). Forces an extra MLX.eval sync point after each stage to
        // split the timing — real overhead absent when nil, same "opt-in,
        // bounded" pattern as T2IPipeline's profileSubsteps. When nil (the
        // default), this forward pass is byte-identical to before this
        // parameter existed.
        onBlockTimings: ((BlockTimings) -> Void)? = nil,
        // Opt-in attention-vs-MLP breakdown, accumulated ONLY across the main
        // `layers` stage (the ~90%+-of-forward-time stage confirmed by
        // BlockTimings in PR #315) — noiseRefiner/contextRefiner are skipped
        // since they're a small, fixed fraction and would just add noise to
        // the split. Nil by default; same zero-cost-when-off pattern.
        onLayerAttnMlpTimings: ((AttnMlpTimings) -> Void)? = nil
    ) -> MLXArray {
        let profiling = onBlockTimings != nil
        let profilingAttnMlp = onLayerAttnMlpTimings != nil
        let useCnet = controlnet != nil && controlnetContext != nil
        let temb = tEmbedder(t * tScale)
        var xi = xEmbedder(x)
        if let xMask = xMask {
            xi = MLX.where(xMask.expandedDimensions(axis: -1), xPadToken, xi)
        }

        // Save original embedded x for ControlNet (ComfyUI passes original, not current).
        let xOriginal = useCnet ? xi : nil

        var cap = capEmbedderLinear(capEmbedderNorm(capFeats))
        if let capMask = capMask {
            cap = MLX.where(capMask.expandedDimensions(axis: -1), capPadToken, cap)
        }

        var timings = BlockTimings()
        let noiseRefinerStart = profiling ? Date() : nil

        // Noise refiners — interleaved with ControlNet noise refiner blocks.
        var cnetCtx = controlnetContext
        var cosImg = cos[0..., 0..<xi.dim(1)]
        var sinImg = sin[0..., 0..<xi.dim(1)]
        for (refI, blk) in noiseRefiner.enumerated() {
            xi = blk(xi, mask: nil, positions: xPos, adalnInput: temb, cos: cosImg, sin: sinImg)
            cosImg = cos[0..., 0..<xi.dim(1)]
            sinImg = sin[0..., 0..<xi.dim(1)]

            if useCnet, let cnet = controlnet, let ctx = cnetCtx, let xOrig = xOriginal {
                let cosC = cosImg[0..., 0..<ctx.dim(1)]
                let sinC = sinImg[0..., 0..<ctx.dim(1)]
                let (residual, newCtx) = cnet.forwardNoiseRefiner(
                    layerId: refI, controlContext: ctx, mainHidden: xOrig,
                    temb: temb, cos: cosC, sin: sinC)
                cnetCtx = newCtx
                xi = xi + residual * controlnetStrength
            }
        }
        if profiling {
            MLX.eval(xi)
            timings.noiseRefinerMs = noiseRefinerStart!.distance(to: Date()) * 1000
        }

        let contextRefinerStart = profiling ? Date() : nil
        // Context refiners (caption tokens).
        for blk in contextRefiner {
            cap = blk(cap, mask: nil, positions: capPos, adalnInput: nil,
                      cos: cos[0..., xi.dim(1)...], sin: sin[0..., xi.dim(1)...])
        }
        if profiling {
            MLX.eval(cap)
            timings.contextRefinerMs = contextRefinerStart!.distance(to: Date()) * 1000
        }

        let xLen = xi.dim(1)
        var unified = MLX.concatenated([xi, cap], axis: 1)
        let unifiedPos = MLX.concatenated([xPos, capPos], axis: 1)

        // Save original image tokens for ControlNet (captured once).
        let unifiedOriginalImg = useCnet ? unified[0..., 0..<xLen, 0...] : nil

        // ControlNet stride-2 injection: control_layer[k] → main_layer[k * div].
        // Python: div = max(1, round(len(layers) / n_control_layers)) — banker's rounding.
        let nCnetLayers = useCnet ? (controlnet?.nControlLayers ?? 0) : 0
        let div = nCnetLayers > 0
            ? max(1, Int((Float(layers.count) / Float(nCnetLayers)).rounded(.toNearestOrEven)))
            : 2
        var cnetLayerIdx = 0

        let layersStart = profiling ? Date() : nil
        for (i, blk) in layers.enumerated() {
            if useCnet, let cnet = controlnet, let ctx = cnetCtx, let mainImg = unifiedOriginalImg {
                let cnetIdx = i / div
                while cnetLayerIdx <= cnetIdx && cnetLayerIdx < nCnetLayers {
                    let cosC = cos[0..., 0..<ctx.dim(1)]
                    let sinC = sin[0..., 0..<ctx.dim(1)]
                    let (residual, newCtx) = cnet.forwardControlLayer(
                        layerId: cnetLayerIdx, controlContext: ctx, mainHidden: mainImg,
                        temb: temb, cos: cosC, sin: sinC)
                    cnetCtx = newCtx
                    // Inject residual into image tokens only.
                    let img = unified[0..., 0..<xLen, 0...] + residual * controlnetStrength
                    let cap2 = unified[0..., xLen..., 0...]
                    unified = MLX.concatenated([img, cap2], axis: 1)
                    cnetLayerIdx += 1
                }
            }
            let onAttnMlp: ((AttnMlpTimings) -> Void)? = profilingAttnMlp ? { t in
                onLayerAttnMlpTimings?(t)
            } : nil
            unified = blk(unified, mask: nil, positions: unifiedPos, adalnInput: temb, cos: cos, sin: sin,
                          onAttnMlpTimings: onAttnMlp)
        }
        if profiling {
            MLX.eval(unified)
            timings.layersMs = layersStart!.distance(to: Date()) * 1000
        }

        let result = finalLayer(unified[0..., 0..<xLen, 0...], temb)
        onBlockTimings?(timings)
        return result
    }
}
