//
//  CLIPModel.swift
//  ClipDirector
//
//  Pure-Swift MLX port of openai/clip-vit-base-patch32 for video_understand:
//  image+text embeddings → cosine similarity. The TEXT encoder mirrors the
//  numerically-verified flux2 KontextCLIPEncoder architecture (CLIP text
//  tower: causal self-attn, quick_gelu, EOS pooling) parameterized for
//  base-patch32 dims (hidden=512, heads=8). The VISION tower (ViT-B/32) is
//  ported here from HF's CLIPVisionTransformer: patch-embed + class/position
//  embedding + pre_layrnorm + bidirectional encoder + post_layernorm on the
//  class token. visual_projection / text_projection / logit_scale complete
//  CLIPModel. Weights load directly from the HF model.safetensors (standard
//  text_model.* / vision_model.* key layout, identity mapping).
//
//  Parity target: transformers.CLIPModel — image_embeds @ text_embeds.T
//  (cosine) and logit_scale-scaled logits_per_image, matching clip_understand.py.
//

import Foundation
import MLX
import MLXNN
import MLXFast

// MARK: - Shared primitives

struct ClipLayerNorm {
    let weight: MLXArray
    let bias: MLXArray
    let eps: Float = 1e-5
    func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.layerNorm(x, weight: weight, bias: bias, eps: eps)
    }
}

/// CLIP attention (parameterized numHeads; headDim = hidden/heads = 64 for
/// base-patch32 text AND vision). `causal` toggles the mask (text=True).
struct ClipAttention {
    let qProj: MLXNN.Linear
    let kProj: MLXNN.Linear
    let vProj: MLXNN.Linear
    let outProj: MLXNN.Linear
    let numHeads: Int
    let headDim: Int

    func callAsFunction(_ x: MLXArray, causalMask: MLXArray?) -> MLXArray {
        let (b, l, _) = (x.dim(0), x.dim(1), x.dim(2))
        func reshape(_ t: MLXArray) -> MLXArray {
            t.reshaped([b, l, numHeads, headDim]).transposed(0, 2, 1, 3)
        }
        let q = reshape(qProj(x)); let k = reshape(kProj(x)); let v = reshape(vProj(x))
        let scale = 1.0 / Float(headDim).squareRoot()
        let out = MLXFast.scaledDotProductAttention(queries: q, keys: k, values: v,
                                                    scale: scale, mask: causalMask)
        let merged = out.transposed(0, 2, 1, 3).reshaped([b, l, numHeads * headDim])
        return outProj(merged)
    }
}

/// CLIP MLP — quick_gelu for openai CLIP (both text and vision towers).
struct ClipMLP {
    let fc1: MLXNN.Linear
    let fc2: MLXNN.Linear
    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let h = fc1(x)
        let quickGelu = h * MLX.sigmoid(1.702 * h)
        return fc2(quickGelu)
    }
}

/// CLIP encoder layer: pre-LayerNorm self-attn + pre-LayerNorm MLP, both
/// residual. Identical for text and vision (the difference is the attention
/// mask, applied by the caller).
struct ClipEncoderLayer {
    let selfAttn: ClipAttention
    let layerNorm1: ClipLayerNorm
    let mlp: ClipMLP
    let layerNorm2: ClipLayerNorm

    func callAsFunction(_ x: MLXArray, causalMask: MLXArray?) -> MLXArray {
        var h = x
        h = h + selfAttn(layerNorm1(h), causalMask: causalMask)
        h = h + mlp(layerNorm2(h))
        return h
    }
}

// MARK: - Text tower

/// CLIP text transformer (base-patch32: hidden=512, 12 layers, 8 heads).
/// embed → 12 causal layers → final_layer_norm → EOS-token pool.
public struct CLIPTextEncoder {
    let tokenEmbedding: MLXNN.Embedding
    let positionEmbedding: MLXNN.Embedding
    let layers: [ClipEncoderLayer]
    let finalLayerNorm: ClipLayerNorm
    let hidden: Int

    /// `inputIds` (1, 77). Returns the pooled+final-LN text hidden (1, hidden)
    /// at the EOS position (BEFORE text_projection — projection is applied by
    /// the caller, matching HF CLIPModel).
    public func pooled(_ inputIds: MLXArray) -> MLXArray {
        let seqLen = inputIds.dim(1)
        let positionIds = MLX.arange(0, seqLen).reshaped([1, seqLen])
        var hidden = tokenEmbedding(inputIds) + positionEmbedding(positionIds)
        let tri = MLX.tril(MLX.ones([seqLen, seqLen]), k: 0)
        let mask = ((1 - tri) * -3.4e38).reshaped([1, 1, seqLen, seqLen]).asType(hidden.dtype)
        for layer in layers { hidden = layer(hidden, causalMask: mask) }
        let lastHidden = finalLayerNorm(hidden)
        let eosPos = MLX.argMax(inputIds, axis: -1).item(Int.self)
        return lastHidden[0, eosPos].reshaped([1, -1])
    }
}

// MARK: - Vision tower

/// CLIP ViT-B/32 vision transformer (hidden=768, 12 layers, 12 heads,
/// patch=32, image=224 → 7×7=49 patches + 1 class = 50 positions). embed →
/// pre_layrnorm → 12 bidirectional layers → post_layernorm on the class token.
public struct CLIPVisionEncoder {
    let patchEmbedWeight: MLXArray  // (768, 3, 32, 32) — Conv2d patch-embed weights
    let classEmbedding: MLXArray  // (768,)
    let positionEmbedding: MLXArray  // (50, 768)
    let preLayrnorm: ClipLayerNorm
    let layers: [ClipEncoderLayer]
    let postLayernorm: ClipLayerNorm
    let hidden: Int
    let patchSize: Int
    let gridSize: Int  // 224 / patchSize

    /// `pixelValues` (1, 3, 224, 224) normalized. Returns the post-LN class-token
    /// hidden (1, hidden) BEFORE visual_projection.
    public func pooled(_ pixelValues: MLXArray) -> MLXArray {
        let b = pixelValues.dim(0)
        let g = gridSize, p = patchSize
        // Patch embedding = Conv2d(3, hidden, k=p, stride=p). Manual: extract
        // (b, 3, g, p, g, p) strided windows, reorder to (b, g*g, 3*p*p), matmul
        // with weight reshaped (hidden, 3*p*p).ᵀ → (b, g*g, hidden).
        let patches = MLX.asStrided(pixelValues, [b, 3, g, p, g, p],
                                    strides: [3 * (g * p) * (g * p), (g * p) * (g * p), p * (g * p), (g * p), p, 1])
        let flat = patches.transposed(0, 2, 4, 1, 3, 5).reshaped([b, g * g, 3 * p * p])
        let w = patchEmbedWeight.reshaped([hidden, 3 * p * p])
        let convOut = MLX.matmul(flat, w.transposed(1, 0))  // (b, g*g, hidden)
        // prepend class token → (b, g*g+1, hidden), add positional embedding.
        let cls = classEmbedding.reshaped([1, 1, hidden]).expandedDimensions(axis: 0).reshaped([b, 1, hidden])
        var x = MLX.concatenated([cls, convOut], axis: 1)
        x = x + positionEmbedding
        x = preLayrnorm(x)
        for layer in layers { x = layer(x, causalMask: nil) }
        return postLayernorm(x[0..<b, 0..<1, 0..<hidden].reshaped([b, hidden]))  // class token
    }
}

// MARK: - Full CLIP model

public struct CLIPModel {
    public let text: CLIPTextEncoder
    public let vision: CLIPVisionEncoder
    let visualProjection: MLXArray  // (projDim=512, visionHidden=768)
    let textProjection: MLXArray    // (projDim=512, textHidden=512)
    let logitScale: MLXArray        // scalar; logits = exp(logitScale) * cos

    public init(text: CLIPTextEncoder, vision: CLIPVisionEncoder,
                visualProjection: MLXArray, textProjection: MLXArray, logitScale: MLXArray) {
        self.text = text; self.vision = vision
        self.visualProjection = visualProjection; self.textProjection = textProjection
        self.logitScale = logitScale
    }

    /// Image embedding (1, 512) for one normalized image batch (1,3,224,224).
    /// L2-normalized to match HF CLIPModel's `image_embeds` (forward normalizes
    /// both towers' projected features before returning them).
    public func imageEmbeddings(_ pixelValues: MLXArray) -> MLXArray {
        let pooled = vision.pooled(pixelValues)  // (1, 768)
        let proj = MLX.matmul(pooled, visualProjection.transposed(1, 0))  // (1, 512)
        return proj / MLX.sqrt(MLX.square(proj).sum(axis: -1, keepDims: true))
    }

    /// Text embedding (nLabels, 512) for a batch of tokenized prompts (nLabels, 77).
    /// L2-normalized per row (matches HF CLIPModel.text_embeds).
    public func textEmbeddings(_ inputIds: MLXArray) -> MLXArray {
        let n = inputIds.dim(0)
        var rows: [MLXArray] = []
        for i in 0..<n {
            let pooled = text.pooled(inputIds[i..<i + 1, 0..<inputIds.dim(1)])
            let proj = MLX.matmul(pooled, textProjection.transposed(1, 0)).reshaped([-1])  // (projDim,)
            rows.append(proj)
        }
        let stacked = MLX.stacked(rows, axis: 0)  // (nLabels, projDim)
        return stacked / MLX.sqrt(MLX.square(stacked).sum(axis: -1, keepDims: true))
    }

    /// logits_per_image = exp(logitScale) * (imageEmb @ textEmb.T), shape (nFrames, nLabels).
    public func logitsPerImage(imageEmb: MLXArray, textEmb: MLXArray) -> MLXArray {
        let scale = MLX.exp(logitScale)
        return MLX.matmul(imageEmb, textEmb.transposed(1, 0)) * scale
    }
}

// MARK: - Weight loader (HF model.safetensors → CLIPModel)

public enum CLIPWeights {
    /// Loads the full CLIP model from a `model.safetensors` (openai/clip-vit-base-patch32
    /// layout). Dims inferred from the weight shapes.
    public static func load(checkpointPath: String, precision: DType = .float32) throws -> CLIPModel {
        let url = URL(fileURLWithPath: checkpointPath)
        let w = try MLX.loadArrays(url: url)
        func arr(_ key: String) -> MLXArray { (w[key] ?? MLX.zeros([1])).asType(precision) }
        func ln32(_ key: String) -> ClipLayerNorm {
            ClipLayerNorm(weight: (w[key + ".weight"]!).asType(.float32), bias: (w[key + ".bias"]!).asType(.float32))
        }
        func lin(_ key: String) -> MLXNN.Linear {
            Linear(weight: (w[key + ".weight"]!).asType(precision), bias: (w[key + ".bias"]).map { $0.asType(precision) })
        }
        func embed(_ key: String) -> MLXNN.Embedding {
            Embedding(weight: (w[key + ".weight"]!).asType(precision))
        }

        // ---- text tower ----
        var numTextLayers = 0
        while w["text_model.encoder.layers.\(numTextLayers).self_attn.q_proj.weight"] != nil { numTextLayers += 1 }
        let textHidden = (w["text_model.embeddings.token_embedding.weight"]?.dim(1)) ?? 512
        let textHeads = 8
        let textHeadDim = textHidden / textHeads
        let textLayers = (0..<numTextLayers).map { i -> ClipEncoderLayer in
            let p = "text_model.encoder.layers.\(i)"
            return ClipEncoderLayer(
                selfAttn: ClipAttention(
                    qProj: lin("\(p).self_attn.q_proj"), kProj: lin("\(p).self_attn.k_proj"),
                    vProj: lin("\(p).self_attn.v_proj"), outProj: lin("\(p).self_attn.out_proj"),
                    numHeads: textHeads, headDim: textHeadDim),
                layerNorm1: ln32("\(p).layer_norm1"),
                mlp: ClipMLP(fc1: lin("\(p).mlp.fc1"), fc2: lin("\(p).mlp.fc2")),
                layerNorm2: ln32("\(p).layer_norm2"))
        }
        let text = CLIPTextEncoder(
            tokenEmbedding: embed("text_model.embeddings.token_embedding"),
            positionEmbedding: embed("text_model.embeddings.position_embedding"),
            layers: textLayers,
            finalLayerNorm: ln32("text_model.final_layer_norm"),
            hidden: textHidden)

        // ---- vision tower ----
        var numVisLayers = 0
        while w["vision_model.encoder.layers.\(numVisLayers).self_attn.q_proj.weight"] != nil { numVisLayers += 1 }
        let visionHidden = (w["vision_model.embeddings.patch_embedding.weight"]?.dim(0)) ?? 768
        let visionHeads = 12
        let visionHeadDim = visionHidden / visionHeads
        let visLayers = (0..<numVisLayers).map { i -> ClipEncoderLayer in
            let p = "vision_model.encoder.layers.\(i)"
            return ClipEncoderLayer(
                selfAttn: ClipAttention(
                    qProj: lin("\(p).self_attn.q_proj"), kProj: lin("\(p).self_attn.k_proj"),
                    vProj: lin("\(p).self_attn.v_proj"), outProj: lin("\(p).self_attn.out_proj"),
                    numHeads: visionHeads, headDim: visionHeadDim),
                layerNorm1: ln32("\(p).layer_norm1"),
                mlp: ClipMLP(fc1: lin("\(p).mlp.fc1"), fc2: lin("\(p).mlp.fc2")),
                layerNorm2: ln32("\(p).layer_norm2"))
        }
        let patchW = (w["vision_model.embeddings.patch_embedding.weight"])!.asType(precision)
        let vision = CLIPVisionEncoder(
            patchEmbedWeight: patchW,
            classEmbedding: (w["vision_model.embeddings.class_embedding"]!).asType(precision),
            positionEmbedding: (w["vision_model.embeddings.position_embedding.weight"]!).asType(precision),
            preLayrnorm: ln32("vision_model.pre_layrnorm"),
            layers: visLayers,
            postLayernorm: ln32("vision_model.post_layernorm"),
            hidden: visionHidden,
            patchSize: 32,
            gridSize: 7)

        return CLIPModel(
            text: text, vision: vision,
            visualProjection: (w["visual_projection.weight"]!).asType(precision),
            textProjection: (w["text_projection.weight"]!).asType(precision),
            logitScale: (w["logit_scale"]!).asType(.float32))
    }
}
