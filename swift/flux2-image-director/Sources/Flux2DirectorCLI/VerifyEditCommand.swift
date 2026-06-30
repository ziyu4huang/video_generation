//
//  VerifyEditCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-edit` — Phase 3.1 checkpoint. Compares Swift reference image
//  conditioning (VAE encode → patchify → bn-normalize → pack) against Python.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct VerifyEdit: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-edit",
            abstract: "Compare Swift Flux2 reference conditioning against Python mflux."
        )

        @Option var vae: String = "flux2-klein"
        @Option(help: "Reference from gen_flux2_edit_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/flux2_edit_ref.safetensors"
        @Option(help: "Reference image (saved by the Python generator).")
        var image: String = "swift/flux2-image-director/verify_refs/ref_image.png"
        @Option var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 verify-edit — Phase 3.1 checkpoint")
            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(vae)
            let vaeWeights = try loadAllShards(url: vaeURL)
            let encoder = Flux2VAEEncoder(weights: vaeWeights)
            let bn = Flux2BatchNormStats(
                runningMean: vaeWeights["bn.running_mean"]!,
                runningVar: vaeWeights["bn.running_var"]!)

            let ref = try loadArrays(url: URL(fileURLWithPath: ref))
            let imgURL = URL(fileURLWithPath: image)

            // Run Swift reference conditioning on the same image.
            let (imageLatents, imageLatentIds) = Flux2ReferenceConditioning.prepare(
                imagePaths: [imgURL], vaeEncoder: encoder, bn: bn,
                height: 512, width: 512, batchSize: 1)
            guard let lat = imageLatents, let ids = imageLatentIds else {
                print("❌ no reference latents produced")
                return
            }
            MLX.eval(lat, ids)
            print("  swift image_latents: \(lat.shape)  ids: \(ids.shape)")

            let refLat = ref["image_latents"]!
            let refIds = ref["image_latent_ids"]!
            let cos = cosine(lat.asType(.float32), refLat)
            let idsMatch = arrayEqual(ids, refIds)

            print("  ref  image_latents: \(refLat.shape)  ids: \(refIds.shape)")
            print("")
            print("[image_latents] cos=\(String(format: "%.5f", cos))")
            print("[image_latent_ids] \(idsMatch ? "✅ MATCH" : "❌ MISMATCH")")
            print("  (sum: swift=\(String(format: "%.2f", lat.sum().item(Float.self))) "
                  + "ref=\(String(format: "%.2f", refLat.sum().item(Float.self))))")
            if cos >= threshold && idsMatch {
                print("")
                print("✅ FLUX2 REFERENCE CONDITIONING MATCHES MFLUX (threshold=\(threshold))")
            } else {
                print("❌ reference conditioning diverges")
            }
            let overall = cos >= threshold && idsMatch
            let checks = [
                VerifyCheck(name: "image_latents", pass: cos >= threshold, cosine: Double(cos),
                            threshold: Double(threshold),
                            detail: "VAE-enc→patchify→BN→pack, swift=\(lat.shape) ref=\(refLat.shape)"),
                VerifyCheck(name: "image_latent_ids", pass: idsMatch, cosine: nil, threshold: nil,
                            detail: idsMatch ? "exact match" : "MISMATCH (RoPE ids)"),
            ]
            VerifyReport.write(VerifySummary(
                app: VerifyReport.app, command: "verify-edit",
                overall_pass: overall, threshold: Double(threshold),
                checks: checks, timestamp: VerifyReport.now()))
        }

        private func loadAllShards(url: URL) throws -> [String: MLXArray] {
            var all: [String: MLXArray] = [:]
            let files = (try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil))
                .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for f in files {
                all.merge(try loadArrays(url: f)) { _, new in new }
            }
            return all
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            return (dot / (na * nb + 1e-12)).item(Float.self)
        }

        private func arrayEqual(_ a: MLXArray, _ b: MLXArray) -> Bool {
            guard a.shape == b.shape else { return false }
            return MLX.all(a .== b).all().item(Bool.self)
        }
    }
}
