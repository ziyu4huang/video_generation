//
//  RunPyBridge.swift
//  LTXVideoDirector
//
//  Phase-0 bridge: invokes `python/venv/bin/python python/mlx-movie-director/run.py`
//  as a subprocess for the actual LTX-2.3 denoising loop, which is not yet
//  ported to native Swift/MLX (see PLAN.md). Everything ELSE in this package
//  (model discovery, the quality gateway, VLM keyframe verify) is native.
//
//  This is a deliberate, documented interim: it reuses the SAME already-
//  converted mlx-models/ltx-mlx checkpoints a native Swift transformer would
//  load, so swapping the bridge for a native call later is a drop-in
//  replacement behind `I2VEngine`.
//

import Foundation

public struct RunPyResult: Sendable {
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public var succeeded: Bool { exitCode == 0 }
}

/// Thread-safe byte accumulator for the stdout/stderr readabilityHandler
/// closures, which Swift 6 strict concurrency treats as running concurrently.
private final class DataAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        data.append(chunk)
    }

    var snapshot: Data {
        lock.lock(); defer { lock.unlock() }
        return data
    }
}

public enum RunPyBridgeError: Error, CustomStringConvertible {
    case runPyNotFound(String)
    case venvPythonNotFound(String)
    case processFailed(RunPyResult)

    public var description: String {
        switch self {
        case .runPyNotFound(let p): return "run.py not found at \(p)"
        case .venvPythonNotFound(let p): return "mlx venv python not found at \(p) — see CLAUDE.md (python/venv, never system python)"
        case .processFailed(let r):
            return "run.py exited \(r.exitCode)\n--- stderr ---\n\(r.stderr)\n--- stdout (tail) ---\n\(r.stdout.suffix(2000))"
        }
    }
}

public enum RunPyBridge {
    /// Run `run.py <args>`, streaming stdout/stderr live (so long generations
    /// show progress) while also capturing them for callers that need the
    /// final text (e.g. to locate a manifest path printed at the end).
    @discardableResult
    public static func run(_ args: [String], stream: Bool = true) throws -> RunPyResult {
        guard FileManager.default.fileExists(atPath: RepoPaths.runPy.path) else {
            throw RunPyBridgeError.runPyNotFound(RepoPaths.runPy.path)
        }
        guard FileManager.default.fileExists(atPath: RepoPaths.venvPython.path) else {
            throw RunPyBridgeError.venvPythonNotFound(RepoPaths.venvPython.path)
        }

        let process = Process()
        process.executableURL = RepoPaths.venvPython
        process.arguments = [RepoPaths.runPy.path] + args
        process.currentDirectoryURL = RepoPaths.root

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        let stdoutData = DataAccumulator()
        let stderrData = DataAccumulator()

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            stdoutData.append(chunk)
            if stream, let s = String(data: chunk, encoding: .utf8) {
                FileHandle.standardOutput.write(s.data(using: .utf8) ?? Data())
            }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            stderrData.append(chunk)
            if stream, let s = String(data: chunk, encoding: .utf8) {
                FileHandle.standardError.write(s.data(using: .utf8) ?? Data())
            }
        }

        try process.run()
        process.waitUntilExit()
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil

        let result = RunPyResult(
            exitCode: process.terminationStatus,
            stdout: String(data: stdoutData.snapshot, encoding: .utf8) ?? "",
            stderr: String(data: stderrData.snapshot, encoding: .utf8) ?? ""
        )
        if !result.succeeded {
            throw RunPyBridgeError.processFailed(result)
        }
        return result
    }

    /// Find the most recent `t2i2v_*` (or arbitrary prefix) run directory
    /// under python/mlx-movie-director/output/ created after `since` —
    /// run.py doesn't (yet) print a single machine-parseable path, so we
    /// locate the manifest by mtime the same way a human would.
    public static func latestOutputDir(prefix: String, since: Date) throws -> URL? {
        let outputDir = RepoPaths.defaultOutputDir
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: outputDir, includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles])) ?? []
        let candidates = entries.filter { $0.lastPathComponent.hasPrefix(prefix) }
        let withDates: [(URL, Date)] = candidates.compactMap { url in
            guard let vals = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
                  let date = vals.contentModificationDate, date >= since else { return nil }
            return (url, date)
        }
        return withDates.max(by: { $0.1 < $1.1 })?.0
    }
}
