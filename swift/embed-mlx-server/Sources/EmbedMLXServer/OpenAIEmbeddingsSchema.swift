// No Hummingbird import: these are pure wire-format types. They were
// briefly ResponseCodable so route handlers could return them directly,
// but HTTPServer encodes explicitly via JSONEncoder (it needs to set the
// status code per branch), so the conformance was never exercised.
//
// Internal rather than public: nothing outside this module references these
// types — they are the /v1/embeddings route's wire format, not library API,
// and HTTPServer only touches them from `private static` methods. Internal
// also means Swift synthesizes the memberwise initializers, so there are no
// hand-written inits to drift out of sync with the stored properties. Tests
// reach them through `@testable import`.
struct EmbeddingsRequest: Codable, Sendable {
    let model: String
    let input: Input

    enum Input: Codable, Sendable {
        case single(String)
        case multiple([String])

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let string = try? container.decode(String.self) {
                self = .single(string)
            } else {
                self = .multiple(try container.decode([String].self))
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .single(let value):
                try container.encode(value)
            case .multiple(let values):
                try container.encode(values)
            }
        }

        var texts: [String] {
            switch self {
            case .single(let value):
                return [value]
            case .multiple(let values):
                return values
            }
        }
    }
}

struct EmbeddingObject: Codable, Sendable {
    let object: String
    let embedding: [Float]
    let index: Int
}

struct EmbeddingsUsage: Codable, Sendable {
    let promptTokens: Int
    let totalTokens: Int

    private enum CodingKeys: String, CodingKey {
        case promptTokens = "prompt_tokens"
        case totalTokens = "total_tokens"
    }
}

struct EmbeddingsResponse: Codable, Sendable {
    let object: String
    let data: [EmbeddingObject]
    let model: String
    let usage: EmbeddingsUsage
}

struct ErrorResponse: Codable, Sendable {
    struct ErrorDetail: Codable, Sendable {
        let message: String
        let type: String
    }

    let error: ErrorDetail
}
