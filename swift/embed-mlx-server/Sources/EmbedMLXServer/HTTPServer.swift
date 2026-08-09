import Foundation
import Hummingbird
import NIOCore

public struct HTTPServer: @unchecked Sendable {
    public let router: Router<BasicRequestContext>

    public init(engine: EmbeddingEngine, modelName: String) {
        let router = Router()
        router.post("/v1/embeddings") { request, context -> Response in
            try await Self.handleEmbeddings(
                request: request, context: context, engine: engine, modelName: modelName)
        }
        self.router = router
    }

    public func run(port: Int, onReady: @escaping @Sendable () async -> Void = {}) async throws {
        let app = Application(
            router: router,
            configuration: .init(address: .hostname("127.0.0.1", port: port)),
            onServerRunning: { _ in await onReady() }
        )
        try await app.runService()
    }

    private static func handleEmbeddings(
        request: Request,
        context: BasicRequestContext,
        engine: EmbeddingEngine,
        modelName: String
    ) async throws -> Response {
        let requestBody: EmbeddingsRequest
        do {
            requestBody = try await request.decode(as: EmbeddingsRequest.self, context: context)
        } catch {
            context.logger.error("embeddings request decode failed", error: error)
            return try errorResponse(
                .badRequest, message: "request body is not valid JSON for the OpenAI embeddings schema")
        }

        let texts = requestBody.input.texts
        guard !texts.isEmpty else {
            return try errorResponse(.badRequest, message: "input must contain at least one string")
        }

        let vectors: [[Float]]
        do {
            vectors = try await engine.embed(texts: texts)
        } catch {
            context.logger.error("embedding inference failed", error: error)
            return try errorResponse(
                .internalServerError, message: "embedding inference failed", type: "internal_error")
        }

        let data = vectors.enumerated().map { index, embedding in
            EmbeddingObject(object: "embedding", embedding: embedding, index: index)
        }
        let response = EmbeddingsResponse(
            object: "list",
            data: data,
            model: modelName,
            usage: EmbeddingsUsage(promptTokens: 0, totalTokens: 0)
        )
        return try jsonResponse(.ok, body: response)
    }

    private static func jsonResponse(_ status: HTTPResponse.Status, body: some Encodable) throws -> Response {
        let data = try JSONEncoder().encode(body)
        return Response(
            status: status,
            headers: [.contentType: "application/json"],
            body: .init(byteBuffer: ByteBuffer(bytes: data))
        )
    }

    private static func errorResponse(
        _ status: HTTPResponse.Status, message: String, type: String = "invalid_request_error"
    ) throws -> Response {
        try jsonResponse(status, body: ErrorResponse(error: .init(message: message, type: type)))
    }
}
