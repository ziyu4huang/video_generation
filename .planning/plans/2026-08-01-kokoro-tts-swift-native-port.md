# Kokoro TTS Swift-Native Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `run.py tts --engine mlx` (local Kokoro-82M TTS) off Python by wiring `swift/musicgen-director`'s already-resolved `mlx-audio-swift` dependency's existing `MLXAudioTTS`/Kokoro implementation into a new `kokoro-tts` CLI binary, then bridge it into `bun-apps/pi-agent-ext-movie-director` as a genuinely opt-in provider (never the default `tts` pick) covering English and Mandarin voices.

**Architecture:** A new `kokoro-tts` executable target lives inside the existing `swift/musicgen-director` Swift package (shares its already-resolved `mlx-audio-swift` SPM checkout — no new package). It's a thin wrapper: `TTS.loadModel(modelRepo:)` → `model.generate(text:voice:...)` → write WAV. On the TS side, `kokoro_tts_native.ts` (mirroring `music_native.ts`'s `ensureBinary()`/spawn pattern) calls the compiled binary. `registry.ts` gets a new `kokoro_tts` provider with a new `optIn: true` flag; `selector.ts` is extended to exclude `optIn` entries from its bare backend-rank fallback so this ships without changing `say`/`edge-tts`'s existing default behavior for the `tts` capability.

**Tech Stack:** Swift 6 / MLX Swift / `mlx-audio-swift` (`MLXAudioTTS` product, Kokoro-82M model), `swift-argument-parser` (`AsyncParsableCommand`), Bun/TypeScript.

---

## Reference: full spec

`docs/superpowers/specs/2026-08-01-kokoro-tts-swift-native-port-design.md` — read it before starting if anything below is ambiguous.

## Reference: Kokoro's Swift API (mlx-audio-swift 0.1.3, already vendored)

```swift
// TTS.loadModel — Sources/MLXAudioTTS/TTSModel.swift
public enum TTS {
    public static func loadModel(
        modelRepo: String,
        textProcessor: TextProcessor? = nil,
        hfToken: String? = nil,
        cache: HubCache = .default
    ) async throws -> SpeechGenerationModel
}

// SpeechGenerationModel — Sources/MLXAudioTTS/Generation.swift
public protocol SpeechGenerationModel: AnyObject {
    var sampleRate: Int { get }
    var defaultGenerationParameters: GenerateParameters { get }
    func generate(text: String, voice: String?, refAudio: MLXArray?, refText: String?, language: String?, generationParameters: GenerateParameters) async throws -> MLXArray
}
public extension SpeechGenerationModel {
    // convenience overload — generationParameters defaults to defaultGenerationParameters
    func generate(text: String, voice: String?, refAudio: MLXArray?, refText: String?, language: String?, generationParameters: GenerateParameters? = nil) async throws -> MLXArray
}

// KokoroModel — Sources/MLXAudioTTS/Models/StyleTTS2/Kokoro/KokoroModel.swift
public final class KokoroModel: Module, SpeechGenerationModel, @unchecked Sendable {
    public var speed: Float = 1.0   // NOT a generate() parameter — set on the instance before calling generate()
}
```

`modelRepo: "mlx-community/Kokoro-82M-bf16"` auto-infers `modelType: "kokoro"` from the repo name (`TTS.inferModelType`). `language: nil` auto-detects from the voice-id prefix (`af_`/`am_` → English, `zf_`/`zm_` → Mandarin) — confirmed in the package's own `Kokoro/README.md`. `refAudio`/`refText` are for voice-cloning models Kokoro doesn't use — always pass `nil`.

---

### Task 1: Swift package plumbing — `MLXAudioTTS` product + `kokoro-tts` executable scaffold

**Files:**
- Modify: `swift/musicgen-director/Package.swift`
- Create: `swift/musicgen-director/Sources/KokoroTTSCLI/KokoroTTSCLI.swift`

- [ ] **Step 1: Add the `kokoro-tts` executable product**

In `swift/musicgen-director/Package.swift`, add to the `products` array (after the existing `musicgen` executable):

```swift
        .executable(name: "musicgen", targets: ["MusicGenDirectorCLI"]),
        .executable(name: "kokoro-tts", targets: ["KokoroTTSCLI"]),
        .library(name: "MusicGenDirector", targets: ["MusicGenDirector"]),
```

- [ ] **Step 2: Add the `KokoroTTSCLI` target**

In the same file's `targets` array, add a new target (this does NOT touch the existing `MusicGenDirector`/`MusicGenDirectorCLI` targets at all — `KokoroTTSCLI` depends directly on `mlx-audio-swift`'s `MLXAudioTTS` product, not on `MusicGenDirector`):

```swift
        .executableTarget(
            name: "KokoroTTSCLI",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/KokoroTTSCLI"
        ),
```

- [ ] **Step 3: Write the minimal top-level command**

Create `swift/musicgen-director/Sources/KokoroTTSCLI/KokoroTTSCLI.swift`:

```swift
//
//  KokoroTTSCLI.swift
//  KokoroTTSCLI
//
//  `kokoro-tts` — local text-to-speech via Kokoro-82M, wiring
//  mlx-audio-swift's existing MLXAudioTTS/Kokoro implementation (this repo
//  writes no new model code — see docs/superpowers/specs/2026-08-01-kokoro-
//  tts-swift-native-port-design.md).
//

import ArgumentParser

@main
struct KokoroTTSCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "kokoro-tts",
        abstract: "Local text-to-speech via Kokoro-82M (pure Swift MLX, via mlx-audio-swift).",
        version: "0.1.0",
        subcommands: [Generate.self]
    )
}
```

- [ ] **Step 4: Verify the package resolves and builds (empty `generate` subcommand not yet defined — expect a build error naming it)**

Run: `swift build --package-path swift/musicgen-director -c debug 2>&1 | tail -30`
Expected: FAIL — `error: cannot find type 'Generate' in scope` (or similar) referencing `KokoroTTSCLI.swift`'s `subcommands: [Generate.self]`. This confirms the product/target/dependency wiring itself resolved correctly (SPM fetched `MLXAudioTTS` successfully) — the only remaining error is the not-yet-written `Generate` command from Task 2.

- [ ] **Step 5: Commit**

```bash
git add swift/musicgen-director/Package.swift swift/musicgen-director/Sources/KokoroTTSCLI/KokoroTTSCLI.swift
git commit -m "feat(kokoro-tts): scaffold kokoro-tts executable target in musicgen-director"
```

---

### Task 2: `kokoro-tts generate` command

**Files:**
- Create: `swift/musicgen-director/Sources/KokoroTTSCLI/GenerateCommand.swift`

- [ ] **Step 1: Write the command**

Create `swift/musicgen-director/Sources/KokoroTTSCLI/GenerateCommand.swift`:

```swift
//
//  GenerateCommand.swift
//  KokoroTTSCLI
//
//  `kokoro-tts generate` — synthesize speech from text via local Kokoro-82M.
//

import ArgumentParser
import MLXAudioTTS
import MLX
import Foundation

extension KokoroTTSCLI {
    struct Generate: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "generate",
            abstract: "Synthesize speech from text via local Kokoro-82M."
        )

        @Option(help: "Narration text.")
        var text: String

        @Option(help: "Kokoro voice id (e.g. af_heart, am_michael, zf_xiaobei, zm_yunjian).")
        var voice: String

        @Option(help: "Output .wav path.")
        var output: String

        @Option(help: "Speech speed multiplier.")
        var speed: Float = 1.0

        @Option(help: "mlx-audio-swift model repo id.")
        var modelRepo: String = "mlx-community/Kokoro-82M-bf16"

        func run() async throws {
            setbuf(stdout, nil)
            print("[kokoro-tts generate] loading \(modelRepo)...")
            let model = try await TTS.loadModel(modelRepo: modelRepo)
            if let kokoro = model as? KokoroModel {
                kokoro.speed = speed
            }

            print("[kokoro-tts generate] synthesizing (\(text.count) chars, voice=\(voice))...")
            let t0 = Date()
            let waveform = try await model.generate(
                text: text, voice: voice, refAudio: nil, refText: nil, language: nil
            )
            let elapsed = Date().timeIntervalSince(t0)

            try Self.writeWav(waveform: waveform, sampleRate: model.sampleRate, to: output)
            let attrs = try? FileManager.default.attributesOfItem(atPath: output)
            let size = (attrs?[.size] as? Int) ?? 0
            print("[kokoro-tts generate] done in \(String(format: "%.1f", elapsed))s -> \(output) (\(size) bytes)")
        }

        // Mirrors MusicGenDirectorCLI/GenerateCommand.swift's writeWav exactly
        // (16-bit PCM mono WAV) — small, self-contained, not worth sharing
        // across two independent CLI targets for one ~25-line helper.
        private static func writeWav(waveform: MLXArray, sampleRate: Int, to path: String) throws {
            let samples: [Float] = waveform.asArray(Float.self)
            var data = Data()
            func appendLE(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
            func appendLE16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }

            let numSamples = samples.count
            let byteRate = sampleRate * 2
            data.append(contentsOf: "RIFF".utf8)
            appendLE(UInt32(36 + numSamples * 2))
            data.append(contentsOf: "WAVE".utf8)
            data.append(contentsOf: "fmt ".utf8)
            appendLE(16)
            appendLE16(1)          // PCM
            appendLE16(1)          // mono
            appendLE(UInt32(sampleRate))
            appendLE(UInt32(byteRate))
            appendLE16(2)          // block align
            appendLE16(16)         // bits per sample
            data.append(contentsOf: "data".utf8)
            appendLE(UInt32(numSamples * 2))
            for s in samples {
                let clamped = max(-1.0, min(1.0, s))
                appendLE16(UInt16(bitPattern: Int16(clamped * 32767.0)))
            }
            let outDir = (path as NSString).deletingLastPathComponent
            if !outDir.isEmpty {
                try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
            }
            try data.write(to: URL(fileURLWithPath: path))
        }
    }
}
```

- [ ] **Step 2: Build**

Run: `swift build --package-path swift/musicgen-director -c debug 2>&1 | tail -30`
Expected: PASS (no errors). This only compiles — it does not run a real generation yet (that needs network egress to download Kokoro-82M-bf16 on first use, covered in Task 3).

- [ ] **Step 3: Commit**

```bash
git add swift/musicgen-director/Sources/KokoroTTSCLI/GenerateCommand.swift
git commit -m "feat(kokoro-tts): implement generate command (TTS.loadModel -> generate -> WAV)"
```

---

### Task 3: Real generation verification — English + Mandarin

**Files:**
- Create: `swift/musicgen-director/Tests/KokoroTTSCLITests/KokoroGenerationTests.swift`
- Modify: `swift/musicgen-director/Package.swift`

This is the test that actually proves the port works — not just that it compiles. It calls the same `MLXAudioTTS` library API the CLI wraps (not the compiled binary itself — no need for a release build in CI, and this exercises the identical code path since `GenerateCommand.run()` is a thin pass-through).

**Needs network egress** (HuggingFace Hub download of `mlx-community/Kokoro-82M-bf16` weights +, for the Mandarin case, the ByT5 neural G2P model) **on first run only** — subsequent runs hit the local HF cache. If this environment has no network access, skip running this task's tests and note it in the task's completion report; do not silently mark the task done without running them at least once somewhere with network access before merging.

- [ ] **Step 1: Add the test target**

In `swift/musicgen-director/Package.swift`, add to `targets`:

```swift
        .testTarget(
            name: "KokoroTTSCLITests",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
            ],
            path: "Tests/KokoroTTSCLITests"
        ),
```

- [ ] **Step 2: Write the failing tests**

Create `swift/musicgen-director/Tests/KokoroTTSCLITests/KokoroGenerationTests.swift`:

```swift
import XCTest
import MLX
@testable import MLXAudioTTS

final class KokoroGenerationTests: XCTestCase {
    private static let modelRepo = "mlx-community/Kokoro-82M-bf16"

    func testEnglishVoiceGeneratesNonEmptyAudio() async throws {
        let model = try await TTS.loadModel(modelRepo: Self.modelRepo)
        let waveform = try await model.generate(
            text: "Hello from Kokoro.", voice: "af_heart",
            refAudio: nil, refText: nil, language: nil
        )
        let samples: [Float] = waveform.asArray(Float.self)
        XCTAssertGreaterThan(samples.count, 0, "English generation produced zero samples")
        XCTAssertGreaterThan(model.sampleRate, 0)
        // At least some non-silent signal — not just a zeroed buffer.
        let maxAbs = samples.map { abs($0) }.max() ?? 0
        XCTAssertGreaterThan(maxAbs, 0.001, "English generation looks silent (max abs sample \(maxAbs))")
    }

    func testMandarinVoiceGeneratesNonEmptyAudio() async throws {
        let model = try await TTS.loadModel(modelRepo: Self.modelRepo)
        let waveform = try await model.generate(
            text: "你好，這是一段測試語音。", voice: "zf_xiaobei",
            refAudio: nil, refText: nil, language: nil
        )
        let samples: [Float] = waveform.asArray(Float.self)
        XCTAssertGreaterThan(samples.count, 0, "Mandarin generation produced zero samples — check the ByT5 G2P path loaded")
        let maxAbs = samples.map { abs($0) }.max() ?? 0
        XCTAssertGreaterThan(maxAbs, 0.001, "Mandarin generation looks silent (max abs sample \(maxAbs))")
    }
}
```

- [ ] **Step 3: Run the tests**

Run: `swift test --package-path swift/musicgen-director --filter KokoroTTSCLITests 2>&1 | tail -60`
Expected: PASS for both tests. First run is slow (model download + ByT5 G2P download for the Mandarin case — budget several minutes and real network egress). If `testMandarinVoiceGeneratesNonEmptyAudio` fails specifically (English passes, Mandarin doesn't), that is the exact signal the spec called out as the real risk (the ByT5 G2P path) — do not treat it as a flake, investigate `KokoroMultilingualProcessor`'s language resolution for the `zf_`/`zm_` prefixes before proceeding.

- [ ] **Step 4: Commit**

```bash
git add swift/musicgen-director/Package.swift swift/musicgen-director/Tests/KokoroTTSCLITests/KokoroGenerationTests.swift
git commit -m "test(kokoro-tts): verify real English + Mandarin generation via MLXAudioTTS"
```

---

### Task 4: TS binary resolver — `kokoro_binary.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/kokoro_binary.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/kokoro_binary.test.ts`

`musicgen_binary.ts`'s `ensureBinary()` is hardcoded to the `musicgen` binary name and `MUSICGEN_BIN`/`MUSICGEN_REPO_ROOT` env vars — not reusable as-is for a second binary in the same Swift package. This mirrors that file's exact shape for `kokoro-tts` instead of generalizing the shipped, already-tested `musicgen_binary.ts` (smaller blast radius; the two are independent from the TS side even though they share a Swift package).

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-movie-director/src/kokoro_binary.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { defaultBinaryPath, resolveRepoRoot } from "./kokoro_binary.ts";
import { join } from "node:path";

describe("kokoro_binary path resolution", () => {
  it("defaultBinaryPath points at swift/musicgen-director/.build/release/kokoro-tts", () => {
    const repoRoot = "/fake/repo";
    expect(defaultBinaryPath(repoRoot)).toBe(
      join(repoRoot, "swift", "musicgen-director", ".build", "release", "kokoro-tts"),
    );
  });

  it("resolveRepoRoot finds the real repo root from this file's location", () => {
    // This module lives inside the real repo checkout, so resolveRepoRoot()
    // must find swift/musicgen-director/Package.swift walking up from here —
    // same invariant musicgen_binary.test.ts relies on implicitly via
    // ensureBinary() in music_native.test.ts's integration paths.
    const root = resolveRepoRoot();
    expect(root.endsWith("video_generation__director") || root.length > 0).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/kokoro_binary.test.ts )`
Expected: FAIL — `Cannot find module './kokoro_binary.ts'`.

- [ ] **Step 3: Write the implementation**

Create `bun-apps/pi-agent-ext-movie-director/src/kokoro_binary.ts`:

```typescript
/**
 * kokoro_binary.ts — resolve + auto-build the `kokoro-tts` Swift CLI.
 *
 * The binary lives at <repoRoot>/swift/musicgen-director/.build/release/kokoro-tts
 * — same Swift PACKAGE as `musicgen` (see swift/musicgen-director/Package.swift's
 * KokoroTTSCLI target), but a distinct binary/product, hence a distinct resolver
 * rather than generalizing the already-shipped musicgen_binary.ts (see
 * kokoro_tts_native.ts's header for why).
 *
 * Mirrors musicgen_binary.ts's shape exactly (env-var names swapped
 * KOKORO_BIN/KOKORO_REPO_ROOT for MUSICGEN_BIN/MUSICGEN_REPO_ROOT).
 */
import { dirname, join, resolve as pResolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

export interface ProgressFn {
  (update: { kind: "progress"; text: string }): void;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

let _cachedBin: string | null = null;

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "swift", "musicgen-director", "Package.swift"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveRepoRoot(): string {
  if (process.env.KOKORO_REPO_ROOT) return pResolve(process.env.KOKORO_REPO_ROOT);
  const here: string =
    (import.meta as any).dir ?? (typeof __dirname === "string" ? __dirname : process.cwd());
  const found = findRepoRoot(here);
  if (!found) {
    throw new Error(
      "pi-agent-ext-movie-director: cannot locate repo root (swift/musicgen-director not found).\n" +
        "Set KOKORO_REPO_ROOT to the repo root, or KOKORO_BIN to the kokoro-tts binary.",
    );
  }
  return found;
}

export function defaultBinaryPath(repoRoot: string): string {
  return join(repoRoot, "swift", "musicgen-director", ".build", "release", "kokoro-tts");
}

export function resolveBinaryPath(): string {
  if (process.env.KOKORO_BIN && existsSync(process.env.KOKORO_BIN)) {
    return pResolve(process.env.KOKORO_BIN);
  }
  return defaultBinaryPath(resolveRepoRoot());
}

export async function buildBinary(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const pkgPath = join(repoRoot, "swift", "musicgen-director");
  onProgress?.({ kind: "progress", text: "kokoro-tts binary missing — building (swift build -c release, ~minutes)…" });
  await new Promise<void>((resolveP, rejectP) => {
    const proc = spawn("swift", ["build", "-c", "release", "--product", "kokoro-tts", "--package-path", pkgPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lineBuf = { out: "", err: "" };
    const handle = (stream: NodeJS.ReadableStream, key: "out" | "err") => {
      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        lineBuf[key] += text;
        let nl: number;
        while ((nl = lineBuf[key].indexOf("\n")) >= 0) {
          const line = lineBuf[key].slice(0, nl).trim();
          lineBuf[key] = lineBuf[key].slice(nl + 1);
          if (line) onProgress?.({ kind: "progress", text: line });
        }
      });
    };
    handle(proc.stdout!, "out");
    handle(proc.stderr!, "err");
    proc.on("error", (err) => rejectP(new Error(`swift build failed to spawn: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        onProgress?.({ kind: "progress", text: "kokoro-tts build complete." });
        resolveP();
      } else {
        const tail = (lineBuf.out + lineBuf.err).slice(-2000);
        rejectP(new Error(`swift build exited ${code}\n${tail}`));
      }
    });
  });
  await buildMetallib(repoRoot, onProgress);
}

/** Build mlx.metallib and place it next to the kokoro-tts binary. Idempotent, best-effort. */
export async function buildMetallib(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const script = join(repoRoot, "swift", "musicgen-director", "scripts", "build-metallib.sh");
  if (!existsSync(script)) return;
  onProgress?.({ kind: "progress", text: "building mlx.metallib (Metal shaders)…" });
  await new Promise<void>((resolveP) => {
    const proc = spawn("bash", [script], { stdio: ["ignore", "pipe", "pipe"] });
    proc.on("error", () => resolveP());
    proc.on("close", () => resolveP());
  });
}

function newestSourceMtimeMs(repoRoot: string): number {
  const sourcesDir = join(repoRoot, "swift", "musicgen-director", "Sources", "KokoroTTSCLI");
  let newest = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".swift") && stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  };
  walk(sourcesDir);
  return newest;
}

export function isBinaryStale(repoRoot: string, bin: string): boolean {
  if (!isFile(bin)) return true;
  const binMtime = statSync(bin).mtimeMs;
  return newestSourceMtimeMs(repoRoot) > binMtime;
}

/** Ensure the kokoro-tts binary exists, building it once if missing. Cached for the process lifetime. */
export async function ensureBinary(onProgress?: ProgressFn): Promise<string> {
  if (_cachedBin && isFile(_cachedBin)) return _cachedBin;

  const explicit = process.env.KOKORO_BIN;
  if (explicit && existsSync(explicit)) {
    _cachedBin = pResolve(explicit);
    return _cachedBin;
  }

  const repoRoot = resolveRepoRoot();
  const bin = defaultBinaryPath(repoRoot);
  if (isFile(bin)) {
    const metallib = join(dirname(bin), "mlx.metallib");
    if (!isFile(metallib)) {
      try {
        await buildMetallib(repoRoot, onProgress);
      } catch {
        /* best-effort */
      }
    }
    _cachedBin = bin;
    return bin;
  }
  await buildBinary(repoRoot, onProgress);
  if (!isFile(bin)) {
    throw new Error(
      `kokoro-tts build reported success but binary not found at ${bin}. ` +
        "Check swift build output; set KOKORO_BIN to override.",
    );
  }
  _cachedBin = bin;
  return bin;
}
```

Note: `buildBinary` passes `--product kokoro-tts` to `swift build` (unlike `musicgen_binary.ts`'s bare `swift build -c release`, which builds every product in the package) — this avoids rebuilding the unrelated `musicgen` binary as a side effect of resolving `kokoro-tts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/kokoro_binary.test.ts )`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/kokoro_binary.ts bun-apps/pi-agent-ext-movie-director/src/kokoro_binary.test.ts
git commit -m "feat(kokoro-tts): kokoro_binary.ts resolver (mirrors musicgen_binary.ts)"
```

---

### Task 5: TS adapter — `kokoro_tts_native.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/kokoro_tts_native.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/kokoro_tts_native.test.ts`
- Reference (read, don't modify): `bun-apps/pi-agent-ext-movie-director/src/runpy_tts.ts` (for the `RunPyTtsDetails`/`RunPyTtsOutput` shapes this reuses)

- [ ] **Step 1: Write the failing tests**

Create `bun-apps/pi-agent-ext-movie-director/src/kokoro_tts_native.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKokoroTtsArgs, runKokoroTtsNative } from "./kokoro_tts_native.ts";
import type { KokoroTtsOptions } from "./kokoro_tts_native.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "md-kokoro-tts-native-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildKokoroTtsArgs", () => {
  it("minimal: text + voice + output only (speed/modelRepo default in the CLI)", () => {
    expect(buildKokoroTtsArgs({ text: "hello", voice: "af_heart" }, "/x/out.wav")).toEqual([
      "generate", "--text", "hello", "--voice", "af_heart", "--output", "/x/out.wav",
    ]);
  });

  it("includes --speed when set", () => {
    const args = buildKokoroTtsArgs({ text: "hi", voice: "am_michael", speed: 1.2 }, "/x/out.wav");
    expect(args).toEqual([
      "generate", "--text", "hi", "--voice", "am_michael", "--output", "/x/out.wav",
      "--speed", "1.2",
    ]);
  });

  it("includes --model-repo when set", () => {
    const args = buildKokoroTtsArgs(
      { text: "hi", voice: "zf_xiaobei", modelRepo: "mlx-community/Kokoro-82M-4bit" },
      "/x/out.wav",
    );
    expect(args).toEqual([
      "generate", "--text", "hi", "--voice", "zf_xiaobei", "--output", "/x/out.wav",
      "--model-repo", "mlx-community/Kokoro-82M-4bit",
    ]);
  });
});

describe("runKokoroTtsNative — spawn injection (no built binary needed)", () => {
  it("ok=true when the binary exits 0 AND the requested audio file lands with real content", async () => {
    const out = join(dir, "line.wav");
    const opts: KokoroTtsOptions = { text: "Hello from Kokoro.", voice: "af_heart" };
    const result = await runKokoroTtsNative({
      options: opts,
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "fake wav bytes");
        return { stdout: "generated", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.command).toBe("tts");
    expect(result.details.exitCode).toBe(0);
    expect(result.details.output).toBe(out);
    expect(result.details.sizeBytes).toBeGreaterThan(0);
    expect(result.details.voice).toBe("af_heart");
    expect(result.summary).toContain("kokoro ✓");
  });

  it("ok=false when the binary exits 0 but wrote NO file (0-exit ≠ success)", async () => {
    const out = join(dir, "never-written.wav");
    const result = await runKokoroTtsNative({
      options: { text: "x", voice: "af_heart" },
      output: out,
      _spawnImpl: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.output).toBeNull();
    expect(result.summary).toContain("FAILED");
  });

  it("ok=false when the binary exits 0 but wrote an EMPTY file", async () => {
    const out = join(dir, "empty.wav");
    const result = await runKokoroTtsNative({
      options: { text: "x", voice: "af_heart" },
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.sizeBytes).toBe(0);
  });

  it("ok=false on non-zero exit (e.g. model download failed)", async () => {
    const out = join(dir, "fail.wav");
    const result = await runKokoroTtsNative({
      options: { text: "x", voice: "zm_yunjian" },
      output: out,
      _spawnImpl: async () => ({ stdout: "", stderr: "ERROR: could not resolve repo", exitCode: 1 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.exitCode).toBe(1);
    expect(result.stderrTail).toContain("could not resolve repo");
  });

  it("ok=false + graceful summary when the spawn itself throws", async () => {
    const out = join(dir, "throw.wav");
    const result = await runKokoroTtsNative({
      options: { text: "x", voice: "af_heart" },
      output: out,
      _spawnImpl: async () => {
        throw new Error("ENOENT: kokoro-tts binary");
      },
    });
    expect(result.details.ok).toBe(false);
    expect(result.summary).toContain("spawn failed");
    expect(result.summary).toContain("ENOENT");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/kokoro_tts_native.test.ts )`
Expected: FAIL — `Cannot find module './kokoro_tts_native.ts'`.

- [ ] **Step 3: Write the implementation**

Create `bun-apps/pi-agent-ext-movie-director/src/kokoro_tts_native.ts`:

```typescript
/**
 * kokoro_tts_native.ts — the Bun-native Kokoro TTS adapter, calling the
 * compiled `kokoro-tts` Swift binary (swift/musicgen-director's KokoroTTSCLI
 * target) — wiring mlx-audio-swift's already-implemented Kokoro model, NOT a
 * from-scratch port (see docs/superpowers/specs/2026-08-01-kokoro-tts-swift-
 * native-port-design.md). Same shape as music_native.ts's ensureBinary()/
 * spawn pattern.
 *
 * Reuses runpy_tts.ts's RunPyTtsDetails/RunPyTtsOutput shapes exactly (same
 * fields, command:"tts") so bridge.ts's existing adaptRunPyTts-style artifact
 * shape stays consistent across all three tts providers (runpy/edge-tts/
 * kokoro) — but KokoroTtsOptions is its OWN new type: Kokoro's voice
 * namespace (af_*/am_*/zf_*/zm_*/...) and --speed float are unrelated to
 * edge-tts's RunPyTtsOptions (voice id + rate-as-percentage-string), so
 * reusing that options type would misrepresent the contract.
 */
import { existsSync, statSync } from "node:fs";
import { ensureBinary, resolveRepoRoot } from "./kokoro_binary.ts";
import type { RunPyTtsDetails, RunPyTtsOutput } from "./runpy_tts.ts";

export interface KokoroTtsOptions {
  /** Narration text (required). */
  text: string;
  /** Kokoro voice id, e.g. af_heart, am_michael, zf_xiaobei, zm_yunjian (required — no default). */
  voice: string;
  /** Speech speed multiplier (Kokoro's native parameter — NOT edge-tts's rate-as-percentage-string). */
  speed?: number;
  /** mlx-audio-swift model repo id. Default (the CLI's own default): mlx-community/Kokoro-82M-bf16. */
  modelRepo?: string;
}

export interface KokoroTtsInput {
  options: KokoroTtsOptions;
  /** Output audio path (required — always passed as --output for a deterministic asset path). */
  output: string;
  signal?: AbortSignal;
  /** Test seam: inject a canned spawn result so unit tests don't need a built binary. */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Build the argv tail for `kokoro-tts generate` from KokoroTtsOptions. */
export function buildKokoroTtsArgs(opts: KokoroTtsOptions, output: string): string[] {
  const args: string[] = ["generate", "--text", opts.text, "--voice", opts.voice, "--output", output];
  if (opts.speed != null) args.push("--speed", String(opts.speed));
  if (opts.modelRepo != null) args.push("--model-repo", opts.modelRepo);
  return args;
}

async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bin = await ensureBinary();
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    cwd: resolveRepoRoot(),
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Run `kokoro-tts generate` and normalize into the RunPyTtsDetails/Output shape. */
export async function runKokoroTtsNative(input: KokoroTtsInput): Promise<RunPyTtsOutput> {
  const args = buildKokoroTtsArgs(input.options, input.output);
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const details: RunPyTtsDetails = {
      ok: false,
      command: "tts",
      exitCode: 1,
      aborted: false,
      output: null,
      sizeBytes: null,
      voice: null,
      stdout: "",
    };
    return { details, summary: `kokoro tts spawn failed: ${msg}`, stderrTail: msg };
  }

  const exists = existsSync(input.output);
  const sizeBytes = exists ? statSync(input.output).size : 0;
  const ok = res.exitCode === 0 && exists && sizeBytes > 0;
  const details: RunPyTtsDetails = {
    ok,
    command: "tts",
    exitCode: res.exitCode,
    aborted: false,
    output: exists ? input.output : null,
    sizeBytes: exists ? sizeBytes : null,
    voice: input.options.voice,
    stdout: res.stdout,
  };
  const summary = ok
    ? `kokoro ✓ ${input.options.voice} (Swift native, local) → ${input.output}`
    : `kokoro tts FAILED (exit ${res.exitCode})`;
  const stderrTail = res.stderr
    .split("\n")
    .filter((l) => l.trim())
    .slice(-5)
    .join("\n");
  return { details, summary, stderrTail };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/kokoro_tts_native.test.ts )`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/kokoro_tts_native.ts bun-apps/pi-agent-ext-movie-director/src/kokoro_tts_native.test.ts
git commit -m "feat(kokoro-tts): kokoro_tts_native.ts adapter (mirrors music_native.ts)"
```

---

### Task 6: `selector.ts` — `optIn` field + bare-fallback exclusion

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts:31-70` (the `ProviderEntry` interface)
- Modify: `bun-apps/pi-agent-ext-movie-director/src/selector.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/selector.test.ts`

This is the load-bearing piece: without it, adding a `backend:"native_swift"` Kokoro entry to the `tts` capability would silently become the new default for every bare `{capability:"tts"}` caller (see the design spec's "Selector impact" section for the full `BACKEND_RANK`-crosses-tiers analysis). Do this task BEFORE Task 7 (the registry entry) — Task 7's test additions depend on `optIn` already existing on the type.

- [ ] **Step 1: Add the `optIn` field to `ProviderEntry`**

In `bun-apps/pi-agent-ext-movie-director/src/registry.ts`, find the `ProviderEntry` interface (starts around line 31) and add a new optional field after `commands?: string[];`:

```typescript
  commands?: string[];
  /**
   * When true, this entry is excluded from selectProvider's backend-rank
   * bare-fallback (the final tier when neither an explicit `provider` hint
   * nor a `commands[]` match applies) — only reachable via an explicit
   * `provider` hint or a `commands[]` match. Lets a genuinely-better native
   * provider ship without silently becoming every existing bare caller's new
   * default (see selector.ts's header comment and kokoro_tts's notes for the
   * concrete case this was added for).
   */
  optIn?: boolean;
}
```

- [ ] **Step 2: Write the failing selector tests**

In `bun-apps/pi-agent-ext-movie-director/src/selector.test.ts`, add (read the existing file first to match its import/setup style — it already imports `REGISTRY`/`selectProvider` and likely has a way to inject a test-only registry entry or test against the real one; if it tests against the real `REGISTRY` directly, add these as new `describe` blocks using the real `tts` capability):

```typescript
describe("optIn providers are excluded from selectProvider's bare fallback", () => {
  it("a bare {capability:'tts'} call never returns an optIn:true entry", () => {
    // Uses the real REGISTRY — kokoro_tts (added in Task 7) is optIn:true,
    // so even though it's backend:"native_swift" (rank 0, would otherwise
    // beat say_tts/edge_tts unconditionally), selectProvider must still
    // return today's pick.
    const entry = selectProvider("tts");
    expect(entry.optIn).not.toBe(true);
  });

  it("an explicit provider:'kokoro' hint still reaches the optIn entry", () => {
    const entry = selectProvider("tts", { provider: "kokoro" });
    expect(entry.provider).toBe("kokoro");
    expect(entry.optIn).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/selector.test.ts )`
Expected: FAIL — `entry.provider` is not `"kokoro"` (`kokoro_tts` doesn't exist in `REGISTRY` yet, from Task 7) AND/OR (if you add a temporary registry stub for this test in isolation) a TypeScript error on `optIn` not existing yet. Since Task 7 hasn't run, the second test fails with `NoConfiguredProviderError` or a provider mismatch — either way, both new tests are red before Step 4's selector.ts change AND before Task 7's registry entry exist. This task's own Step 4 change alone won't turn them green; note that in the completion report and don't be alarmed — Task 7 is what makes them pass. Run again after Task 7 to confirm.

- [ ] **Step 4: Implement the bare-fallback exclusion**

In `bun-apps/pi-agent-ext-movie-director/src/selector.ts`, update the header comment's numbered precedence list (currently ends around line 29) to document the new behavior — change:

```
 *   3. Backend-rank tiebreak — `BACKEND_RANK` order (native_swift → ffmpeg →
 *      macos_native → cloud_http), registry declaration order breaking ties.
 *      The fallback when neither of the above applies.
```

to:

```
 *   3. Backend-rank tiebreak — `BACKEND_RANK` order (native_swift → ffmpeg →
 *      macos_native → cloud_http), registry declaration order breaking ties.
 *      The fallback when neither of the above applies. Entries with
 *      `optIn: true` are excluded from this tier entirely (unless they are
 *      the ONLY configured candidates left) — added 2026-08-01 so a
 *      genuinely-better native provider (e.g. kokoro_tts) can ship without
 *      silently becoming every existing bare caller's new default; it only
 *      changes behavior for callers that explicitly ask for it via tier 1/2.
```

Then update the final fallback (the `return [...configured].sort(...)` line near the end of `selectProvider`):

```typescript
  // Stable sort by backend rank (registry order breaks ties implicitly —
  // Array.prototype.sort is stable in Bun/Node ≥12). configured is non-empty
  // (we threw above). optIn entries are excluded from this bare fallback
  // (tier 3) unless they're the only configured candidates left — an
  // opt-in-only capability must still be selectable by *something* when
  // it's the sole configured option, even though that case doesn't exist
  // for `tts` today (say/edge-tts are always configured).
  const nonOptIn = configured.filter((p) => !p.optIn);
  const pool = nonOptIn.length > 0 ? nonOptIn : configured;
  return [...pool].sort((a, b) => BACKEND_RANK[a.backend] - BACKEND_RANK[b.backend])[0]!;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/selector.test.ts )`
Expected: the `optIn`-exclusion test (Step 2's first test) now PASSES (no `kokoro_tts` entry exists yet, so this was trivially true, but now it's enforced by real logic, not by absence). The `provider:"kokoro"` hint test still FAILS — expected, since Task 7 hasn't added the `kokoro_tts` registry entry yet. This is correct; do not force it to pass here.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/registry.ts bun-apps/pi-agent-ext-movie-director/src/selector.ts bun-apps/pi-agent-ext-movie-director/src/selector.test.ts
git commit -m "feat(selector): add optIn field — excludes a provider from bare backend-rank fallback"
```

---

### Task 7: `registry.ts` — `kokoro_tts` entry

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts` (the `invoke` union around line 47-49, and the `tts` capability block around line 348-372)

- [ ] **Step 1: Add the new `invoke` literal**

In `bun-apps/pi-agent-ext-movie-director/src/registry.ts`, find the `invoke` union (starts around line 38) and add `"bun:kokoro-tts"` after `"bun:musicgen-native"`:

```typescript
    | "mlx:runpy-music"
    | "bun:musicgen-native"
    | "bun:kokoro-tts"
    | "bun:twosubject-native"
```

- [ ] **Step 2: Add the registry entry**

In the same file, find the `tts` capability block (the `say_tts` entry ends around line 372) and add the new entry right after it:

```typescript
  { name: "say_tts", capability: "tts", provider: "say", backend: "macos_native", invoke: "macos:say", configured: true, notes: "macOS `say` (AVSpeechSynthesizer-backed) — zero-cost, zero-key, fully offline narration; robotic voice quality vs edge_tts. Statically ranked as the default (the correct offline/no-network fallback), but selectAndGenerate opportunistically tries edge-tts first at runtime and only actually invokes say if that fails — see edge_tts's notes." },
  // kokoro_tts — 2026-08-01: run.py tts --engine mlx (local Kokoro-82M via
  // Python's mlx-audio package) was the one remaining Python-only surface in
  // `run.py tts` (edge-tts was already fully native — see edge_tts above),
  // and unlike edge-tts it had NO TS caller at all (runpy_tts.ts never
  // exposed an --engine option). swift/musicgen-director already depends on
  // mlx-audio-swift for MLXAudioCodecs (EnCodec) — that same package ships a
  // COMPLETE Kokoro implementation (MLXAudioTTS product,
  // Models/StyleTTS2/Kokoro/), so this port is CLI + bridge wiring, not a
  // from-scratch model port like MusicGen was. See
  // docs/superpowers/specs/2026-08-01-kokoro-tts-swift-native-port-design.md.
  // optIn:true is load-bearing here, not decorative: BACKEND_RANK ranks
  // native_swift above macos_native/cloud_http ACROSS tiers (not just within
  // one), so without optIn this entry would unconditionally win every bare
  // {capability:"tts"} call over say_tts/edge_tts, silently changing their
  // existing default behavior — see selector.ts's header comment. Reachable
  // today only via an explicit `provider:"kokoro"` hint. English (af_*/am_*)
  // and Mandarin (zf_*/zm_*) voices verified (see swift/musicgen-director's
  // KokoroTTSCLITests); other Kokoro-supported languages (es/fr/it/pt/hi/ja)
  // deferred to edge-tts, which already covers them.
  { name: "kokoro_tts", capability: "tts", provider: "kokoro", backend: "native_swift", invoke: "bun:kokoro-tts", configured: true, optIn: true, notes: "swift/musicgen-director's kokoro-tts binary (src/kokoro_tts_native.ts, via ensureBinary()) — local Kokoro-82M TTS via mlx-audio-swift's MLXAudioTTS product, zero Python. Genuinely offline (unlike edge_tts) and higher quality than say_tts, but NOT the default — optIn:true (see selector.ts). Reach it with an explicit provider:\"kokoro\" hint." },
```

- [ ] **Step 3: Run the selector tests from Task 6 again — they should now fully pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/selector.test.ts )`
Expected: PASS (both new tests from Task 6, including the `provider:"kokoro"` hint one that was red until now).

- [ ] **Step 4: Run the full registry/selector-adjacent test suite to check for regressions**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/registry.test.ts src/selector.test.ts src/providers.test.ts 2>&1 | tail -40 )`
Expected: PASS. If `registry.test.ts` has an exhaustive "every entry has valid fields" or "every capability has at least one configured provider" style assertion, confirm `kokoro_tts` doesn't trip it (it shouldn't — `optIn` is optional and additive).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/registry.ts
git commit -m "feat(registry): add kokoro_tts provider (optIn:true, local Kokoro-82M TTS)"
```

---

### Task 8: `bridge.ts` wiring — `adaptKokoroTts` + `realKokoroTtsNative`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts`

`bridge.test.ts` tests every `adapt*` function directly against hand-built `Details` objects (see its `adaptCaption`/`adaptRunPy` `describe` blocks around line 363-473) — it does NOT test the `real*Native` wrapper functions at all (those are thin pass-throughs already covered end-to-end by each native module's own test file, e.g. `kokoro_tts_native.test.ts` from Task 5). Follow that exact same pattern: test `adaptKokoroTts` directly, do not attempt to mock/spawn `realKokoroTtsNative`.

**Important:** do NOT reuse `adaptRunPyTts` for `adaptKokoroTts` — it hardcodes `provider: "edge-tts"` in its returned `ToolResult` (see its definition around line 853-877 in `bridge.ts`). Reusing it as-is would make every Kokoro-generated `ToolResult` falsely claim `provider: "edge-tts"`. Write a new `adaptKokoroTts`, modeled on `adaptRunPyMusic`'s structure (which already correctly parameterizes `provider`/`model` per-function) instead.

- [ ] **Step 1: Write the failing tests**

In `bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts`, add `adaptKokoroTts` to the existing import block (line 2-18, alongside `adaptCaption`):

```typescript
import {
  adaptKrea2,
  adaptFlux2,
  adaptLtx,
  adaptRunPy,
  adaptCaption,
  adaptKokoroTts,
  generate,
  ...
```

Then add a new `describe` block, mirroring `adaptCaption`'s two-test shape (success + failure) at the end of the file (after the last existing `describe` block):

```typescript
describe("adaptKokoroTts — local Kokoro-82M adapter contract (Details → ToolResult)", () => {
  it("maps a successful generation to one audio artifact with provider:'kokoro'", () => {
    const details = {
      ok: true,
      command: "tts" as const,
      exitCode: 0,
      aborted: false,
      output: "/out/tts_kokoro.wav",
      sizeBytes: 48000,
      voice: "af_heart",
      stdout: "[kokoro-tts generate] done -> /out/tts_kokoro.wav (48000 bytes)",
    };
    const r = adaptKokoroTts(
      { capability: "tts", command: "tts", options: { text: "Hello.", voice: "af_heart" } },
      details,
      "kokoro ✓ af_heart (Swift native, local) → /out/tts_kokoro.wav",
      "",
    );
    expect(r.success).toBe(true);
    expect(r.provider).toBe("kokoro");
    expect(r.command).toBe("tts");
    expect(r.seed).toBeNull();
    expect(r.model).toBe("af_heart");
    expect(r.cost_usd).toBe(0); // fully local — honest $0 marginal cost
    expect(r.artifacts).toEqual([
      { path: "/out/tts_kokoro.wav", kind: "audio", role: "primary", bytes: 48000 },
    ]);
  });

  it("flags failure + no artifact when the binary wrote no audio file", () => {
    const details = {
      ok: false,
      command: "tts" as const,
      exitCode: 1,
      aborted: false,
      output: null,
      sizeBytes: null,
      voice: null,
      stdout: "",
    };
    const r = adaptKokoroTts(
      { capability: "tts", command: "tts", options: { text: "x", voice: "zf_xiaobei" } },
      details,
      "kokoro tts FAILED (exit 1)",
      "ERROR: could not resolve repo",
    );
    expect(r.success).toBe(false);
    expect(r.artifacts).toEqual([]);
    expect(r.error).toContain("FAILED");
    expect(r.model).toBe("kokoro-82m"); // local fallback label when voice is unknown
    expect(r.cost_usd).toBe(0); // no cost on failure
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/bridge.test.ts )`
Expected: FAIL — `adaptKokoroTts` is not exported from `./bridge.ts`.

- [ ] **Step 3: Implement `adaptKokoroTts` + `realKokoroTtsNative`**

In `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`, add right after the existing `realMusicNative` function (around line 956, before `realTwosubjectNative`):

```typescript
/**
 * adaptKokoroTts — normalize a kokoro-tts (local Swift/MLX Kokoro-82M) result.
 * A SEPARATE function from adaptRunPyTts (NOT reused) — adaptRunPyTts
 * hardcodes provider:"edge-tts", which would be wrong here. Same artifact/
 * cost/duration conventions as adaptRunPyMusic (fully local, honest $0
 * marginal cost).
 */
export function adaptKokoroTts(
  req: GenerateRequest,
  details: RunPyTtsDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.output) {
    artifacts.push({ path: details.output, kind: "audio", role: "primary", bytes: details.sizeBytes ?? undefined });
  }
  return {
    success: details.ok,
    provider: "kokoro",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: null,
    seed: null,
    model: details.voice ?? "kokoro-82m",
  };
}

/**
 * realKokoroTtsNative — kokoro-tts's compiled Swift binary
 * (kokoro_tts_native.ts, via ensureBinary()), local Kokoro-82M TTS. `voice`
 * is REQUIRED (no default, unlike edge-tts) — the caller (or the agent tool
 * wrapper) must always pass one; there is no single sensible default across
 * English/Mandarin voice namespaces.
 */
async function realKokoroTtsNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as unknown as KokoroTtsOptions & { output?: string };
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, "tts_kokoro.wav");
  const { runKokoroTtsNative } = await import("./kokoro_tts_native.ts");
  const out = await runKokoroTtsNative({ options: opts, output });
  return adaptKokoroTts(req, out.details, out.summary, out.stderrTail, env);
}
```

Add the import at the top of `bridge.ts` alongside the other `RunPy*Options`/type imports (find the line importing `RunPyTtsOptions` and add `KokoroTtsOptions` from the new module):

```typescript
import type { KokoroTtsOptions } from "./kokoro_tts_native.ts";
```

Register it in `realAdapters()`'s map (right after `"bun:musicgen-native"`):

```typescript
    "bun:musicgen-native": (req) => realMusicNative(req, env),
    "bun:kokoro-tts": (req) => realKokoroTtsNative(req, env),
    "bun:twosubject-native": (req) => realTwosubjectNative(req, env),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/bridge.test.ts )`
Expected: PASS.

- [ ] **Step 5: Run the full package test suite for regressions**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: PASS, no regressions in unrelated tests.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/bridge.ts
git commit -m "feat(bridge): wire kokoro-tts (adaptKokoroTts + realKokoroTtsNative, provider:kokoro)"
```

---

### Task 9: Final verification

**Files:** none (verification only — fix forward in the relevant task's files if something here fails, then re-run this task).

- [ ] **Step 1: Full TS test suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: PASS, 0 failures.

- [ ] **Step 2: Full Swift package build + test**

Run: `swift build --package-path swift/musicgen-director -c release 2>&1 | tail -30`
Expected: PASS — this also confirms `musicgen`'s existing release build still succeeds (Task 1/2 touched shared `Package.swift` but not the `MusicGenDirector`/`MusicGenDirectorCLI` targets themselves).

Run: `swift test --package-path swift/musicgen-director 2>&1 | tail -60`
Expected: PASS, including `KokoroTTSCLITests`'s real English + Mandarin generation (Task 3) — do not skip this even though it's slow; it's the test that actually proves the port works, not just compiles.

- [ ] **Step 3: Real end-to-end verification via the TS path (both languages)**

This exercises the ACTUAL compiled `kokoro-tts` binary through the full TS bridge, not just the Swift library API directly (Task 3 covered the latter). Needs the release binary built (Step 2) and, on first run, network egress.

Run:
```bash
KOKORO_BIN=swift/musicgen-director/.build/release/kokoro-tts
"$KOKORO_BIN" generate --text "Hello from Kokoro, running end to end." --voice af_heart --output /tmp/kokoro-e2e-en.wav && \
"$KOKORO_BIN" generate --text "你好，這是端對端測試。" --voice zf_xiaobei --output /tmp/kokoro-e2e-zh.wav && \
ls -la /tmp/kokoro-e2e-en.wav /tmp/kokoro-e2e-zh.wav
```

Expected: both `.wav` files exist with nonzero size. Optionally play them back (`afplay /tmp/kokoro-e2e-en.wav`) to confirm audible, non-garbled speech in both languages — this is the closest thing to a human QA check this plan has, worth doing at least once even though it's not automatable.

- [ ] **Step 4: Confirm `optIn` didn't change today's default `tts` selection**

Run:
```bash
( cd bun-apps/pi-agent-ext-movie-director && bun -e '
import { selectProvider } from "./src/selector.ts";
const entry = selectProvider("tts");
console.log(JSON.stringify({ provider: entry.provider, backend: entry.backend, optIn: entry.optIn ?? false }));
'
)
```
Expected: `{"provider":"say","backend":"macos_native","optIn":false}` (or `edge-tts` if `selectAndGenerate`'s opportunistic-upgrade layer is what's being checked elsewhere — but `selectProvider` itself, called bare with no options, must NOT return `provider:"kokoro"`). If it returns `kokoro`, Task 6's `optIn` exclusion has a bug — stop and fix it before proceeding; this is the one behavior change this entire port was explicitly designed to avoid.

- [ ] **Step 5: Report completion**

No commit for this task (verification only). If all four checks above pass, the port is complete and ready for `superpowers:finishing-a-development-branch`.
