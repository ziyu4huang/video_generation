//
//  Manifest.swift
//  ZImageDirector
//
//  Mirrors python/mlx-movie-director/app/manifest.py Manifest.
//  Post-run audit record: timing, memory, model fingerprints, output files,
//  and any quality scores. Written as output_XXXX.manifest.json.
//

import Foundation

/// A single generated output file's metadata.
public struct ManifestOutput: Codable {
    public let path: String
    public let seed: Int
    public let sizeBytes: Int64
    public let width: Int
    public let height: Int

    public init(path: String, seed: Int, sizeBytes: Int64, width: Int, height: Int) {
        self.path = path; self.seed = seed
        self.sizeBytes = sizeBytes; self.width = width; self.height = height
    }

    enum CodingKeys: String, CodingKey {
        case path, seed
        case sizeBytes = "size_bytes"
        case width, height
    }
}

/// A model fingerprint (path + size + partial md5), matching run.py.
public struct ModelFingerprint: Codable {
    public let path: String
    public let sizeBytes: Int64

    public init(path: String, sizeBytes: Int64) {
        self.path = path; self.sizeBytes = sizeBytes
    }

    enum CodingKeys: String, CodingKey {
        case path
        case sizeBytes = "size_bytes"
    }
}

/// Denoising performance breakdown for a single generate() call.
/// Captured per-step so an HTML report can plot the iteration curve and
/// surface it/s, total wall time, and peak memory for debugging/benchmarking.
public struct GenerationPerf: Codable {
    /// Number of denoise steps actually executed (== steps for t2i;
    /// steps - startStep for img2img / inpaint partial-denoise).
    public let steps: Int
    /// First executed step index (0 for t2i; >0 for SDEdit mid-trajectory start).
    public let startStep: Int
    /// Per-step wall-clock time in milliseconds, one entry per executed step.
    public let stepTimesMs: [Double]
    /// Per-step iterations/second (1000 / stepTimesMs[i]). Same length as stepTimesMs.
    public let stepItPerSec: [Double]
    /// Total denoise wall time in seconds (sum of stepTimesMs / 1000).
    public let totalSeconds: Double
    /// Average wall time per step in seconds.
    public let avgStepSeconds: Double
    /// Average iterations/second across all steps (steps / totalSeconds).
    public let avgItPerSec: Double
    /// Peak resident memory at end of generate(), in MB.
    public let peakMemoryMB: Double
    /// Output pixel dimensions (for per-pixel throughput metrics in reports).
    public let width: Int
    public let height: Int

    public init(
        steps: Int, startStep: Int, stepTimesMs: [Double],
        totalSeconds: Double, peakMemoryMB: Double, width: Int, height: Int
    ) {
        self.steps = steps
        self.startStep = startStep
        self.stepTimesMs = stepTimesMs
        self.stepItPerSec = stepTimesMs.map { $0 > 0 ? 1000.0 / $0 : 0 }
        self.totalSeconds = totalSeconds
        self.avgStepSeconds = steps > 0 ? totalSeconds / Double(steps) : 0
        self.avgItPerSec = totalSeconds > 0 ? Double(steps) / totalSeconds : 0
        self.peakMemoryMB = peakMemoryMB
        self.width = width
        self.height = height
    }

    enum CodingKeys: String, CodingKey {
        case steps
        case startStep = "start_step"
        case stepTimesMs = "step_times_ms"
        case stepItPerSec = "step_it_per_sec"
        case totalSeconds = "total_seconds"
        case avgStepSeconds = "avg_step_seconds"
        case avgItPerSec = "avg_it_per_sec"
        case peakMemoryMB = "peak_memory_mb"
        case width, height
    }
}

/// Programmatic + VLM quality scores, embedded in the manifest.
public struct QualityReport: Codable {
    public let programmatic: [String: Double]?
    public let vlmOverall: Int?
    public let vlmArtifacts: Int?
    public let vlmIssues: [String]?
    public let vlmSummary: String?

    public init(
        programmatic: [String: Double]? = nil,
        vlmOverall: Int? = nil, vlmArtifacts: Int? = nil,
        vlmIssues: [String]? = nil, vlmSummary: String? = nil
    ) {
        self.programmatic = programmatic
        self.vlmOverall = vlmOverall; self.vlmArtifacts = vlmArtifacts
        self.vlmIssues = vlmIssues; self.vlmSummary = vlmSummary
    }

    enum CodingKeys: String, CodingKey {
        case programmatic
        case vlmOverall = "vlm_overall"
        case vlmArtifacts = "vlm_artifacts"
        case vlmIssues = "vlm_issues"
        case vlmSummary = "vlm_summary"
    }
}

/// Post-run audit record. Mirrors run.py Manifest schema.
public struct Manifest: Codable {
    public let runFile: String
    public let status: String          // "success" | "error"
    public let startTime: String       // ISO 8601
    public let endTime: String         // ISO 8601
    public let elapsedSeconds: Double
    public let memoryPeakMB: Double
    public let timings: [String: Double]
    public let models: [String: ModelFingerprint]
    public let outputFiles: [ManifestOutput]?
    public let quality: QualityReport?
    /// Per-step denoise performance breakdown (it/s, total, memory). May be nil
    /// for non-generation manifests. Captured for HTML benchmark reports.
    public let perf: GenerationPerf?
    public let error: [String: String]?

    public init(
        runFile: String, status: String, startTime: String, endTime: String,
        elapsedSeconds: Double, memoryPeakMB: Double,
        timings: [String: Double], models: [String: ModelFingerprint],
        outputFiles: [ManifestOutput]?, quality: QualityReport?,
        perf: GenerationPerf? = nil, error: [String: String]? = nil
    ) {
        self.runFile = runFile; self.status = status
        self.startTime = startTime; self.endTime = endTime
        self.elapsedSeconds = elapsedSeconds; self.memoryPeakMB = memoryPeakMB
        self.timings = timings; self.models = models
        self.outputFiles = outputFiles; self.quality = quality
        self.perf = perf; self.error = error
    }

    enum CodingKeys: String, CodingKey {
        case runFile = "run_file"
        case status
        case startTime = "start_time"
        case endTime = "end_time"
        case elapsedSeconds = "elapsed_seconds"
        case memoryPeakMB = "memory_peak_mb"
        case timings, models
        case outputFiles = "output_files"
        case quality
        case perf
        case error
    }

    /// Success factory. Computes elapsed from ISO timestamps.
    public static func success(
        runFile: String, startTime: String, endTime: String,
        timings: [String: Double], models: [String: ModelFingerprint],
        outputFiles: [ManifestOutput], quality: QualityReport?,
        perf: GenerationPerf? = nil
    ) -> Manifest {
        let elapsed = Self.isoElapsed(start: startTime, end: endTime)
        return Manifest(
            runFile: runFile, status: "success",
            startTime: startTime, endTime: endTime,
            elapsedSeconds: elapsed, memoryPeakMB: peakRSSMB(),
            timings: timings, models: models,
            outputFiles: outputFiles, quality: quality, perf: perf, error: nil)
    }

    /// Error factory.
    public static func error(
        runFile: String, startTime: String, endTime: String,
        timings: [String: Double], models: [String: ModelFingerprint],
        errorMessage: String
    ) -> Manifest {
        let elapsed = Self.isoElapsed(start: startTime, end: endTime)
        return Manifest(
            runFile: runFile, status: "error",
            startTime: startTime, endTime: endTime,
            elapsedSeconds: elapsed, memoryPeakMB: peakRSSMB(),
            timings: timings, models: models,
            outputFiles: nil, quality: nil,
            error: ["type": "GenerationError", "message": errorMessage])
    }

    /// Write to output_XXXX.manifest.json (atomic).
    public func write(to path: String) throws {
        let data = try JSONEncoder().encode(self)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw EncodingError.invalidValue(
                self, .init(codingPath: [], debugDescription: "Manifest encode failed"))
        }
        try AtomicJSON.write(dict, to: path)
    }

    /// ISO 8601 now (with timezone), matching python datetime.now(timezone.utc).
    public static func nowISO() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static func isoElapsed(start: String, end: String) -> Double {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let startDate = formatter.date(from: start),
              let endDate = formatter.date(from: end) else { return 0 }
        return endDate.timeIntervalSince(startDate)
    }
}

/// Peak resident memory (mach task_basic_info resident_size).
func peakRSSMB() -> Double {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
        }
    }
    guard result == KERN_SUCCESS else { return 0 }
    return Double(info.resident_size) / 1_048_576.0
}
