//
//  RunPyBridge.swift
//  Krea2ImageDirector
//
//  Phase 0 bridge: shells out to the parity-validated python MLX pipeline
//  (scripts/krea2_smoke.py) so the Swift CLI is useful immediately. Phase 1+
//  replaces this with a native MLX Swift DiT/VAE/encoder port, verified
//  component-by-component against the python reference (see PLAN.md).
//

import Foundation
import CommonImageDirector

public struct Krea2T2IRequest: Sendable {
    public var prompt: String
    public var width: Int = 1024
    public var height: Int = 1024
    public var steps: Int = 8
    public var seed: Int = 42
    public var mu: Double = 1.15
    public var out: URL

    public init(prompt: String, width: Int = 1024, height: Int = 1024, steps: Int = 8,
                seed: Int = 42, mu: Double = 1.15, out: URL) {
        self.prompt = prompt; self.width = width; self.height = height
        self.steps = steps; self.seed = seed; self.mu = mu; self.out = out
    }
}

public enum Krea2Bridge {
    /// Run T2I via the python pipeline (Phase 0 bridge). Streams stdout/stderr.
    @discardableResult
    public static func t2i(_ request: Krea2T2IRequest) throws -> URL {
        let smoke = RepoPaths.runPy
            .deletingLastPathComponent()
            .appendingPathComponent("scripts/krea2_smoke.py")
        let py = RepoPaths.venvPython.path
        guard FileManager.default.fileExists(atPath: py) else {
            throw NSError(domain: "Krea2Bridge", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "mlx venv not found at \(py)"])
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: py)
        proc.arguments = [
            smoke.path,
            "--prompt", request.prompt,
            "--width", String(request.width),
            "--height", String(request.height),
            "--steps", String(request.steps),
            "--seed", String(request.seed),
            "--mu", String(request.mu),
            "--out", request.out.path,
        ]
        proc.standardOutput = FileHandle.standardOutput
        proc.standardError = FileHandle.standardError
        try proc.run()
        proc.waitUntilExit()
        if proc.terminationStatus != 0 {
            throw NSError(domain: "Krea2Bridge", code: Int(proc.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: "krea2_smoke.py exited non-zero"])
        }
        return request.out
    }
}
