//
//  I2VEngine.swift
//  LTXVideoDirector
//
//  Beauty-girl-on-street I2V request: ZImage T2I -> VLM prompt -> LTX I2V,
//  driven through run.py's `video t2i2v` (see RunPyBridge / PLAN.md for why
//  this is a Phase-0 bridge rather than a native transformer call). Frame
//  count is snapped to LTX's required 8k+1 stride to hit a target duration.
//

import Foundation

public struct I2VRequest {
    public var prompt: String
    /// zh-TW action/speech intent passed to the VLM prompt-expansion stage
    /// (drives the spoken line baked into the LTX motion prompt). Omit to
    /// skip VLM expansion and use `prompt` verbatim for the video stage.
    public var action: String?
    public var seconds: Double = 10.0
    public var fps: Double = 24.0
    public var transformer: LTXTransformerVariant = .defaultForI2V
    public var t2iTransformer: String = "moody-pro-mix"
    public var t2iWidth: Int = 640
    public var t2iHeight: Int = 960
    public var seed: Int?
    public var qualityCheck: Bool = true
    public var vlmScore: Bool = true

    public init(prompt: String, action: String? = nil) {
        self.prompt = prompt
        self.action = action
    }

    /// LTX frame counts must be 8k+1. Rounds `seconds * fps` to the nearest
    /// such value (minimum 8*1+1=9).
    public var frames: Int {
        let raw = seconds * fps
        // Check both the floor and ceil candidate k and pick whichever 8k+1
        // lands closer to the requested frame count.
        let kFloor = max(1, Int(floor((raw - 1) / 8.0)))
        let kCeil = kFloor + 1
        let fFloor = 8 * kFloor + 1
        let fCeil = 8 * kCeil + 1
        return abs(Double(fFloor) - raw) <= abs(Double(fCeil) - raw) ? fFloor : fCeil
    }

    func runPyArgs() -> [String] {
        var args = [
            "video", "t2i2v",
            "--prompt", prompt,
            "--frames", String(frames),
            "--fps", String(fps),
            "--transformer", transformer.rawValue,
            "--t2i-transformer", t2iTransformer,
            "--t2i-width", String(t2iWidth),
            "--t2i-height", String(t2iHeight),
            "--no-open",
        ]
        if let action, !action.isEmpty {
            args += ["--action", action]
        }
        if let seed {
            args += ["--seed", String(seed)]
        }
        if qualityCheck {
            args += ["--quality-check"]
        }
        if vlmScore {
            args += ["--vlm-score"]
        }
        return args
    }
}

public struct I2VResult {
    public let outputDir: URL
    public let manifest: [String: Any]
    public var imagePath: URL? {
        (manifest["image_path"] as? String).map { URL(fileURLWithPath: $0) }
            ?? sibling("image.png")
    }
    public var videoPath: URL? {
        if let p = manifest["video_path"] as? String { return URL(fileURLWithPath: p) }
        // Fall back to the first .mp4 in the output dir.
        let entries = (try? FileManager.default.contentsOfDirectory(at: outputDir, includingPropertiesForKeys: nil)) ?? []
        return entries.first { $0.pathExtension == "mp4" }
    }
    private func sibling(_ name: String) -> URL? {
        let p = outputDir.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: p.path) ? p : nil
    }
}

public enum I2VEngineError: Error, CustomStringConvertible {
    case outputDirNotFound
    case manifestNotFound(URL)
    public var description: String {
        switch self {
        case .outputDirNotFound: return "could not locate the t2i2v_* output directory run.py just created"
        case .manifestNotFound(let u): return "t2i2v_manifest.json not found at \(u.path)"
        }
    }
}

public enum I2VEngine {
    /// Runs the Phase-0 bridge end-to-end and returns the resulting output
    /// directory + parsed manifest.
    public static func generate(_ request: I2VRequest, stream: Bool = true) throws -> I2VResult {
        let startedAt = Date()
        try RunPyBridge.run(request.runPyArgs(), stream: stream)
        guard let outputDir = try RunPyBridge.latestOutputDir(prefix: "t2i2v_", since: startedAt) else {
            throw I2VEngineError.outputDirNotFound
        }
        let manifestURL = outputDir.appendingPathComponent("t2i2v_manifest.json")
        guard let data = try? Data(contentsOf: manifestURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw I2VEngineError.manifestNotFound(manifestURL)
        }
        return I2VResult(outputDir: outputDir, manifest: json)
    }
}
