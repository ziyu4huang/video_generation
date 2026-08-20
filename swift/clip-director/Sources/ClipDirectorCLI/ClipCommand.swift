//
//  ClipCommand.swift
//  ClipDirectorCLI
//
//  `clip` — native (Swift/MLX) CLIP video-understanding, emitting the EXACT
//  ClipResult JSON the Bun `clipAdapter` (s2-agent-ext-movie-director) parses:
//  { ok, video, prompt, labels, score, prob_mean, frames[{path,index,score,
//  prob}], model, duration_s }. Replaces python `clip_understand.py`
//  (transformers + torch MPS) with a pure-Swift MLX CLIP.
//
//  score = mean over frames of cosine(image_embed, prompt_text_embed);
//  prob = softmax(logit_scale * cos over labels)[prompt]. `--frames` are
//  pre-sampled PNGs (Bun's ffmpeg sampling upstream), matching the python
//  contract. Checkpoint resolved: --checkpoint > MD_CLIP_CHECKPOINT env >
//  cached openai/clip-vit-base-patch32 model.safetensors.
//

import ArgumentParser
import Foundation
import ClipDirector
import MLX

@main
struct ClipDirectorCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "clip",
        abstract: "Native CLIP (Swift/MLX) → ClipResult JSON (frame×prompt cosine scores)."
    )

    @Option(help: "Pre-sampled frame image paths to score.")
    var frames: [String] = []

    @Option(help: "The text prompt to score frames against (always label[0]).")
    var prompt: String

    @Option(help: "Extra candidate labels for multi-way ranking.")
    var labels: [String] = []

    @Option(help: "Path to CLIP model.safetensors (default: cached clip-vit-base-patch32).")
    var checkpoint: String?

    @Option(help: "Write the ClipResult JSON here (also printed to stdout).")
    var output: String?

    func run() throws {
        var payload: [String: Any] = [:]
        var hasError = false
        do {
            guard !frames.isEmpty else { throw ClipError.noFrames }
            for f in frames where !FileManager.default.fileExists(atPath: f) {
                throw ClipError.frameNotFound(f)
            }
            let ckpt = try resolveCheckpoint()
            let model = try CLIPWeights.load(checkpointPath: ckpt)

            let allLabels = [prompt] + labels
            guard var tokenizer = CLIPTokenizer() else { throw ClipError.tokenizerMissing }
            let tokenIds = allLabels.map { tokenizer.tokenize($0) }  // [[Int]] length 77 each
            let flat = tokenIds.flatMap { $0 }.map { Int32($0) }
            let inputIds = MLXArray(flat, [allLabels.count, CLIPTokenizer.maxLength])
            let textEmb = model.textEmbeddings(inputIds)  // (nLabels, 512)

            var perFrame: [[String: Any]] = []
            var cosSum: Double = 0
            var probSum: Double = 0
            let started = ProcessInfo.processInfo.systemUptime
            for (i, f) in frames.enumerated() {
                let pixels = try CLIPImagePreprocess.load(URL(fileURLWithPath: f))
                let imgEmb = model.imageEmbeddings(pixels)  // (1, 512)
                let logits = model.logitsPerImage(imageEmb: imgEmb, textEmb: textEmb)  // (1, nLabels)
                let probs = MLX.softmax(logits, axis: -1)
                let cos = MLX.matmul(imgEmb, textEmb.transposed(1, 0))  // (1, nLabels) raw cosine
                let cos0 = cos[0, 0].item(Float.self)
                let prob0 = probs[0, 0].item(Float.self)
                cosSum += Double(cos0); probSum += Double(prob0)
                perFrame.append([
                    "path": (f as NSString).standardizingPath,
                    "index": i,
                    "score": Double(cos0),
                    "prob": Double(prob0),
                ])
            }
            let elapsed = ProcessInfo.processInfo.systemUptime - started
            let n = max(1, frames.count)
            payload = [
                "ok": true,
                "video": NSNull(),
                "prompt": prompt,
                "labels": allLabels,
                "score": cosSum / Double(n),
                "prob_mean": probSum / Double(n),
                "frames": perFrame,
                "model": ckpt,
                "duration_s": Double(round(elapsed * 1000)) / 1000.0,
            ]
        } catch {
            payload = ["ok": false, "error": "\(error)"]
            hasError = true
        }
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        let jsonString = String(data: data, encoding: .utf8) ?? "{\"ok\":false,\"error\":\"json encode failed\"}"
        print(jsonString)
        if let output { try jsonString.write(toFile: output, atomically: true, encoding: .utf8) }
        if hasError { throw ExitCode(2) }
    }

    private func resolveCheckpoint() throws -> String {
        if let checkpoint, !checkpoint.isEmpty {
            guard FileManager.default.fileExists(atPath: checkpoint) else { throw ClipError.checkpointNotFound(checkpoint) }
            return checkpoint
        }
        if let env = ProcessInfo.processInfo.environment["MD_CLIP_CHECKPOINT"], FileManager.default.fileExists(atPath: env) {
            return env
        }
        let hubDir = (NSString(string: "~/.cache/huggingface/hub/models--openai--clip-vit-base-patch32/snapshots").expandingTildeInPath)
        if let snapshots = try? FileManager.default.contentsOfDirectory(atPath: hubDir) {
            for s in snapshots {
                let cand = "\(hubDir)/\(s)/model.safetensors"
                if FileManager.default.fileExists(atPath: cand) { return cand }
            }
        }
        throw ClipError.checkpointNotFound("no --checkpoint, no MD_CLIP_CHECKPOINT, no cached clip-vit-base-patch32")
    }
}

enum ClipError: Error, CustomStringConvertible {
    case noFrames, frameNotFound(String), checkpointNotFound(String), tokenizerMissing
    var description: String {
        switch self {
        case .noFrames: return "no frames: pass --frames"
        case .frameNotFound(let p): return "frame not found: \(p)"
        case .checkpointNotFound(let p): return "clip checkpoint not found: \(p)"
        case .tokenizerMissing: return "clip tokenizer resources missing from bundle"
        }
    }
}
