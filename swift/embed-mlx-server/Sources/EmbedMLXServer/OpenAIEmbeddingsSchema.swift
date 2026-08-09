// No Hummingbird import: these are pure wire-format types. They were
// briefly ResponseCodable so route handlers could return them directly,
// but HTTPServer encodes explicitly via JSONEncoder (it needs to set the
// status code per branch), so the conformance was never exercised.
public struct EmbeddingsRequest: Codable, Sendable {
    public let model: String
    public let input: Input

    public enum Input: Codable, Sendable {
        case single(String)
        case multiple([String])

        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let string = try? container.decode(String.self) {
                self = .single(string)
            } else {
                self = .multiple(try container.decode([String].self))
            }
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .single(let value):
                try container.encode(value)
            case .multiple(let values):
                try container.encode(values)
            }
        }

        public var texts: [String] {
            switch self {
            case .single(let value):
                return [value]
            case .multiple(let values):
                return values
            }
        }
    }
}

public struct EmbeddingObject: Codable, Sendable {
    public let object: String
    public let embedding: [Float]
    public let index: Int

    public init(object: String, embedding: [Float], index: Int) {
        self.object = object
        self.embedding = embedding
        self.index = index
    }
}

public struct EmbeddingsUsage: Codable, Sendable {
    public let promptTokens: Int
    public let totalTokens: Int

    private enum CodingKeys: String, CodingKey {
        case promptTokens = "prompt_tokens"
        case totalTokens = "total_tokens"
    }

    public init(promptTokens: Int, totalTokens: Int) {
        self.promptTokens = promptTokens
        self.totalTokens = totalTokens
    }
}

public struct EmbeddingsResponse: Codable, Sendable {
    public let object: String
    public let data: [EmbeddingObject]
    public let model: String
    public let usage: EmbeddingsUsage

    public init(object: String, data: [EmbeddingObject], model: String, usage: EmbeddingsUsage) {
        self.object = object
        self.data = data
        self.model = model
        self.usage = usage
    }
}

public struct ErrorResponse: Codable, Sendable {
    public struct ErrorDetail: Codable, Sendable {
        public let message: String
        public let type: String

        public init(message: String, type: String) {
            self.message = message
            self.type = type
        }
    }

    public let error: ErrorDetail

    public init(error: ErrorDetail) {
        self.error = error
    }
}
