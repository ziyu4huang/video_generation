//
//  CaptionError.swift
//  ImageGenUtils
//
//  Errors raised by the VLM caption / score client.
//  Extracted from z-image-director's CaptionClient so every image-gen
//  director shares the same error surface.
//

import Foundation

public enum CaptionError: Error, CustomStringConvertible {
    case unreadableImage(String)
    case encodeFailed
    case connectionFailed(String)
    case httpError(Int, String)
    case badResponse(String)

    public var description: String {
        switch self {
        case .unreadableImage(let path): return "cannot read image: \(path)"
        case .encodeFailed: return "failed to JPEG-encode the image"
        case .connectionFailed(let detail): return "VLM connection failed: \(detail). Is LM Studio running on :1234?"
        case .httpError(let code, let body): return "VLM HTTP \(code): \(body.prefix(200))"
        case .badResponse(let raw): return "VLM returned unparseable response: \(raw.prefix(200))"
        }
    }
}
