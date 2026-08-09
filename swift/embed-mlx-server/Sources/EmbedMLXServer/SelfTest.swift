public struct SelfTestCase: Sendable {
    public let label: String
    public let near: (String, String)
    public let far: (String, String)

    public init(label: String, near: (String, String), far: (String, String)) {
        self.label = label
        self.near = near
        self.far = far
    }
}

public struct SelfTestResult: Sendable {
    public let label: String
    public let nearSimilarity: Float
    public let farSimilarity: Float

    public var margin: Float { nearSimilarity - farSimilarity }

    /// A bare `near > far` would let a broken model load pass by luck: the
    /// classic mis-loaded/degenerate signature is near-constant vectors, which
    /// give near ≈ far ≈ 1.0 and turn each case into a coin flip. These floors
    /// close that hole while staying far looser than real BGE-M3 numbers
    /// (measured: near ≈ 0.94, far ≈ 0.47, margin ≈ 0.47), so a legitimate
    /// model swap has ~4x headroom before it would trip them.
    public static let minimumMargin: Float = 0.1
    public static let minimumNearSimilarity: Float = 0.5

    public var passed: Bool {
        margin > Self.minimumMargin && nearSimilarity > Self.minimumNearSimilarity
    }
}

public enum SelfTest {
    public static let cases: [SelfTestCase] = [
        SelfTestCase(
            label: "english",
            near: ("The cat sat on the mat.", "A cat was sitting on a mat."),
            far: ("The cat sat on the mat.", "Quarterly revenue increased by 12 percent.")
        ),
        SelfTestCase(
            label: "chinese",
            near: ("今天天氣很好。", "今天天氣真不錯。"),
            far: ("今天天氣很好。", "台北捷運系統於1996年通車。")
        ),
    ]

    public static func run(engine: EmbeddingEngine) async throws -> [SelfTestResult] {
        var results: [SelfTestResult] = []
        for testCase in cases {
            let texts = [testCase.near.0, testCase.near.1, testCase.far.0, testCase.far.1]
            let vectors = try await engine.embed(texts: texts)
            let nearSimilarity = cosineSimilarity(vectors[0], vectors[1])
            let farSimilarity = cosineSimilarity(vectors[2], vectors[3])
            results.append(
                SelfTestResult(label: testCase.label, nearSimilarity: nearSimilarity, farSimilarity: farSimilarity))
        }
        return results
    }

    static func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
        precondition(a.count == b.count, "vectors must be the same dimension")
        var dot: Float = 0
        var normA: Float = 0
        var normB: Float = 0
        for i in 0..<a.count {
            dot += a[i] * b[i]
            normA += a[i] * a[i]
            normB += b[i] * b[i]
        }
        let denominator = (normA.squareRoot() * normB.squareRoot())
        return denominator == 0 ? 0 : dot / denominator
    }
}
