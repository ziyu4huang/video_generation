// vision-ocr-cli — one-shot macOS Vision OCR bridge (ticket 07 #4/#5).
import Foundation
import Vision
import CoreGraphics
import ImageIO

struct OcrOutput: Codable {
    let text: String
    let width: Int
    let height: Int
    let format: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

// Image path: argv[1], else one trimmed line from stdin.
var imagePath: String? = nil
if CommandLine.arguments.count > 1 {
    imagePath = CommandLine.arguments[1]
} else {
    let stdinData = FileHandle.standardInput.readDataToEndOfFile()
    if let s = String(data: stdinData, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
        imagePath = s
    }
}
guard let path = imagePath else {
    fail("usage: vision-ocr-cli <image-path>")
}

guard let fileData = FileManager.default.contents(atPath: path) else {
    fail("cannot read image: \(path)")
}
let cfData = fileData as CFData
guard let src = CGImageSourceCreateWithData(cfData, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fail("cannot decode image: \(path)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("vision request failed: \(error)")
}
let text = (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string }
    .joined(separator: "\n")

// UTI ("public.png") → bare format tag ("png").
let rawFormat = (CGImageSourceGetType(src) as String?) ?? "unknown"
let format = rawFormat.hasPrefix("public.") ? String(rawFormat.dropFirst("public.".count)) : rawFormat

let output = OcrOutput(text: text, width: cgImage.width, height: cgImage.height, format: format)
let encoded: Data
do {
    encoded = try JSONEncoder().encode(output)
} catch {
    fail("json encode failed: \(error)")
}
FileHandle.standardOutput.write(encoded)
