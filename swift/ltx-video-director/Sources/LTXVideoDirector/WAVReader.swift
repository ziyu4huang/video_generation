//
//  WAVReader.swift
//  LTXVideoDirector
//
//  Minimal canonical PCM WAV reader — the inverse of WAVWriter.swift.
//  Parses a standard 44-byte-header RIFF/WAVE file (PCM16 or IEEE float32
//  data), no external dependencies. Used by the audio-track injection path
//  (--audio-track) to load a user-supplied WAV before resampling/encoding.
//

import Foundation

public enum WAVReader {
    public enum ReadError: Error, CustomStringConvertible {
        case notFound(URL)
        case notRIFF
        case notWAVE
        case unsupportedFormat(tag: Int, bitsPerSample: Int)
        case missingDataChunk

        public var description: String {
            switch self {
            case .notFound(let url): return "WAV file not found at \(url.path)"
            case .notRIFF: return "not a RIFF file"
            case .notWAVE: return "not a WAVE file"
            case .unsupportedFormat(let tag, let bits): return "unsupported WAV format (tag=\(tag), bitsPerSample=\(bits)) — only PCM16 and Float32 are supported"
            case .missingDataChunk: return "WAV file has no 'data' chunk"
            }
        }
    }

    public struct Result {
        public let channels: [[Float]]  // each in [-1, 1]
        public let sampleRate: Int
    }

    public static func read(url: URL) throws -> Result {
        guard let data = FileManager.default.contents(atPath: url.path) else {
            throw ReadError.notFound(url)
        }
        guard data.count >= 12 else { throw ReadError.notRIFF }
        guard data[0..<4].elementsEqual("RIFF".utf8) else { throw ReadError.notRIFF }
        guard data[8..<12].elementsEqual("WAVE".utf8) else { throw ReadError.notWAVE }

        func readUInt32(_ offset: Int) -> UInt32 {
            data.subdata(in: offset..<(offset + 4)).withUnsafeBytes { $0.load(as: UInt32.self) }.littleEndian
        }
        func readUInt16(_ offset: Int) -> UInt16 {
            data.subdata(in: offset..<(offset + 2)).withUnsafeBytes { $0.load(as: UInt16.self) }.littleEndian
        }

        var offset = 12
        var formatTag = 1
        var numChannels = 1
        var sampleRate = 16000
        var bitsPerSample = 16
        var dataOffset: Int?
        var dataSize = 0

        while offset + 8 <= data.count {
            let chunkID = data.subdata(in: offset..<(offset + 4))
            let chunkSize = Int(readUInt32(offset + 4))
            let bodyOffset = offset + 8

            if chunkID.elementsEqual("fmt ".utf8) {
                formatTag = Int(readUInt16(bodyOffset))
                numChannels = Int(readUInt16(bodyOffset + 2))
                sampleRate = Int(readUInt32(bodyOffset + 4))
                bitsPerSample = Int(readUInt16(bodyOffset + 14))
            } else if chunkID.elementsEqual("data".utf8) {
                dataOffset = bodyOffset
                dataSize = chunkSize
            }

            offset = bodyOffset + chunkSize + (chunkSize % 2)  // chunks are word-aligned
        }

        guard let dataStart = dataOffset else { throw ReadError.missingDataChunk }
        let bytesPerSample = bitsPerSample / 8
        let frameCount = dataSize / (bytesPerSample * numChannels)

        var channels = [[Float]](repeating: [Float](repeating: 0, count: frameCount), count: numChannels)

        if formatTag == 1, bitsPerSample == 16 {
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                let base = raw.baseAddress!.advanced(by: dataStart).assumingMemoryBound(to: Int16.self)
                for frame in 0..<frameCount {
                    for ch in 0..<numChannels {
                        let sample = Int16(littleEndian: base[frame * numChannels + ch])
                        channels[ch][frame] = Float(sample) / Float(Int16.max)
                    }
                }
            }
        } else if formatTag == 3, bitsPerSample == 32 {
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                let base = raw.baseAddress!.advanced(by: dataStart).assumingMemoryBound(to: Float32.self)
                for frame in 0..<frameCount {
                    for ch in 0..<numChannels {
                        channels[ch][frame] = base[frame * numChannels + ch]
                    }
                }
            }
        } else {
            throw ReadError.unsupportedFormat(tag: formatTag, bitsPerSample: bitsPerSample)
        }

        return Result(channels: channels, sampleRate: sampleRate)
    }
}
