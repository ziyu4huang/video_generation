# Embed MLX Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `swift/embed-mlx-server/`, a self-built Swift MLX embedding server exposing an OpenAI-compatible `POST /v1/embeddings` over BGE-M3, deployable as a macOS launchd background service.

**Architecture:** Three layers communicating only through narrow protocols/functions: `EmbeddingBackend` (protocol) → `EmbeddingEngine` (micro-batches text and calls the backend) → `HTTPServer` (Hummingbird route, JSON in/out). `MLXEmbeddingBackend` is the only file that touches MLX/BGE-M3 directly; everything else is testable with a fake backend.

**Tech Stack:** Swift 6, `mlx-swift-lm` 2.31.3 (`MLXEmbedders`), `hummingbird` 2.26.0, `swift-argument-parser` 1.5.0, `swift-transformers` (transitive, for the `Tokenizer`/`Hub` types `MLXEmbedders` itself needs).

**Design doc:** `.planning/specs/2026-08-09-embed-mlx-server-design.md`

---

## Status: COMPLETE (2026-08-09) — this is now a build record, not a spec

All 9 tasks are implemented, reviewed, and verified end-to-end (see Task 9's
recorded result at the bottom). **`swift/embed-mlx-server/README.md` is the
canonical reference from here on; the code itself is the source of truth.**

The code blocks below were kept byte-identical to the shipped source through
Task 8. A final holistic review then landed one more round of cross-cutting
fixes (commit `d8a51522`) which these blocks do **not** reflect:

- validation extended to `--micro-batch-size` / `--max-length` and added to
  `self-test`; port floor 0 → 1
- self-test pass criterion now requires a margin, not just `near > far`
- `ServerConfig` no longer imports MLXEmbedders; `MLXEmbeddingBackend.load`
  takes a plain repo string
- `OpenAIEmbeddingsSchema` no longer imports Hummingbird (the
  `ResponseCodable` conformance was never exercised)
- `PlaceholderTests.swift` deleted (19 real tests remain)

Read the actual files, not these blocks, if you need current behavior.

---

## Important: dependency version pin

This plan pins `mlx-swift-lm` to **exact `2.31.3`**, not the latest tag (`3.31.4`). This was verified directly against the tagged source trees on GitHub, not assumed:

- At `3.31.4`, `MLXEmbedders` was refactored to load models through a `Downloader`/`TokenizerLoader` protocol pair with no concrete HuggingFace-backed implementation anywhere in that tagged tree (`MLXHuggingFace` only contains a macro file). The README at that same tag references `import MLXEmbeddersHuggingFace` and `import MLXLMTokenizers` — neither exists as a declared product in that tag's `Package.swift`. This tag's public embedding-loading API does not compile as documented.
- At `2.31.3`, `MLXEmbedders` ships a simple, self-contained `loadModelContainer(configuration:) async throws -> ModelContainer` (default `HubApi`), backed directly by `huggingface/swift-transformers`'s `Hub`/`Tokenizers` modules, which are real, present dependencies. This is the version this plan's code is written against and verified line-by-line against the actual tagged source.

If a future task needs to move to 3.x, that is a separate, deliberate upgrade — not a silent `from:` version bump.

---

### Task 1: Package scaffold

**Files:**
- Create: `swift/embed-mlx-server/Package.swift`
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServer/EmbeddingBackend.swift` (placeholder, filled in Task 2)
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServerCLI/EmbedMLXServerCLI.swift`
- Create: `swift/embed-mlx-server/Tests/EmbedMLXServerTests/PlaceholderTests.swift`

- [ ] **Step 1: Create `Package.swift`**

```swift
// swift-tools-version: 6.0
//
// embed-mlx-server — self-built Swift MLX OpenAI-compatible embedding server
// (BGE-M3 via mlx-swift-lm's MLXEmbedders), deployed as a macOS launchd
// background service. See docs/superpowers/specs/2026-08-09-embed-mlx-server-design.md
// for the full design, and the Phase 0 benchmark (PR #1128) that motivated it.
//
// Pinned to mlx-swift-lm 2.31.3, NOT the latest 3.x line: 3.x introduced a
// breaking Downloader/TokenizerLoader protocol refactor whose HuggingFace-backed
// concrete implementations are not present in the tagged 3.31.4 source tree.
// 2.31.3's `loadModelContainer(configuration:)` is the last verified-working,
// self-contained convenience API — do not bump this without re-verifying
// against the target tag's actual source, not just its README.

import PackageDescription

let package = Package(
    name: "embed-mlx-server",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "embed-mlx-server", targets: ["EmbedMLXServerCLI"]),
        .library(name: "EmbedMLXServer", targets: ["EmbedMLXServer"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        .package(url: "https://github.com/ml-explore/mlx-swift-lm.git", exact: "2.31.3"),
        .package(url: "https://github.com/huggingface/swift-transformers", .upToNextMinor(from: "1.2.0")),
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", exact: "2.26.0"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
    ],
    targets: [
        .target(
            name: "EmbedMLXServer",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXEmbedders", package: "mlx-swift-lm"),
                .product(name: "Transformers", package: "swift-transformers"),
                .product(name: "Hummingbird", package: "hummingbird"),
            ],
            path: "Sources/EmbedMLXServer"
        ),
        .executableTarget(
            name: "EmbedMLXServerCLI",
            dependencies: [
                "EmbedMLXServer",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/EmbedMLXServerCLI"
        ),
        .testTarget(
            name: "EmbedMLXServerTests",
            dependencies: [
                "EmbedMLXServer",
                .product(name: "HummingbirdTesting", package: "hummingbird"),
            ],
            path: "Tests/EmbedMLXServerTests"
        ),
    ]
)
```

- [ ] **Step 2: Create a placeholder library file so the target isn't empty**

`swift/embed-mlx-server/Sources/EmbedMLXServer/EmbeddingBackend.swift`:

```swift
// Filled in by Task 2.
```

- [ ] **Step 3: Create the CLI entry point**

`swift/embed-mlx-server/Sources/EmbedMLXServerCLI/EmbedMLXServerCLI.swift`:

```swift
import ArgumentParser

@main
struct EmbedMLXServerCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "embed-mlx-server",
        abstract: "OpenAI-compatible /v1/embeddings server over BGE-M3 (native MLX).",
        version: "0.1.0",
        subcommands: []
    )
}
```

- [ ] **Step 4: Create a placeholder test so the test target isn't empty**

`swift/embed-mlx-server/Tests/EmbedMLXServerTests/PlaceholderTests.swift`:

```swift
import XCTest

final class PlaceholderTests: XCTestCase {
    func testPlaceholder() {
        XCTAssertTrue(true)
    }
}
```

- [ ] **Step 5: Build and test to verify the scaffold resolves and compiles**

Run: `( cd swift/embed-mlx-server && swift build && swift test )`
Expected: dependency resolution succeeds (this is the first real network check that `mlx-swift-lm` 2.31.3 / `hummingbird` 2.26.0 / `swift-transformers` actually resolve together), build succeeds, `PlaceholderTests` passes (1 test).

- [ ] **Step 6: Commit**

```bash
git add swift/embed-mlx-server/Package.swift swift/embed-mlx-server/Package.resolved \
  swift/embed-mlx-server/Sources swift/embed-mlx-server/Tests
git commit -m "feat(embed-mlx-server): scaffold Swift package"
```

---

### Task 2: `EmbeddingBackend` protocol + `EmbeddingEngine` micro-batching (TDD)

This is the logic that directly prevents the OOM bug found in PR #1128 (Python harness padded and ran attention over an entire 1683-item list in one call). Getting the batch split wrong here fails silently — the output still "looks like" a valid list of vectors, just wrong ones or wrong order — so this is unit tested with an injected fake backend, no real model involved.

**Files:**
- Modify: `swift/embed-mlx-server/Sources/EmbedMLXServer/EmbeddingBackend.swift`
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServer/EmbeddingEngine.swift`
- Create: `swift/embed-mlx-server/Tests/EmbedMLXServerTests/EmbeddingEngineTests.swift`

- [ ] **Step 1: Write the failing tests**

`swift/embed-mlx-server/Tests/EmbedMLXServerTests/EmbeddingEngineTests.swift`:

```swift
import Foundation
import XCTest
@testable import EmbedMLXServer

final class EmbeddingEngineTests: XCTestCase {
    /// Records the size of every micro-batch it's called with, and returns a
    /// fake embedding (just the text length) — no MLX, no model, no GPU.
    final class RecordingBackend: EmbeddingBackend {
        private let lock = NSLock()
        private var _batchSizes: [Int] = []
        var batchSizes: [Int] {
            lock.lock()
            defer { lock.unlock() }
            return _batchSizes
        }

        func embedMicroBatch(_ texts: [String]) async throws -> [[Float]] {
            lock.lock()
            _batchSizes.append(texts.count)
            lock.unlock()
            return texts.map { [Float($0.count)] }
        }
    }

    func testSplitsIntoMicroBatchesAndPreservesOrder() async throws {
        let backend = RecordingBackend()
        let engine = EmbeddingEngine(backend: backend, microBatchSize: 3)
        let texts = ["a", "bb", "ccc", "dddd", "eeeee", "f", "gg"]

        let results = try await engine.embed(texts: texts)

        XCTAssertEqual(results.map { $0[0] }, texts.map { Float($0.count) })
        XCTAssertEqual(backend.batchSizes, [3, 3, 1])
    }

    func testEmptyInputProducesNoBackendCalls() async throws {
        let backend = RecordingBackend()
        let engine = EmbeddingEngine(backend: backend, microBatchSize: 4)

        let results = try await engine.embed(texts: [])

        XCTAssertTrue(results.isEmpty)
        XCTAssertTrue(backend.batchSizes.isEmpty)
    }

    func testInputSmallerThanMicroBatchSizeIsOneBatch() async throws {
        let backend = RecordingBackend()
        let engine = EmbeddingEngine(backend: backend, microBatchSize: 32)

        _ = try await engine.embed(texts: ["only one"])

        XCTAssertEqual(backend.batchSizes, [1])
    }

    func testInputExactMultipleOfMicroBatchSizeHasNoTrailingPartialBatch() async throws {
        let backend = RecordingBackend()
        let engine = EmbeddingEngine(backend: backend, microBatchSize: 2)

        _ = try await engine.embed(texts: ["a", "b", "c", "d"])

        XCTAssertEqual(backend.batchSizes, [2, 2])
    }

    func testBackendErrorPropagates() async throws {
        struct Boom: Error {}
        final class ThrowingBackend: EmbeddingBackend {
            func embedMicroBatch(_ texts: [String]) async throws -> [[Float]] {
                throw Boom()
            }
        }
        let engine = EmbeddingEngine(backend: ThrowingBackend(), microBatchSize: 8)

        await XCTAssertThrowsErrorAsync(try await engine.embed(texts: ["x"]))
    }
}

// XCTest doesn't ship an async XCTAssertThrowsError overload; this is the
// standard workaround.
func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected an error to be thrown", file: file, line: line)
    } catch {
        // expected
    }
}
```

- [ ] **Step 2: Run tests to verify they fail (protocol/class don't exist yet)**

Run: `( cd swift/embed-mlx-server && swift test --filter EmbeddingEngineTests )`
Expected: FAIL to compile — `EmbeddingBackend` / `EmbeddingEngine` not found.

- [ ] **Step 3: Implement `EmbeddingBackend`**

`swift/embed-mlx-server/Sources/EmbedMLXServer/EmbeddingBackend.swift`:

```swift
/// A source of embeddings for a single micro-batch of text. Implementations
/// own their own internal padding/truncation for that batch only — callers
/// (`EmbeddingEngine`) are responsible for splitting large inputs into
/// micro-batches before calling this.
public protocol EmbeddingBackend: Sendable {
    func embedMicroBatch(_ texts: [String]) async throws -> [[Float]]
}
```

- [ ] **Step 4: Implement `EmbeddingEngine`**

`swift/embed-mlx-server/Sources/EmbedMLXServer/EmbeddingEngine.swift`:

```swift
/// Splits arbitrary-sized input into fixed-size micro-batches before handing
/// each one to the backend. This is a first-class requirement, not an
/// optimization: embedding an unbounded number of texts in one padded batch
/// caused a real Metal OOM (~107GB allocation attempt) in the Python
/// benchmark harness this server followed on from (PR #1128).
public final class EmbeddingEngine: Sendable {
    private let backend: any EmbeddingBackend
    private let microBatchSize: Int

    public init(backend: any EmbeddingBackend, microBatchSize: Int) {
        precondition(microBatchSize > 0, "microBatchSize must be positive")
        self.backend = backend
        self.microBatchSize = microBatchSize
    }

    public func embed(texts: [String]) async throws -> [[Float]] {
        var results: [[Float]] = []
        results.reserveCapacity(texts.count)

        var start = 0
        while start < texts.count {
            let end = min(start + microBatchSize, texts.count)
            let vectors = try await backend.embedMicroBatch(Array(texts[start..<end]))
            results.append(contentsOf: vectors)
            start = end
        }

        return results
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd swift/embed-mlx-server && swift test --filter EmbeddingEngineTests )`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add swift/embed-mlx-server/Sources/EmbedMLXServer/EmbeddingBackend.swift \
  swift/embed-mlx-server/Sources/EmbedMLXServer/EmbeddingEngine.swift \
  swift/embed-mlx-server/Tests/EmbedMLXServerTests/EmbeddingEngineTests.swift
git commit -m "feat(embed-mlx-server): add EmbeddingBackend protocol + micro-batching EmbeddingEngine"
```

---

### Task 3: OpenAI-compatible request/response schema (TDD)

**Files:**
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServer/OpenAIEmbeddingsSchema.swift`
- Create: `swift/embed-mlx-server/Tests/EmbedMLXServerTests/OpenAIEmbeddingsSchemaTests.swift`

- [ ] **Step 1: Write the failing tests**

`swift/embed-mlx-server/Tests/EmbedMLXServerTests/OpenAIEmbeddingsSchemaTests.swift`:

```swift
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd swift/embed-mlx-server && swift test --filter OpenAIEmbeddingsSchemaTests )`
Expected: FAIL to compile — types don't exist yet.

- [ ] **Step 3: Implement the schema**

`swift/embed-mlx-server/Sources/EmbedMLXServer/OpenAIEmbeddingsSchema.swift`:

```swift
import Hummingbird

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

public struct EmbeddingsResponse: Codable, ResponseCodable {
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

public struct ErrorResponse: Codable, ResponseCodable {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/embed-mlx-server && swift test --filter OpenAIEmbeddingsSchemaTests )`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add swift/embed-mlx-server/Sources/EmbedMLXServer/OpenAIEmbeddingsSchema.swift \
  swift/embed-mlx-server/Tests/EmbedMLXServerTests/OpenAIEmbeddingsSchemaTests.swift
git commit -m "feat(embed-mlx-server): add OpenAI-compatible embeddings request/response schema"
```

---

### Task 4: `MLXEmbeddingBackend` — real BGE-M3 inference

Not unit tested (would require downloading and running the real model in CI/dev). Correctness is verified in Task 7 via `--self-test`. The one piece of this file that IS pure Swift array logic with no MLX/GPU dependency — the mask-row construction — is extracted into a `static` `maskRows(lengths:batchMaxLength:)` function and unit tested directly (see below): a prior code review found this exact math buggy when it was inlined and derived from comparing against a pad token id instead of each sequence's real length.

**Files:**
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServer/MLXEmbeddingBackend.swift`
- Create: `swift/embed-mlx-server/Tests/EmbedMLXServerTests/MLXEmbeddingBackendMaskTests.swift`

- [ ] **Step 1: Implement the backend**

`swift/embed-mlx-server/Sources/EmbedMLXServer/MLXEmbeddingBackend.swift`:

```swift
import MLX
import MLXEmbedders
import Tokenizers

/// Wraps `mlx-swift-lm`'s `MLXEmbedders.ModelContainer` as an `EmbeddingBackend`.
///
/// Padding is computed independently per call to `embedMicroBatch` (never
/// across the caller's full input list) — `EmbeddingEngine` is what bounds
/// the size of each call. `maxLength` truncates before padding so a single
/// abnormally long input in a batch can't blow up every other item's
/// padded length within that same micro-batch.
public final class MLXEmbeddingBackend: EmbeddingBackend {
    private let container: ModelContainer
    private let maxLength: Int

    private init(container: ModelContainer, maxLength: Int) {
        self.container = container
        self.maxLength = maxLength
    }

    /// Loads the model once. This is the only place model loading happens —
    /// call it exactly once at process startup, before serving any requests.
    public static func load(configuration: ModelConfiguration, maxLength: Int) async throws -> MLXEmbeddingBackend {
        let container = try await loadModelContainer(configuration: configuration)
        return MLXEmbeddingBackend(container: container, maxLength: maxLength)
    }

    public func embedMicroBatch(_ texts: [String]) async throws -> [[Float]] {
        let maxLength = self.maxLength
        return await container.perform { model, tokenizer, pooling -> [[Float]] in
            let encoded = texts.map { text -> [Int] in
                var tokens = tokenizer.encode(text: text, addSpecialTokens: true)
                if tokens.count > maxLength {
                    tokens = Array(tokens.prefix(maxLength))
                }
                return tokens
            }

            let batchMaxLength = encoded.map(\.count).max() ?? 0
            let padValue = tokenizer.eosTokenId ?? 0

            let padded = stacked(
                encoded.map { tokens in
                    MLXArray(tokens + Array(repeating: padValue, count: batchMaxLength - tokens.count))
                })
            // Built from each sequence's real (pre-padding) length, NOT from
            // comparing against padValue: `tokenizer.encode` appends a real EOS
            // token to every sequence, and that EOS token's id is the same as
            // padValue — comparing against padValue would incorrectly mask out
            // every sequence's real trailing EOS token as if it were padding,
            // corrupting both self-attention and .mean/.max/.last pooling.
            let lengths = encoded.map(\.count)
            let mask = stacked(Self.maskRows(lengths: lengths, batchMaxLength: batchMaxLength).map { MLXArray($0) }) .!= 0
            let tokenTypes = MLXArray.zeros(like: padded)

            let output = model(padded, positionIds: nil, tokenTypeIds: tokenTypes, attentionMask: mask)
            let result = pooling(output, mask: mask, normalize: true, applyLayerNorm: true)
            result.eval()

            return result.map { $0.asArray(Float.self) }
        }
    }

    /// Pure mask-row math, extracted so it's unit-testable without MLX/GPU:
    /// for each sequence's real (pre-padding) length, produces a row of
    /// `true` for real-token positions and `false` for padding positions,
    /// bounded to `batchMaxLength`. This is the exact logic a prior code
    /// review found buggy when it was inlined and derived from comparing
    /// against a pad token id instead of the real length.
    static func maskRows(lengths: [Int], batchMaxLength: Int) -> [[Bool]] {
        lengths.map { length in
            Array(repeating: true, count: length) + Array(repeating: false, count: batchMaxLength - length)
        }
    }
}
```

- [ ] **Step 2: Write unit tests for the extracted `maskRows` function**

`swift/embed-mlx-server/Tests/EmbedMLXServerTests/MLXEmbeddingBackendMaskTests.swift`:

```swift
import XCTest
@testable import EmbedMLXServer

final class MLXEmbeddingBackendMaskTests: XCTestCase {
    func testLengthEqualToBatchMaxLengthIsAllTrue() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [4], batchMaxLength: 4)
        XCTAssertEqual(rows, [[true, true, true, true]])
    }

    func testLengthShorterThanBatchMaxLengthHasTruePrefixThenFalseSuffix() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [2], batchMaxLength: 5)
        XCTAssertEqual(rows, [[true, true, false, false, false]])
    }

    func testMultipleRowsAreIndependent() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [2, 4, 4], batchMaxLength: 4)
        XCTAssertEqual(rows, [
            [true, true, false, false],
            [true, true, true, true],
            [true, true, true, true],
        ])
    }

    func testZeroLengthIsAllFalse() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [0], batchMaxLength: 3)
        XCTAssertEqual(rows, [[false, false, false]])
    }

    func testEmptyLengthsProducesEmptyResult() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [], batchMaxLength: 5)
        XCTAssertTrue(rows.isEmpty)
    }
}
```

- [ ] **Step 3: Build and test to verify it compiles and the new tests pass**

Run: `( cd swift/embed-mlx-server && swift build )`
Expected: builds cleanly.

Run: `( cd swift/embed-mlx-server && swift test --filter MLXEmbeddingBackendMaskTests )`
Expected: PASS, 5 tests.

- [ ] **Step 4: Commit**

```bash
git add swift/embed-mlx-server/Sources/EmbedMLXServer/MLXEmbeddingBackend.swift \
  swift/embed-mlx-server/Tests/EmbedMLXServerTests/MLXEmbeddingBackendMaskTests.swift
git commit -m "feat(embed-mlx-server): add MLXEmbeddingBackend (real BGE-M3 inference)"
```

---

### Task 5: `HTTPServer` — `POST /v1/embeddings` route (TDD)

Tested with a real `EmbeddingEngine` wired to a fake `EmbeddingBackend` — no MLX, no model, no GPU, just HTTP routing/schema/error-code correctness via Hummingbird's own test client.

**Files:**
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServer/HTTPServer.swift`
- Create: `swift/embed-mlx-server/Tests/EmbedMLXServerTests/HTTPServerTests.swift`

- [ ] **Step 1: Write the failing tests**

`swift/embed-mlx-server/Tests/EmbedMLXServerTests/HTTPServerTests.swift`:

```swift
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd swift/embed-mlx-server && swift test --filter HTTPServerTests )`
Expected: FAIL to compile — `HTTPServer` doesn't exist yet.

- [ ] **Step 3: Implement `HTTPServer`**

`swift/embed-mlx-server/Sources/EmbedMLXServer/HTTPServer.swift`:

```swift
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/embed-mlx-server && swift test --filter HTTPServerTests )`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full test suite so far**

Run: `( cd swift/embed-mlx-server && swift test )`
Expected: PASS, all tests across `EmbeddingEngineTests`, `OpenAIEmbeddingsSchemaTests`, `HTTPServerTests`, `PlaceholderTests`.

- [ ] **Step 6: Commit**

```bash
git add swift/embed-mlx-server/Sources/EmbedMLXServer/HTTPServer.swift \
  swift/embed-mlx-server/Tests/EmbedMLXServerTests/HTTPServerTests.swift
git commit -m "feat(embed-mlx-server): add POST /v1/embeddings HTTP route"
```

---

### Task 6: `Config` + `serve` CLI command

Wires everything together into a runnable server.

**Files:**
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServer/Config.swift`
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServerCLI/Serve.swift`
- Modify: `swift/embed-mlx-server/Sources/EmbedMLXServerCLI/EmbedMLXServerCLI.swift`

- [ ] **Step 1: Implement `Config`**

`swift/embed-mlx-server/Sources/EmbedMLXServer/Config.swift`:

```swift
import MLXEmbedders

public struct ServerConfig: Sendable {
    public let port: Int
    public let modelRepo: String
    public let microBatchSize: Int
    public let maxLength: Int

    public init(port: Int, modelRepo: String, microBatchSize: Int, maxLength: Int) {
        self.port = port
        self.modelRepo = modelRepo
        self.microBatchSize = microBatchSize
        self.maxLength = maxLength
    }

    public static let defaultPort = 8090
    // NOT "BAAI/bge-m3" (MLXEmbedders' own pre-registered `.bge_m3` default):
    // that repo only ships `pytorch_model.bin`, no `.safetensors`, and this
    // library only downloads/loads safetensors — loading it fails with
    // "Key ... not found" because no weights were ever fetched. This is the
    // same MLX-converted repo the Python Phase 0 harness (PR #1128) already
    // validated (models.json's mlx_hf_repo), confirmed independently here by
    // checking its file listing has real model.safetensors + quantization
    // metadata this loader's quantize() path is built to consume.
    public static let defaultModelRepo = "mlx-community/bge-m3-mlx-8bit"
    public static let defaultMicroBatchSize = 32
    // BGE-M3's real context window (see PR #1128 — this exact value was
    // verified NOT to change recall vs. the harness's old hardcoded 512, but
    // it removes the truncation as a confound; keep it at the model's real max).
    public static let defaultMaxLength = 8192

    public var modelConfiguration: ModelConfiguration {
        .init(id: modelRepo)
    }
}
```

- [ ] **Step 2: Implement the `serve` command**

`swift/embed-mlx-server/Sources/EmbedMLXServerCLI/Serve.swift`:

```swift
import ArgumentParser
import EmbedMLXServer
import Foundation

extension EmbedMLXServerCLI {
    struct Serve: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "serve",
            abstract: "Start the OpenAI-compatible /v1/embeddings HTTP server."
        )

        @Option(help: "Port to listen on.")
        var port: Int = ServerConfig.defaultPort

        @Option(help: "HuggingFace repo id of the embedding model.")
        var model: String = ServerConfig.defaultModelRepo

        @Option(name: .customLong("micro-batch-size"), help: "Max texts embedded per MLX forward pass.")
        var microBatchSize: Int = ServerConfig.defaultMicroBatchSize

        @Option(name: .customLong("max-length"), help: "Max tokens per input before truncation.")
        var maxLength: Int = ServerConfig.defaultMaxLength

        mutating func validate() throws {
            guard (0...65535).contains(port) else {
                throw ValidationError("--port must be between 0 and 65535, got \(port).")
            }
        }

        func run() async throws {
            setbuf(stdout, nil)
            let config = ServerConfig(
                port: port, modelRepo: model, microBatchSize: microBatchSize, maxLength: maxLength)

            print("[embed-mlx-server serve] loading \(config.modelRepo)...")
            let backend = try await MLXEmbeddingBackend.load(
                configuration: config.modelConfiguration, maxLength: config.maxLength)
            let engine = EmbeddingEngine(backend: backend, microBatchSize: config.microBatchSize)
            let server = HTTPServer(engine: engine, modelName: config.modelRepo)

            try await server.run(port: config.port) {
                print("[embed-mlx-server serve] listening on 127.0.0.1:\(config.port)")
            }
        }
    }
}
```

- [ ] **Step 3: Register the subcommand**

Modify `swift/embed-mlx-server/Sources/EmbedMLXServerCLI/EmbedMLXServerCLI.swift`:

```swift
import ArgumentParser

// AsyncParsableCommand, not plain ParsableCommand: swift-argument-parser
// hard-errors at runtime ("Asynchronous subcommand of a synchronous root")
// once an AsyncParsableCommand subcommand (Serve) is registered under a
// synchronous root. Verified during Task 6's review by reverting to
// ParsableCommand and reproducing the exact error.
@main
struct EmbedMLXServerCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "embed-mlx-server",
        abstract: "OpenAI-compatible /v1/embeddings server over BGE-M3 (native MLX).",
        version: "0.1.0",
        subcommands: [Serve.self]
    )
}
```

- [ ] **Step 4: Build and run the full test suite**

Run: `( cd swift/embed-mlx-server && swift build && swift test )`
Expected: builds cleanly, all existing tests still pass (this task adds no new unit tests — `Config`/`Serve` are thin wiring, exercised for real in Task 7's self-test and Task 9's manual verification).

- [ ] **Step 5: Manually smoke-test the CLI parses (no network/model load needed for `--help`)**

Run: `( cd swift/embed-mlx-server && swift run embed-mlx-server serve --help )`
Expected: prints usage showing `--port`, `--model`, `--micro-batch-size`, `--max-length` with the defaults from `ServerConfig`.

- [ ] **Step 6: Commit**

```bash
git add swift/embed-mlx-server/Sources/EmbedMLXServer/Config.swift \
  swift/embed-mlx-server/Sources/EmbedMLXServerCLI/Serve.swift \
  swift/embed-mlx-server/Sources/EmbedMLXServerCLI/EmbedMLXServerCLI.swift
git commit -m "feat(embed-mlx-server): add ServerConfig and 'serve' CLI command"
```

---

### Task 7: `self-test` CLI command

Validates real BGE-M3 inference quality without mocking — matches this repo's existing `--self-test` convention. Boots the real backend in-process (no HTTP layer needed) and checks that known-similar sentence pairs score higher than known-dissimilar ones, in both English and Chinese (BGE-M3 must be multilingual for this repo's use case).

**Files:**
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServer/SelfTest.swift`
- Create: `swift/embed-mlx-server/Sources/EmbedMLXServerCLI/SelfTestCommand.swift`
- Modify: `swift/embed-mlx-server/Sources/EmbedMLXServerCLI/EmbedMLXServerCLI.swift`

- [ ] **Step 1: Implement the self-test logic (library side, so it's reusable/inspectable)**

`swift/embed-mlx-server/Sources/EmbedMLXServer/SelfTest.swift`:

```swift
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
    public var passed: Bool { nearSimilarity > farSimilarity }
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
```

- [ ] **Step 2: Implement the CLI command**

`swift/embed-mlx-server/Sources/EmbedMLXServerCLI/SelfTestCommand.swift`:

```swift
import ArgumentParser
import EmbedMLXServer
import Foundation

extension EmbedMLXServerCLI {
    struct SelfTestCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "self-test",
            abstract: "Boot the real model in-process and sanity-check embedding quality."
        )

        @Option(help: "HuggingFace repo id of the embedding model.")
        var model: String = ServerConfig.defaultModelRepo

        @Option(name: .customLong("max-length"), help: "Max tokens per input before truncation.")
        var maxLength: Int = ServerConfig.defaultMaxLength

        func run() async throws {
            setbuf(stdout, nil)
            let config = ServerConfig(
                port: ServerConfig.defaultPort, modelRepo: model,
                microBatchSize: ServerConfig.defaultMicroBatchSize, maxLength: maxLength)

            print("[embed-mlx-server self-test] loading \(config.modelRepo)...")
            let backend = try await MLXEmbeddingBackend.load(
                configuration: config.modelConfiguration, maxLength: config.maxLength)
            let engine = EmbeddingEngine(backend: backend, microBatchSize: config.microBatchSize)

            let results = try await SelfTest.run(engine: engine)

            var allPassed = true
            for result in results {
                let status = result.passed ? "PASS" : "FAIL"
                print(
                    "[\(status)] \(result.label): near=\(result.nearSimilarity) far=\(result.farSimilarity)")
                if !result.passed { allPassed = false }
            }

            if !allPassed {
                print("[embed-mlx-server self-test] FAILED")
                throw ExitCode.failure
            }
            print("[embed-mlx-server self-test] all cases passed")
        }
    }
}
```

- [ ] **Step 3: Register the subcommand**

Modify `swift/embed-mlx-server/Sources/EmbedMLXServerCLI/EmbedMLXServerCLI.swift`:

```swift
import ArgumentParser

// AsyncParsableCommand, not ParsableCommand: the `Serve` subcommand's `run()`
// is async, and swift-argument-parser requires the root command to be async
// too in that case (a synchronous root never calls an async subcommand's
// `run()` — it errors at runtime instead). See swift-argument-parser's
// "Asynchronous subcommand of a synchronous root" diagnostic.
@main
struct EmbedMLXServerCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "embed-mlx-server",
        abstract: "OpenAI-compatible /v1/embeddings server over BGE-M3 (native MLX).",
        version: "0.1.0",
        subcommands: [Serve.self, SelfTestCommand.self]
    )
}
```

- [ ] **Step 4: Build**

Run: `( cd swift/embed-mlx-server && swift build )`
Expected: builds cleanly.

- [ ] **Step 5: Run the real self-test (downloads BGE-M3 on first run — this is the first real, non-mocked verification of correctness)**

**Prerequisite:** SwiftPM can't compile Metal shaders (needs Xcode) — `swift run`/`swift test` will fail with "Failed to load the default metallib" unless `swift/embed-mlx-server/scripts/setup-metallib.sh` has been run at least once after the most recent `swift build`/`swift build -c release` (same known issue and fix already used by `swift/z-image-director`, `swift/krea2-image-director`, `swift/ltx-video-director`).

Run: `swift/embed-mlx-server/scripts/setup-metallib.sh` (or `setup-metallib.sh release` for a release build), then:

Run: `( cd swift/embed-mlx-server && swift run embed-mlx-server self-test )`
Expected: `[PASS] english: near=<higher> far=<lower>` and `[PASS] chinese: ...`, exits 0, prints "all cases passed". If either case FAILs, do not proceed to Task 8 — investigate the pooling/masking logic in `MLXEmbeddingBackend` before continuing (this is exactly the kind of quality bug Phase 0 spent a long time chasing).

- [ ] **Step 6: Commit**

```bash
git add swift/embed-mlx-server/Sources/EmbedMLXServer/SelfTest.swift \
  swift/embed-mlx-server/Sources/EmbedMLXServerCLI/SelfTestCommand.swift \
  swift/embed-mlx-server/Sources/EmbedMLXServerCLI/EmbedMLXServerCLI.swift
git commit -m "feat(embed-mlx-server): add 'self-test' command for real BGE-M3 quality check"
```

---

### Task 8: Deploy script + launchd wrapper + plist

**Files:**
- Create: `swift/embed-mlx-server/scripts/deploy.sh`
- Create: `swift/embed-mlx-server/scripts/embed-mlx-server-service.sh`
- Create: `swift/embed-mlx-server/scripts/com.video-generation.embed-mlx-server.plist`

- [ ] **Step 1: Create `deploy.sh`**

`swift/embed-mlx-server/scripts/deploy.sh`:

```bash
#!/bin/bash
# deploy.sh — build embed-mlx-server in release mode and install it to
# ~/proj/dist/embed-server/, the fixed path the launchd plist points at.
# Decoupled from swift/embed-mlx-server/.build/ on purpose: `swift build`
# or `swift package clean` must never break the already-running service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$HOME/proj/dist/embed-server"
VENV_METALLIB="$PACKAGE_DIR/../../../video_generation__venv/lib/python3.13/site-packages/mlx/lib/mlx.metallib"

# Validate every input BEFORE touching $DIST_DIR. A failure partway through
# would otherwise leave a half-updated deploy target (new binary, stale or
# missing metallib), which is exactly the "broken running service" this
# script's separation from .build/ exists to prevent.
#
# MLX looks for mlx.metallib colocated with the running binary (SwiftPM
# can't compile Metal shaders itself — see scripts/setup-metallib.sh, which
# does the same thing for local .build/ runs). The deployed binary needs
# its own copy for the same reason, or the launchd-run service crashes at
# startup with "Failed to load the default metallib".
if [ ! -f "$VENV_METALLIB" ]; then
    echo "error: metallib not found at $VENV_METALLIB" >&2
    echo "       is the mlx venv set up? (see scripts/setup-offline.sh, or" >&2
    echo "       'uv pip install mlx' into ../../../video_generation__venv)" >&2
    exit 1
fi

echo "Building embed-mlx-server (release)..."
( cd "$PACKAGE_DIR" && swift build -c release --product embed-mlx-server )

mkdir -p "$DIST_DIR"

# Copy to a temp name then mv into place: mv within one filesystem is atomic
# and swaps the directory entry, so a currently-RUNNING service keeps its old
# inode and is never handed a half-written executable.
# `cp` already carries the source's mode bits over to the new temp file, so
# the binary stays executable and the metallib stays plain data.
install_atomically() {
    local src="$1" dest="$2"
    cp "$src" "$dest.tmp"
    mv -f "$dest.tmp" "$dest"
}

install_atomically "$PACKAGE_DIR/.build/release/embed-mlx-server" "$DIST_DIR/embed-mlx-server"
install_atomically "$VENV_METALLIB" "$DIST_DIR/mlx.metallib"

echo "Deployed to $DIST_DIR/embed-mlx-server (+ mlx.metallib)"
echo "Restart the service to pick up the new binary:"
echo "  $SCRIPT_DIR/embed-mlx-server-service.sh restart"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x swift/embed-mlx-server/scripts/deploy.sh`

- [ ] **Step 3: Create the launchctl wrapper**

`swift/embed-mlx-server/scripts/embed-mlx-server-service.sh` (modeled directly on `scripts/surreal-service.sh`):

```bash
#!/bin/bash
# Thin launchctl wrapper around the manually-installed
# ~/Library/LaunchAgents/com.video-generation.embed-mlx-server.plist LaunchAgent.
set -euo pipefail

LABEL="com.video-generation.embed-mlx-server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
TARGET="${DOMAIN}/${LABEL}"
LOG_FILE="$HOME/proj/dist/embed-server/embed-mlx-server.log"

usage() {
    cat <<EOF
Usage: $(basename "$0") <start|stop|restart|status|log>

Manages the embed-mlx-server LaunchAgent ($PLIST) via launchctl.
EOF
}

require_plist() {
    if [[ ! -f "$PLIST" ]]; then
        echo "Error: $PLIST not found. Copy scripts/com.video-generation.embed-mlx-server.plist there first." >&2
        exit 1
    fi
}

is_loaded() {
    launchctl print "$TARGET" >/dev/null 2>&1
}

case "${1:-}" in
    start)
        require_plist
        if is_loaded; then
            echo "$LABEL already loaded"
        else
            launchctl bootstrap "$DOMAIN" "$PLIST"
            echo "Started $LABEL"
        fi
        ;;
    stop)
        if is_loaded; then
            launchctl bootout "$TARGET"
            echo "Stopped $LABEL"
        else
            echo "$LABEL not loaded"
        fi
        ;;
    restart)
        require_plist
        if is_loaded; then
            launchctl kickstart -k "$TARGET"
        else
            launchctl bootstrap "$DOMAIN" "$PLIST"
        fi
        echo "Restarted $LABEL"
        ;;
    status)
        if is_loaded; then
            launchctl print "$TARGET" | grep -E "state = |pid = "
        else
            echo "Not loaded"
        fi
        ;;
    log)
        tail -n "${2:-50}" -f "$LOG_FILE"
        ;;
    *)
        usage
        exit 1
        ;;
esac
```

- [ ] **Step 4: Make it executable**

Run: `chmod +x swift/embed-mlx-server/scripts/embed-mlx-server-service.sh`

- [ ] **Step 5: Create the plist**

`swift/embed-mlx-server/scripts/com.video-generation.embed-mlx-server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.video-generation.embed-mlx-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/huangziyu/proj/dist/embed-server/embed-mlx-server</string>
        <string>serve</string>
        <string>--port</string>
        <string>8090</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/huangziyu/proj/dist/embed-server/embed-mlx-server.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/huangziyu/proj/dist/embed-server/embed-mlx-server.log</string>
</dict>
</plist>
```

- [ ] **Step 6: Validate the plist is well-formed**

Run: `plutil -lint swift/embed-mlx-server/scripts/com.video-generation.embed-mlx-server.plist`
Expected: `... OK`

- [ ] **Step 7: Commit**

```bash
git add swift/embed-mlx-server/scripts/deploy.sh \
  swift/embed-mlx-server/scripts/embed-mlx-server-service.sh \
  swift/embed-mlx-server/scripts/com.video-generation.embed-mlx-server.plist
git commit -m "feat(embed-mlx-server): add deploy script + launchd wrapper + plist"
```

---

### Task 9: Manual end-to-end verification (not automated)

This is the launchd integration check the spec explicitly scoped as manual, not automated. Run these steps yourself after Task 8 lands; each is a checkable command with an expected result.

- [ ] **Step 1: Deploy the release binary**

Run: `swift/embed-mlx-server/scripts/deploy.sh`
Expected: ends with `Deployed to /Users/<you>/proj/dist/embed-server/embed-mlx-server`.

- [ ] **Step 2: Install the plist**

Run: `cp swift/embed-mlx-server/scripts/com.video-generation.embed-mlx-server.plist ~/Library/LaunchAgents/`

If your home directory isn't `/Users/huangziyu`, edit the two absolute paths in the copied plist first (`ProgramArguments`'s first string, and both `*Path` keys) before starting the service.

- [ ] **Step 3: Start the service**

Run: `swift/embed-mlx-server/scripts/embed-mlx-server-service.sh start`
Expected: `Started com.video-generation.embed-mlx-server`.

- [ ] **Step 4: Check status and tail the log until the model finishes loading**

Run: `swift/embed-mlx-server/scripts/embed-mlx-server-service.sh status`
Expected: shows `state = running` and a `pid = <number>`.

Run: `swift/embed-mlx-server/scripts/embed-mlx-server-service.sh log`
Expected: eventually shows `[embed-mlx-server serve] listening on 127.0.0.1:8090`. Ctrl-C to stop tailing.

- [ ] **Step 5: Send a real request**

Run:
```bash
curl -s http://127.0.0.1:8090/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model": "bge-m3", "input": ["hello world", "你好世界"]}' | python3 -m json.tool | head -20
```
Expected: valid JSON with `"object": "list"`, `"data"` containing two objects each with a 1024-dimensional `"embedding"` array (BGE-M3's dense output size) and `"index"` 0 and 1.

- [ ] **Step 6: Verify error handling doesn't crash the service**

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/v1/embeddings -d 'not json'`
Expected: `400`

Run: `swift/embed-mlx-server/scripts/embed-mlx-server-service.sh status` again
Expected: still `state = running` — the bad request must not have crashed the process.

- [ ] **Step 7: Verify the service survives a rebuild**

Run: `( cd swift/embed-mlx-server && swift build )` (a plain dev build, not `deploy.sh`)
Run: `swift/embed-mlx-server/scripts/embed-mlx-server-service.sh status`
Expected: still `state = running` — the running service must be unaffected by `.build/` changes, since the plist points at `~/proj/dist/embed-server/`, not `.build/`.

- [ ] **Step 8: Stop the service (leave it stopped unless you want it running permanently right now)**

Run: `swift/embed-mlx-server/scripts/embed-mlx-server-service.sh stop`
Expected: `Stopped com.video-generation.embed-mlx-server`.

- [ ] **Step 9: Record the result**

If all steps passed, the Phase 1 implementation is complete and verified end-to-end. If any step failed, do not consider Phase 1 done — file what broke before moving on.

**Result (2026-08-09): all 9 steps PASSED.**

- Deploy produced a 755 binary + 644 `mlx.metallib` in `~/proj/dist/embed-server/`.
- launchd started the service; log showed Hummingbird's own bind line
  followed by `[embed-mlx-server serve] listening on 127.0.0.1:8090` — confirming
  the Task 6 `onServerRunning` ordering fix behaves correctly in production
  (the readiness line is no longer printed before the socket is actually bound).
- Real request `{"input": ["hello world", "你好世界"]}` returned
  `object: list`, 2 items, **1024-dim** embeddings each, indices 0/1 — correct
  OpenAI shape, and multilingual output confirmed on the real service.
- Malformed JSON → 400, empty `input` array → 400, and the process survived
  both (same pid throughout, never crashed).
- A plain `swift build` left the running service untouched (same pid, still
  serving) — the `.build/`-vs-`~/proj/dist/` decoupling works as designed.
- Service stopped cleanly; port 8090 released; `status` reports `Not loaded`.

Known limitation (spec'd, not a defect): `usage.prompt_tokens`/`total_tokens`
are hardcoded to 0. The plan never wired real token accounting, and no
consumer in this repo reads those fields. Worth revisiting only if a client
that bills/limits on reported usage is ever pointed at this server.

Note: the plist remains installed at
`~/Library/LaunchAgents/com.video-generation.embed-mlx-server.plist`, so with
`RunAtLoad: true` the service **will start automatically at next login** even
though it is stopped now. To opt out entirely, remove that file.
