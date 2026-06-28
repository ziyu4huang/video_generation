//
//  RunConfig.swift
//  ZImageDirector
//
//  Mirrors python/mlx-movie-director/app/run_config.py RunConfig.
//  The .run.json file records the INPUT params of a generation run, so the
//  result is fully reproducible. Written alongside the PNG as output_XXXX.run.json.
//

import Foundation

/// Atomic JSON writer (write .tmp → rename), matching python `to_json`.
public enum AtomicJSON {
    public static func write(_ data: [String: Any], to path: String) throws {
        let tmpPath = path + ".tmp"
        let url = URL(fileURLWithPath: tmpPath)
        let serialized = try JSONSerialization.data(
            withJSONObject: data, options: [.prettyPrinted, .sortedKeys])
        // Append trailing newline (matches python manifest to_json).
        var withNewline = serialized
        withNewline.append(0x0A)
        try withNewline.write(to: url)
        // Atomic rename (replaces existing).
        if FileManager.default.fileExists(atPath: path) {
            _ = try FileManager.default.replaceItemAt(
                URL(fileURLWithPath: path), withItemAt: url)
        } else {
            try FileManager.default.moveItem(at: url, to: URL(fileURLWithPath: path))
        }
    }
}

/// The input configuration for a generation run.
/// Schema mirrors run.py RunConfig (subset relevant to Z-Image T2I).
public struct RunConfig: Codable {
    public let schemaVersion: Int
    public let command: String
    public let pipeline: String
    public let transformer: String
    public let prompt: String
    public let width: Int
    public let height: Int
    public let steps: Int
    public let seed: Int
    public let cfgScale: Float
    public let loraPaths: [String]?
    public let loraScale: Float
    public let textEncoder: String
    public let tokenizer: String
    public let vae: String
    public let quantBits: Int
    public let quantGroupSize: Int
    public let createdAt: String

    public init(
        transformer: String, prompt: String, width: Int, height: Int,
        steps: Int, seed: UInt64, cfgScale: Float,
        loraPaths: [String]?, loraScale: Float,
        textEncoder: String, tokenizer: String, vae: String,
        quantBits: Int, quantGroupSize: Int
    ) {
        self.schemaVersion = 3
        self.command = "t2i"
        self.pipeline = "zimage"
        self.transformer = transformer
        self.prompt = prompt
        self.width = width
        self.height = height
        self.steps = steps
        self.seed = Int(seed)
        self.cfgScale = cfgScale
        self.loraPaths = loraPaths?.isEmpty == false ? loraPaths : nil
        self.loraScale = loraScale
        self.textEncoder = textEncoder
        self.tokenizer = tokenizer
        self.vae = vae
        self.quantBits = quantBits
        self.quantGroupSize = quantGroupSize
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        self.createdAt = formatter.string(from: Date())
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case command, pipeline, transformer, prompt
        case width, height, steps, seed
        case cfgScale = "cfg_scale"
        case loraPaths = "lora_paths"
        case loraScale = "lora_scale"
        case textEncoder = "text_encoder"
        case tokenizer, vae
        case quantBits = "quant_bits"
        case quantGroupSize = "quant_group_size"
        case createdAt = "created_at"
    }

    /// Write to output_XXXX.run.json (atomic).
    public func write(to path: String) throws {
        let dict = try RunConfig.encodeToDict(self)
        try AtomicJSON.write(dict, to: path)
    }

    /// Encode via Codable then bridge to [String: Any] for AtomicJSON.
    private static func encodeToDict(_ config: RunConfig) throws -> [String: Any] {
        let data = try JSONEncoder().encode(config)
        // sortedKeys from JSONEncoder; AtomicJSON re-sorts anyway.
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw EncodingError.invalidValue(
                config, .init(codingPath: [], debugDescription: "RunConfig encode failed"))
        }
        return dict
    }
}
