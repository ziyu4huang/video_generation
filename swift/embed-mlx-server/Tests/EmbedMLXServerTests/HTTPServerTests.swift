import Foundation
import XCTest
import Hummingbird
import HummingbirdTesting
import NIOCore
@testable import EmbedMLXServer

final class HTTPServerTests: XCTestCase {
    final class FakeBackend: EmbeddingBackend {
        func embedMicroBatch(_ texts: [String]) async throws -> [[Float]] {
            texts.map { [Float($0.count), 0.5] }
        }
    }

    final class ThrowingBackend: EmbeddingBackend {
        struct Boom: Error {}
        func embedMicroBatch(_ texts: [String]) async throws -> [[Float]] {
            throw Boom()
        }
    }

    private func makeServer(backend: EmbeddingBackend) -> HTTPServer {
        let engine = EmbeddingEngine(backend: backend, microBatchSize: 32)
        return HTTPServer(engine: engine, modelName: "bge-m3")
    }

    func testEmbedsStringInput() async throws {
        let server = makeServer(backend: FakeBackend())
        let app = Application(router: server.router)

        try await app.test(.router) { client in
            let body = #"{"model": "bge-m3", "input": "hello"}"#
            try await client.execute(
                uri: "/v1/embeddings", method: .post,
                body: ByteBuffer(string: body)
            ) { response in
                XCTAssertEqual(response.status, .ok)
                let decoded = try JSONDecoder().decode(EmbeddingsResponse.self, from: response.body)
                XCTAssertEqual(decoded.object, "list")
                XCTAssertEqual(decoded.model, "bge-m3")
                XCTAssertEqual(decoded.data.count, 1)
                XCTAssertEqual(decoded.data[0].embedding, [5, 0.5])
                XCTAssertEqual(decoded.data[0].index, 0)
            }
        }
    }

    func testEmbedsArrayInputPreservingIndexOrder() async throws {
        let server = makeServer(backend: FakeBackend())
        let app = Application(router: server.router)

        try await app.test(.router) { client in
            let body = #"{"model": "bge-m3", "input": ["a", "bb", "ccc"]}"#
            try await client.execute(
                uri: "/v1/embeddings", method: .post,
                body: ByteBuffer(string: body)
            ) { response in
                XCTAssertEqual(response.status, .ok)
                let decoded = try JSONDecoder().decode(EmbeddingsResponse.self, from: response.body)
                XCTAssertEqual(decoded.data.map(\.index), [0, 1, 2])
                XCTAssertEqual(decoded.data.map { $0.embedding[0] }, [1, 2, 3])
            }
        }
    }

    func testMalformedJSONReturns400() async throws {
        let server = makeServer(backend: FakeBackend())
        let app = Application(router: server.router)

        try await app.test(.router) { client in
            try await client.execute(
                uri: "/v1/embeddings", method: .post,
                body: ByteBuffer(string: "not json")
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
                let decoded = try JSONDecoder().decode(ErrorResponse.self, from: response.body)
                XCTAssertEqual(decoded.error.type, "invalid_request_error")
            }
        }
    }

    func testEmptyArrayInputReturns400() async throws {
        let server = makeServer(backend: FakeBackend())
        let app = Application(router: server.router)

        try await app.test(.router) { client in
            let body = #"{"model": "bge-m3", "input": []}"#
            try await client.execute(
                uri: "/v1/embeddings", method: .post,
                body: ByteBuffer(string: body)
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
            }
        }
    }

    func testBackendFailureReturns500NotACrash() async throws {
        let server = makeServer(backend: ThrowingBackend())
        let app = Application(router: server.router)

        try await app.test(.router) { client in
            let body = #"{"model": "bge-m3", "input": "hello"}"#
            try await client.execute(
                uri: "/v1/embeddings", method: .post,
                body: ByteBuffer(string: body)
            ) { response in
                XCTAssertEqual(response.status, .internalServerError)
                let decoded = try JSONDecoder().decode(ErrorResponse.self, from: response.body)
                XCTAssertEqual(decoded.error.type, "internal_error")
            }
        }
    }
}
