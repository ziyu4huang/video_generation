import Foundation
import XCTest
@testable import EmbedMLXServer

final class OpenAIEmbeddingsSchemaTests: XCTestCase {
    func testDecodesSingleStringInput() throws {
        let json = #"{"model": "bge-m3", "input": "hello world"}"#.data(using: .utf8)!

        let request = try JSONDecoder().decode(EmbeddingsRequest.self, from: json)

        XCTAssertEqual(request.model, "bge-m3")
        XCTAssertEqual(request.input.texts, ["hello world"])
    }

    func testDecodesArrayInput() throws {
        let json = #"{"model": "bge-m3", "input": ["a", "b", "c"]}"#.data(using: .utf8)!

        let request = try JSONDecoder().decode(EmbeddingsRequest.self, from: json)

        XCTAssertEqual(request.input.texts, ["a", "b", "c"])
    }

    func testEncodesResponseInOpenAIShape() throws {
        let response = EmbeddingsResponse(
            object: "list",
            data: [
                EmbeddingObject(object: "embedding", embedding: [0.1, 0.2], index: 0)
            ],
            model: "bge-m3",
            usage: EmbeddingsUsage(promptTokens: 3, totalTokens: 3)
        )

        let data = try JSONEncoder().encode(response)
        let decoded = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(decoded["object"] as? String, "list")
        XCTAssertEqual(decoded["model"] as? String, "bge-m3")
        let usage = decoded["usage"] as! [String: Any]
        XCTAssertEqual(usage["prompt_tokens"] as? Int, 3)
        XCTAssertEqual(usage["total_tokens"] as? Int, 3)
        let items = decoded["data"] as! [[String: Any]]
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0]["index"] as? Int, 0)
    }

    func testErrorResponseShape() throws {
        let error = ErrorResponse(error: .init(message: "bad input", type: "invalid_request_error"))

        let data = try JSONEncoder().encode(error)
        let decoded = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let inner = decoded["error"] as! [String: Any]

        XCTAssertEqual(inner["message"] as? String, "bad input")
        XCTAssertEqual(inner["type"] as? String, "invalid_request_error")
    }
}
