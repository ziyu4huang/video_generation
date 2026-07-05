//
//  LTXModelRegistry.swift
//  LTXVideoDirector
//
//  Discovers the already-converted LTX-2.3 MLX checkpoints under
//  mlx-models/ltx-mlx/{dev,distilled,dasiwa} — the same tree run.py's
//  `video generate/t2i2v --transformer <variant>` loads. This package never
//  re-converts or re-derives weights; it only reads what import-checkpoint /
//  the existing conversion pipeline already produced.
//

import Foundation

public enum LTXTransformerVariant: String, CaseIterable, Sendable {
    case dev
    case distilled
    case dasiwa

    /// `dasiwa` is a distilled+DPO'd dev variant — fast like `distilled`,
    /// tuned for voice/motion quality. Preferred default for I2V-with-speech.
    public static let defaultForI2V: LTXTransformerVariant = .dasiwa
}

public enum LTXModelRegistry {
    /// Variants with a checkpoint actually present on disk.
    public static func installedVariants() -> [LTXTransformerVariant] {
        LTXTransformerVariant.allCases.filter { variantDir($0) != nil }
    }

    /// Directory for a variant, or nil if not installed.
    public static func variantDir(_ variant: LTXTransformerVariant) -> URL? {
        let dir = RepoPaths.ltxModelsRoot.appendingPathComponent(variant.rawValue)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
            return nil
        }
        return dir
    }

    /// safetensors files under a variant's directory (informational — sizes,
    /// presence checks — the actual load happens inside run.py today).
    public static func checkpointFiles(_ variant: LTXTransformerVariant) -> [URL] {
        guard let dir = variantDir(variant) else { return [] }
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.filter { $0.pathExtension == "safetensors" }
    }

    /// The variant's own transformer weights file, e.g.
    /// `ltx-mlx/distilled/transformer-distilled-1.1.safetensors` or
    /// `ltx-mlx/dev/transformer-dev.safetensors` — every variant directory
    /// has exactly one `transformer-*.safetensors` (the rest are shared
    /// VAE/audio/upscaler assets), so this filters `checkpointFiles` by
    /// that prefix instead of hardcoding a per-variant filename. Used by
    /// `NativeI2VStage` to load a caller-selected variant instead of the
    /// hardcoded distilled checkpoint.
    public static func transformerCheckpointURL(_ variant: LTXTransformerVariant) -> URL? {
        checkpointFiles(variant).first { $0.lastPathComponent.hasPrefix("transformer-") }
    }
}
