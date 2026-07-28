//
//  MusicGenWeights.swift
//  MusicGenDirector
//
//  Loads decoder.safetensors (from run.py import-musicgen) into
//  MusicGenDecoder. Key layout confirmed directly against the real
//  checkpoint on disk (397 total keys, verified by loading it with
//  `mx.load` in Python — see Task 6's report for the exact probe used):
//
//    model.decoder.embed_tokens.{0..3}.weight   (2049, 1024)  -- vocabSize+1 rows (pad/bos id 2048)
//    model.decoder.embed_positions.weights      (2048, 1024)  -- real sinusoidal buffer (see MusicGenDecoder.swift header)
//    model.decoder.layers.{0..23}.self_attn.{q,k,v,out}_proj.weight        (1024, 1024), no bias
//    model.decoder.layers.{i}.self_attn_layer_norm.{weight,bias}           (1024,)
//    model.decoder.layers.{i}.encoder_attn.{q,k,v,out}_proj.weight         (1024, 1024), no bias
//    model.decoder.layers.{i}.encoder_attn_layer_norm.{weight,bias}        (1024,)
//    model.decoder.layers.{i}.fc1.weight   (4096, 1024), no bias
//    model.decoder.layers.{i}.fc2.weight   (1024, 4096), no bias
//    model.decoder.layers.{i}.final_layer_norm.{weight,bias}               (1024,)
//    model.decoder.layer_norm.{weight,bias}     (1024,)
//    lm_heads.{0..3}.weight                     (2048, 1024), no bias -- TOP-LEVEL, not nested under model./decoder.
//    enc_to_dec_proj.weight                     (1024, 768)  -- TOP-LEVEL
//    enc_to_dec_proj.bias                       (1024,)      -- confirmed present: enc_to_dec_proj DOES have bias
//
//  Every projection inside the 24 layers (q/k/v/out/fc1/fc2) is bias-free —
//  confirmed by counting: the checkpoint has exactly 74 `.bias` keys total
//  (3 layer-norms/layer * 24 layers + 2 for the final layer-norm = 74), i.e.
//  ONLY layer-norms (and enc_to_dec_proj, counted separately above) carry a
//  bias. The plan's draft guessed the prefix might be bare `decoder.` as a
//  fallback — the real checkpoint uses `model.decoder.` exclusively, so this
//  loader asserts that prefix directly rather than probing both (a silent
//  fallback to a prefix that doesn't actually exist in this checkpoint would
//  just be dead code).
//

import Foundation
import MLX
import MLXNN

public struct MusicGenWeights {
    public let arrays: [String: MLXArray]

    public static func load(path: URL) throws -> MusicGenWeights {
        MusicGenWeights(arrays: try loadArrays(url: path))
    }
}

public extension MusicGenDecoder {
    static func build(weights: MusicGenWeights, precision: DType = .float32) throws -> MusicGenDecoder {
        let w = weights.arrays
        let decoderPrefix = "model.decoder."

        guard w["\(decoderPrefix)embed_tokens.0.weight"] != nil else {
            let sample = w.keys.filter { $0.contains("embed_tokens") }.sorted()
            throw NSError(domain: "MusicGenWeights", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "could not find '\(decoderPrefix)embed_tokens.0.weight' in the "
                    + "checkpoint — real key layout has changed since this loader was written. "
                    + "Keys containing 'embed_tokens': \(sample)"])
        }

        func lin(_ key: String) -> MLXNN.Linear {
            Linear(weight: w["\(key).weight"]!.asType(precision), bias: nil)
        }
        func linWithBias(_ key: String) -> MLXNN.Linear {
            Linear(weight: w["\(key).weight"]!.asType(precision), bias: w["\(key).bias"]!.asType(precision))
        }
        func ln(_ key: String) -> MGLayerNorm {
            MGLayerNorm(weight: w["\(key).weight"]!.asType(.float32), bias: w["\(key).bias"]!.asType(.float32))
        }

        let embedTokens = (0..<MusicGenDecoder.numCodebooks).map { cb in
            Embedding(weight: w["\(decoderPrefix)embed_tokens.\(cb).weight"]!.asType(precision))
        }

        guard let posEmbeddings = w["\(decoderPrefix)embed_positions.weights"] else {
            throw NSError(domain: "MusicGenWeights", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "could not find '\(decoderPrefix)embed_positions.weights' — "
                    + "expected the real sinusoidal position-embedding buffer to be exported into the "
                    + "checkpoint (see MusicGenDecoder.swift header)."])
        }

        var numLayers = 0
        while w["\(decoderPrefix)layers.\(numLayers).self_attn.q_proj.weight"] != nil { numLayers += 1 }
        guard numLayers == MusicGenDecoder.numLayers else {
            throw NSError(domain: "MusicGenWeights", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "expected \(MusicGenDecoder.numLayers) decoder layers, found \(numLayers)"])
        }

        let layers = (0..<numLayers).map { i -> MGDecoderLayer in
            let p = "\(decoderPrefix)layers.\(i)"
            return MGDecoderLayer(
                selfAttnLayerNorm: ln("\(p).self_attn_layer_norm"),
                selfAttn: MGDecoderAttention(
                    q: lin("\(p).self_attn.q_proj"), k: lin("\(p).self_attn.k_proj"),
                    v: lin("\(p).self_attn.v_proj"), o: lin("\(p).self_attn.out_proj"),
                    numHeads: MusicGenDecoder.numHeads, headDim: MusicGenDecoder.headDim),
                crossAttnLayerNorm: ln("\(p).encoder_attn_layer_norm"),
                crossAttn: MGDecoderAttention(
                    q: lin("\(p).encoder_attn.q_proj"), k: lin("\(p).encoder_attn.k_proj"),
                    v: lin("\(p).encoder_attn.v_proj"), o: lin("\(p).encoder_attn.out_proj"),
                    numHeads: MusicGenDecoder.numHeads, headDim: MusicGenDecoder.headDim),
                finalLayerNorm: ln("\(p).final_layer_norm"),
                fc1: lin("\(p).fc1"), fc2: lin("\(p).fc2"))
        }

        let layerNorm = ln("\(decoderPrefix)layer_norm")

        guard w["enc_to_dec_proj.weight"] != nil, w["enc_to_dec_proj.bias"] != nil else {
            throw NSError(domain: "MusicGenWeights", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "could not find top-level 'enc_to_dec_proj.weight'/'.bias' — "
                    + "these were folded into decoder.safetensors by Task 2's checkpoint export and are "
                    + "required to bridge T5's 768-dim hidden states into this decoder's 1024-dim "
                    + "cross-attention."])
        }
        let encToDecProj = linWithBias("enc_to_dec_proj")

        guard w["lm_heads.0.weight"] != nil else {
            throw NSError(domain: "MusicGenWeights", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "could not find top-level 'lm_heads.0.weight'."])
        }
        let lmHeads = (0..<MusicGenDecoder.numCodebooks).map { cb in lin("lm_heads.\(cb)") }

        return MusicGenDecoder(
            embedTokens: embedTokens,
            posEmbeddings: posEmbeddings.asType(.float32),
            layers: layers,
            layerNorm: layerNorm,
            encToDecProj: encToDecProj,
            lmHeads: lmHeads)
    }
}
