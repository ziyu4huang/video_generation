# Native-relay long-movie generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Swift `native-relay` command into the `pi-agent-ext-movie-director` agent pipeline as the primary long-movie generation mechanism, replacing the current per-scene `t2i2v` chain that has no cross-scene continuity and silently skips its duration-mismatch gates.

**Architecture:** `assets-encoder.ts` flattens every video scene's links into ONE ordered list (prompt + per-link duration + continuity flag), `driver-wiring.ts` dispatches a SINGLE `native-relay` generate call for the whole movie (`provider:"ltx"`, so the existing `ensureBinary()` auto-build-or-throw path is always used — no silent Python fallback), probes each returned segment's real duration to build scene boundaries, and threads the narration's real probed duration into the (already-implemented but previously unwired) blocking `narrative_duration_vs_script` / `motion_coverage_vs_scene` precompose gates.

**Tech Stack:** Swift (ArgumentParser, XCTest) for `swift/ltx-video-director/`; TypeScript + Bun test for `bun-apps/pi-agent-ext-ltx/` and `bun-apps/pi-agent-ext-movie-director/`.

**Design doc:** `docs/superpowers/specs/2026-07-21-native-relay-long-movie-design.md`

---

## Implementation-detail refinements found during planning (read before starting)

Deeper code reading surfaced four refinements to the approved design that make the same architecture cheaper/safer to build. These do not change any of the design's 8 decisions — only how they're mechanically achieved:

1. **No new build/preflight mechanism needed.** `bun-apps/pi-agent-ext-ltx/src/binary.ts` already has `ensureBinary()`, which auto-builds `swift build -c release` on first use and **throws** if the build fails (no silent fallback). The only reason it's currently bypassed is that `providers.ts`'s runtime *selector* probes for a pre-existing binary (`ltxBinaryPresent()`) before ever calling `runLtx`/`ensureBinary`, and silently prefers `mlx:runpy` when the binary isn't there yet. Passing an explicit `provider: "ltx"` hint on the `generate` dispatch call bypasses that probe entirely (confirmed in `selector.ts:94-110`, same mechanism `krea2`'s registry comment documents) and routes straight to `ensureBinary()`. So decision 7 ("hard error, no python fallback") is satisfied by adding one field to the dispatch call — no new setup-script step, no new preflight check.
2. **No Swift `--json-out` addition needed.** `native-relay`'s existing stdout already prints one `segment N: <path>` line per segment, in order — `result.ts`'s `buildNativeRelayDetails` already regex-captures these. The only fix needed is a small shape correction (Task 1 below) so each segment path survives as its own correctly-typed artifact instead of being packed as an array into a field typed `string`.
3. **`compose-motion` stays in the loop** (the design's §4 suggestion to drop it was unnecessary). Cuts that all reference the SAME source file at different `in_seconds`/`out_seconds` ranges are something `compose-motion` already handles correctly — it doesn't care whether cuts share a source. The one real change needed is setting `edit_decisions.transition = "none"`, because the relay's segments are already visually continuous (last-frame reseed) and a crossfade would double-blend already-matching frames.
4. **Scene_plan's new field is named `continuity`, not `transition`** — `scene.type` already has an enum value literally named `"transition"` (a scene whose *narrative purpose* is a transition), so reusing that word for the chaining-behavior field would collide in naming even though the two are unrelated concepts.

---

## File structure

| File | Responsibility |
|---|---|
| `bun-apps/pi-agent-ext-ltx/src/result.ts` | Fix `native-relay`'s per-segment output shape (`segment_1`, `segment_2`, ... instead of a `segments` array packed into a `string`-typed field). |
| `bun-apps/pi-agent-ext-ltx/src/result.test.ts` | Updated assertions for the new shape. |
| `bun-apps/pi-agent-ext-movie-director/src/bridge.ts` | `adaptLtx`'s artifact-kind inference recognizes `segment_N` roles as video. |
| `swift/.../LTXVideoDirector/NativeRelayStage.swift` | `Request.secondsPerSegment`/`segmentContinuity` arrays, `Result.segmentDurations`, new validation errors. |
| `swift/.../LTXVideoDirectorCLI/NativeRelayCommand.swift` | `--seconds-per-segment`/`--segment-continuity` CLI flags. |
| `swift/.../Tests/LTXVideoDirectorTests/NativeRelayStageTests.swift` | Fail-fast validation tests for the new arrays. |
| `bun-apps/pi-agent-ext-ltx/src/commands.ts` | New `"boolean[]"` `FieldType`, two new `native-relay` fields, `buildArgs` support. |
| `bun-apps/pi-agent-ext-ltx/src/commands.test.ts` | Tests for the new fields/flags. |
| `bun-apps/pi-agent-ext-movie-director/data/schemas/artifacts/scene_plan.schema.json` | New `continuity: "continue" \| "cut"` scene property. |
| `bun-apps/pi-agent-ext-movie-director/data/schemas/artifacts/edit_decisions.schema.json` | New top-level `transition: "none" \| "crossfade"` property. |
| `bun-apps/pi-agent-ext-movie-director/src/assets-encoder.ts` | Rewritten: flattens the whole movie into one `RelayLink[]` + one `TtsCall`. |
| `bun-apps/pi-agent-ext-movie-director/src/assets-encoder.test.ts` | Rewritten tests for the flattened plan. |
| `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts` | `produceAssets` dispatches ONE `native-relay` call; `produceEdit` builds scene-boundary cuts on a shared source; `produceCompose` threads `narrativeDurationSeconds`; `extractLastFrame` plumbing removed. |
| `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.test.ts` | Rewritten/extended tests. |
| `bun-apps/pi-agent-ext-movie-director/src/assets-runtime.ts` | `defaultExtractLastFrame` removed (dead code once native-relay owns chaining). |
| `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts` | `extractLastFrame` wiring removed from the `run-pipeline` case. |

---

### Task 1: Fix `native-relay`'s per-segment output shape

**Files:**
- Modify: `bun-apps/pi-agent-ext-ltx/src/result.ts:409-429` (`buildNativeRelayDetails`)
- Modify: `bun-apps/pi-agent-ext-ltx/src/result.test.ts:138-156` (existing native-relay test)
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.ts:248-256` (`adaptLtx`'s kind inference)

`LtxDetails.extraOutputs` is typed `Record<string, string>` (result.ts:46), but `buildNativeRelayDetails` currently assigns `extraOutputs: { segments }` where `segments` is a `string[]` — every OTHER caller of `extraOutputs` (via `adaptLtx`'s `Object.entries` loop in bridge.ts) expects one artifact per key with a single string path. Fix it to emit one numbered key per segment, matching every other command's convention.

- [ ] **Step 1: Write the failing test**

Replace the existing native-relay test in `bun-apps/pi-agent-ext-ltx/src/result.test.ts` (find the `describe("buildDetails: native-relay", ...)` block, currently asserting `d.extraOutputs.segments`):

```ts
test("native-relay: final path + one numbered extraOutputs key per segment, in order", () => {
  const stdout = [
    "→ native relay (no run.py, no ffmpeg): 2 segment(s) @ 640x960, 8.0s/segment, transformer=distilled",
    "[relay] segment 1 last frame: frame_0199.png — feeding forward as segment 2's --input-image",
    "   segment 1: /tmp/relay/seg01/segment.mp4",
    "[relay] segment 2 last frame: frame_0191.png — feeding forward as segment 3's --input-image",
    "   segment 2: /tmp/relay/seg02/segment.mp4",
    "   final: /tmp/relay/relay.mp4",
    "wall time: 42.1s",
  ].join("\n");
  const d = buildDetails("native-relay", ok(stdout));
  expect(d.output).toBe("/tmp/relay/relay.mp4");
  expect(d.extraOutputs.segment_1).toBe("/tmp/relay/seg01/segment.mp4");
  expect(d.extraOutputs.segment_2).toBe("/tmp/relay/seg02/segment.mp4");
  expect(d.extraOutputs.segments).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-ltx && bun test src/result.test.ts -t "native-relay"`
Expected: FAIL — `d.extraOutputs.segment_1` is `undefined` (current code writes `d.extraOutputs.segments` as an array instead).

- [ ] **Step 3: Fix `buildNativeRelayDetails`**

In `bun-apps/pi-agent-ext-ltx/src/result.ts`, replace the function body:

```ts
/** `native-relay`: "final: <path>" (concatenated relay.mp4) + per-segment prints + wall time. */
function buildNativeRelayDetails(res: InvokeResult): LtxDetails {
  const ok = res.exitCode === 0 && !res.aborted;
  const stdout = res.stdout;
  const final = firstMatchLine(stdout, /final:\s*(\S+)/);
  const segments = allMatches(stdout, /segment \d+:\s*(\S+)/);
  const dims = parseDims(stdout);
  const extraOutputs: Record<string, string> = {};
  segments.forEach((path, i) => {
    extraOutputs[`segment_${i + 1}`] = path;
  });
  return {
    ok,
    command: "native-relay",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: final,
    extraOutputs,
    width: dims.width,
    height: dims.height,
    wallSeconds: parseWallSeconds(stdout),
    gate: null,
    stdout,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-ltx && bun test src/result.test.ts -t "native-relay"`
Expected: PASS

- [ ] **Step 5: Update `adaptLtx`'s artifact-kind inference for `segment_N` roles**

In `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`, in `adaptLtx`'s loop over `details.extraOutputs`:

```ts
  for (const [role, path] of Object.entries(details.extraOutputs)) {
    const kind: ArtifactKind = role.includes("audio")
      ? "audio"
      : role.includes("frame") || role.includes("Frame")
        ? "frames"
        : role.includes("mp4") || role.includes("video") || role.startsWith("segment")
          ? "video"
          : role.includes("dir")
            ? "directory"
            : "unknown";
    artifacts.push({ path, kind, role });
  }
```

(Only change: added `|| role.startsWith("segment")` to the video-kind condition.)

- [ ] **Step 6: Write a test proving segment artifacts come through as `kind:"video"`**

Add to the existing `describe("adaptLtx — contract parse", ...)` block in `bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts` (both `LtxDetails` and `GenerateRequest` are already imported at the top of this file — reuse them, matching the file's `it(...)` convention):

```ts
  it("native-relay: segment_N extraOutputs surface as kind:video artifacts", () => {
    const details: LtxDetails = {
      ok: true, command: "native-relay", exitCode: 0, aborted: false,
      output: "/tmp/relay/relay.mp4",
      extraOutputs: { segment_1: "/tmp/relay/seg01/segment.mp4", segment_2: "/tmp/relay/seg02/segment.mp4" },
      width: 640, height: 960, wallSeconds: 42.1, gate: null, stdout: "",
    };
    const r = adaptLtx({ capability: "video_generation", command: "native-relay", options: {} }, details, "ok", "");
    const seg1 = r.artifacts.find((a) => a.role === "segment_1");
    const seg2 = r.artifacts.find((a) => a.role === "segment_2");
    expect(seg1).toMatchObject({ path: "/tmp/relay/seg01/segment.mp4", kind: "video" });
    expect(seg2).toMatchObject({ path: "/tmp/relay/seg02/segment.mp4", kind: "video" });
  });
```

- [ ] **Step 7: Run the full test suites for both packages**

Run: `cd bun-apps/pi-agent-ext-ltx && bun test` — Expected: all PASS
Run: `cd bun-apps/pi-agent-ext-movie-director && bun test` — Expected: all PASS

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-ltx/src/result.ts bun-apps/pi-agent-ext-ltx/src/result.test.ts bun-apps/pi-agent-ext-movie-director/src/bridge.ts bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts
git commit -m "fix(pi-agent-ext-ltx): native-relay segment paths as numbered keys, not an array"
```

---

### Task 2: Swift — per-segment duration/continuity arrays in `NativeRelayStage`

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirector/NativeRelayStage.swift`
- Modify: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeRelayStageTests.swift`

- [ ] **Step 1: Write the failing tests**

Append to `NativeRelayStageTests.swift` (inside the `final class NativeRelayStageTests: XCTestCase { ... }` body, after `testGridConfigMismatchThrowsThroughFirstSegment`):

```swift
    func testSecondsPerSegmentCountMismatchThrows() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball", "a blue ball"])
        request.secondsPerSegment = [2.0] // 1 entry, need 2
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_seconds_mismatch_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .secondsPerSegmentCountMismatch(let count, let segments) = stageError {
                XCTAssertEqual(count, 1)
                XCTAssertEqual(segments, 2)
            } else {
                XCTFail("expected .secondsPerSegmentCountMismatch, got \(stageError)")
            }
        }
    }

    func testSegmentContinuityCountMismatchThrows() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball", "a blue ball"])
        request.segmentContinuity = [true] // 1 entry, need 2
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_continuity_mismatch_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .segmentContinuityCountMismatch(let count, let segments) = stageError {
                XCTAssertEqual(count, 1)
                XCTAssertEqual(segments, 2)
            } else {
                XCTFail("expected .segmentContinuityCountMismatch, got \(stageError)")
            }
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail (compile error is expected too)**

Run: `cd swift/ltx-video-director && swift test --filter NativeRelayStageTests 2>&1 | tail -40`
Expected: FAIL to compile — `secondsPerSegment`/`segmentContinuity`/`.secondsPerSegmentCountMismatch`/`.segmentContinuityCountMismatch` don't exist yet.

- [ ] **Step 3: Add the new `StageError` cases**

In `NativeRelayStage.swift`, add two cases to `StageError` (after `invalidSegmentGridPanel`):

```swift
        case invalidSegmentGridPanel(segment: Int, panel: Int, panelCount: Int)
        case secondsPerSegmentCountMismatch(count: Int, segments: Int)
        case segmentContinuityCountMismatch(count: Int, segments: Int)
```

And their `description` cases (after the `invalidSegmentGridPanel` case in the `description` switch):

```swift
            case .invalidSegmentGridPanel(let segment, let panel, let panelCount):
                return "NativeRelayStage: segmentGridPanels[\(segment)]=\(panel) out of range [0, \(panelCount)) for gridColumns*gridRows"
            case .secondsPerSegmentCountMismatch(let count, let segments):
                return "NativeRelayStage: secondsPerSegment has \(count) entries, expected \(segments) (one per segment/prompt)"
            case .segmentContinuityCountMismatch(let count, let segments):
                return "NativeRelayStage: segmentContinuity has \(count) entries, expected \(segments) (one per segment/prompt)"
```

- [ ] **Step 4: Add the two new `Request` properties**

Add to the `Request` struct, after `audioOverlayPath`:

```swift
        /// Per-segment duration override (seconds), one entry per `prompts.count`
        /// when given — overrides `seconds` for that segment only. Omitted (nil)
        /// -> every segment uses the uniform `seconds` (unchanged default).
        public var secondsPerSegment: [Double]?

        /// Per-segment continuity override, one entry per `prompts.count` when
        /// given. `false` at index i means segment i ignores `nextInputImage`
        /// and generates fresh via T2I from `prompts[i]` (a hard cut) — exactly
        /// like segment 0's default behavior. Omitted (nil) -> every non-first
        /// segment continues from the previous segment's last frame (unchanged
        /// default); segment 0 never continues regardless of this array.
        public var segmentContinuity: [Bool]?
```

- [ ] **Step 5: Add `segmentDurations` to `Result`**

Change the `Result` struct:

```swift
    public struct Result {
        public let segmentResults: [NativeI2VStage.Result]
        public let segmentVideoURLs: [URL]
        public let finalVideoURL: URL
        /// Actual generated duration per segment (frameCount / fps) — NOT the
        /// requested value, since LTX's 8k+1 frame-stride alignment means
        /// requested and actual can differ.
        public let segmentDurations: [Double]
    }
```

- [ ] **Step 6: Validate the new arrays' lengths, early in `generate()`**

In `generate(_:outputDir:)`, right after the existing `segmentGridPanels` validation block (after the `for (i, panel) in segmentGridPanels.enumerated() { ... }` loop, before `try FileManager.default.createDirectory(...)`), add:

```swift
        if let secondsPerSegment = request.secondsPerSegment {
            guard secondsPerSegment.count == request.prompts.count else {
                throw StageError.secondsPerSegmentCountMismatch(count: secondsPerSegment.count, segments: request.prompts.count)
            }
        }
        if let segmentContinuity = request.segmentContinuity {
            guard segmentContinuity.count == request.prompts.count else {
                throw StageError.segmentContinuityCountMismatch(count: segmentContinuity.count, segments: request.prompts.count)
            }
        }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd swift/ltx-video-director && swift test --filter NativeRelayStageTests 2>&1 | tail -40`
Expected: PASS (all tests, including the two new ones — they hit the guard before any model loading, same as the existing fast tests in this file).

- [ ] **Step 8: Wire the arrays into the actual per-segment generation loop**

This step has no new failing-test-first cycle of its own (the real chaining behavior needs a real checkpoint + two full generations, same limitation the file's header already documents for the *existing* chaining behavior) — implement directly, matching the file's established "verified manually via a real run" precedent.

In the `for (index, prompt) in request.prompts.enumerated()` loop, change the `NativeI2VStage.Request` construction:

```swift
            let segNum = index + 1
            print("[relay] ═══ Segment \(segNum)/\(request.prompts.count) ═══")
            let segDir = outputDir.appendingPathComponent("seg\(String(format: "%02d", segNum))")
            try FileManager.default.createDirectory(at: segDir, withIntermediateDirectories: true)

            let segSeconds = request.secondsPerSegment?[index] ?? request.seconds
            var segRequest = NativeI2VStage.Request(
                prompt: prompt, seconds: segSeconds, fps: request.fps,
                width: request.width, height: request.height,
                seed: request.seed &+ UInt64(index),
                t2iTransformer: request.t2iTransformer, textMaxLength: request.textMaxLength,
                loraPaths: request.loraPaths)
```

And in the `else` branch (the non-grid-panel, default continuity path):

```swift
            } else {
                let continueFromPrevious = request.segmentContinuity?[index] ?? true
                segRequest.inputImagePath = continueFromPrevious ? nextInputImage : nil
                if !request.gridFrameIndices.isEmpty {
                    segRequest.gridImagePath = request.gridImagePath
                    segRequest.gridColumns = request.gridColumns
                    segRequest.gridRows = request.gridRows
                    segRequest.gridFrameIndices = request.gridFrameIndices
                    segRequest.gridStrengths = request.gridStrengths
                }
            }
```

(`nextInputImage` is still updated to this segment's own last frame after generation, unchanged — a `false` continuity flag only affects what THIS segment consumes as its own input, not what it hands forward to the next segment.)

- [ ] **Step 9: Accumulate `segmentDurations` and return them**

Add a `var segmentDurations: [Double] = []` alongside the existing `var segmentResults`/`var segmentVideoURLs` declarations before the loop, append inside the loop right after `segmentResults.append(result)`:

```swift
            let result = try stage.generate(segRequest, outputDir: segDir)
            segmentResults.append(result)
            segmentDurations.append(Double(result.frameCount) / request.fps)
```

And update the final `return Result(...)` at the end of the function:

```swift
        return Result(segmentResults: segmentResults, segmentVideoURLs: segmentVideoURLs, finalVideoURL: finalURL, segmentDurations: segmentDurations)
```

- [ ] **Step 10: Run the full Swift test suite**

Run: `cd swift/ltx-video-director && swift test 2>&1 | tail -60`
Expected: PASS (existing tests unaffected; the two new ones pass; no other test constructs a `NativeRelayStage.Result` directly, so the new required field doesn't break anything else — grep first to confirm: `grep -rn "NativeRelayStage.Result(" swift/ltx-video-director/Tests` should show no hits besides this file).

- [ ] **Step 11: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/NativeRelayStage.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeRelayStageTests.swift
git commit -m "feat(ltx-video-director): per-segment duration/continuity arrays in native-relay"
```

---

### Task 3: Swift — `--seconds-per-segment`/`--segment-continuity` CLI flags

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeRelayCommand.swift`

- [ ] **Step 1: Add the two `@Option` properties**

In `NativeRelay: ParsableCommand`, add after the existing `seconds`/`fps` options:

```swift
    @Option(name: .customLong("seconds-per-segment"), parsing: .upToNextOption,
            help: "Per-segment duration override (seconds), one value per --prompts entry. Omit to use --seconds uniformly for every segment.")
    var secondsPerSegment: [Double] = []

    @Option(name: .customLong("segment-continuity"), parsing: .upToNextOption,
            help: "Per-segment continuity override ('true'/'false'), one value per --prompts entry. false = fresh T2I for that segment (hard cut), ignoring the previous segment's last frame. Omit to continue every non-first segment from the previous segment's last frame (default).")
    var segmentContinuity: [Bool] = []
```

- [ ] **Step 2: Wire them into `baseRequest()`**

In `private func baseRequest() throws -> NativeRelayStage.Request`, add before the `return request` line:

```swift
        if !secondsPerSegment.isEmpty { request.secondsPerSegment = secondsPerSegment }
        if !segmentContinuity.isEmpty { request.segmentContinuity = segmentContinuity }
        return request
```

- [ ] **Step 3: Build and smoke-test `--help`**

Run: `cd swift/ltx-video-director && swift build -c release 2>&1 | tail -30`
Expected: build succeeds (this is the first real build after Task 2's changes — expect it to take minutes on a fresh `.build/`).

Run: `.build/release/ltx-video native-relay --help`
Expected: help text lists `--seconds-per-segment` and `--segment-continuity` among the options.

- [ ] **Step 4: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeRelayCommand.swift
git commit -m "feat(ltx-video-director): --seconds-per-segment/--segment-continuity flags"
```

---

### Task 4: TS — `boolean[]` field type + native-relay's new fields in `pi-agent-ext-ltx`

**Files:**
- Modify: `bun-apps/pi-agent-ext-ltx/src/commands.ts`
- Modify: `bun-apps/pi-agent-ext-ltx/src/commands.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `bun-apps/pi-agent-ext-ltx/src/commands.test.ts`, in the `describe("buildArgs", ...)` block (alongside the existing `"native-relay expands prompts/lora/variant as repeated flags"` test):

```ts
  test("native-relay's secondsPerSegment/segmentContinuity emit one flag occurrence per array element", () => {
    const args = buildArgs(COMMANDS["native-relay"], {
      prompts: ["a", "b"],
      secondsPerSegment: [8, 6.5],
      segmentContinuity: [true, false],
    });
    expect(args).toEqual([
      "--prompts", "a", "--prompts", "b",
      "--seconds-per-segment", "8", "--seconds-per-segment", "6.5",
      "--segment-continuity", "true", "--segment-continuity", "false",
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-ltx && bun test src/commands.test.ts -t "secondsPerSegment/segmentContinuity"`
Expected: FAIL — `COMMANDS["native-relay"].fields` has no `secondsPerSegment`/`segmentContinuity` keys, so `buildArgs` silently skips them (`!(key in options)` — actually `key in options` IS true since it's the caller's options, but `key in spec.fields` — re-check: `buildArgs` iterates `spec.fields`, not `options`, so an option key with no matching field spec is never emitted at all). Result: `args` won't contain the new flags → assertion fails.

- [ ] **Step 3: Add the `"boolean[]"` `FieldType`**

In `commands.ts`:

```ts
export type FieldType = "string" | "number" | "int" | "boolean" | "string[]" | "number[]" | "boolean[]";
```

- [ ] **Step 4: Add the `"boolean[]"` case to `fieldSchema`**

```ts
    case "boolean[]":
      return wrap(Type.Array(Type.Boolean(), { description: f.description }));
```

- [ ] **Step 5: Add the `"boolean[]"` case to `buildArgs`**

Change the array-handling block:

```ts
    if (f.type === "string[]" || f.type === "number[]" || f.type === "boolean[]") {
      if (!Array.isArray(v)) {
        throw new Error(`field "${key}" expects an array, got ${typeof v}`);
      }
      // ltx-video's repeatable options (--lora, gate's positional videos) take
      // one flag occurrence per value (ArgumentParser's `parsing: .upToNextOption`
      // / @Argument [String]), not a joined comma-list.
      for (const item of v) args.push(f.flag, f.type === "boolean[]" ? String(Boolean(item)) : fmtScalar(item as number | string));
      continue;
    }
```

- [ ] **Step 6: Add the two new fields to `native-relay`'s spec**

In `COMMANDS["native-relay"].fields`, add after `seconds`:

```ts
      secondsPerSegment: { flag: "--seconds-per-segment", type: "number[]", description: "Per-segment duration override (seconds), one value per prompts entry. Omit to use seconds uniformly for every segment." },
      segmentContinuity: { flag: "--segment-continuity", type: "boolean[]", description: "Per-segment continuity override, one value per prompts entry. false = fresh T2I for that segment (hard cut), ignoring the previous segment's last frame. Omit to continue every non-first segment from the previous segment's last frame (default)." },
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-ltx && bun test src/commands.test.ts`
Expected: PASS (all tests in the file, not just the new one — confirms the new `FieldType` case didn't break existing array-field tests).

- [ ] **Step 8: Verify flag parity against the real CLI**

Run: `cd bun-apps/pi-agent-ext-ltx && bun run scripts/check-flags.ts` (requires Task 3's `swift build -c release` to have completed first)
Expected: no drift reported for `native-relay` (the script asserts every declared `--help` flag is modeled in `commands.ts`).

- [ ] **Step 9: Commit**

```bash
git add bun-apps/pi-agent-ext-ltx/src/commands.ts bun-apps/pi-agent-ext-ltx/src/commands.test.ts
git commit -m "feat(pi-agent-ext-ltx): boolean[] field type, native-relay per-segment duration/continuity"
```

---

### Task 5: `scene_plan` schema — add `continuity`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/data/schemas/artifacts/scene_plan.schema.json`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `bun-apps/pi-agent-ext-movie-director/src/schema.test.ts` (find the scene_plan describe block; if none exists, add a new `describe("scene_plan", ...)`):

```ts
test("scene_plan: a scene may declare continuity 'cut' or 'continue'", () => {
  const scenePlan = {
    version: "1.0",
    scenes: [
      { id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 6, continuity: "cut" },
      { id: "s2", type: "generated", description: "a sphere", start_seconds: 6, end_seconds: 12, continuity: "continue" },
    ],
  };
  expect(validateArtifact("scene_plan", scenePlan).ok).toBe(true);
});

test("scene_plan: continuity rejects values outside 'continue'/'cut'", () => {
  const scenePlan = {
    version: "1.0",
    scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 6, continuity: "maybe" }],
  };
  expect(validateArtifact("scene_plan", scenePlan).ok).toBe(false);
});
```

(Check the top of `schema.test.ts` for the exact `validateArtifact` import path already used by other tests in the file and reuse it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/schema.test.ts -t "continuity"`
Expected: FAIL — the first test fails because `additionalProperties: false` rejects the unrecognized `continuity` key; the second test's intent (reject "maybe") can't even be reached yet since `continuity` isn't a recognized property at all.

- [ ] **Step 3: Add the field to the schema**

In `scene_plan.schema.json`, add a new property to the scene item's `properties` (alongside `hero_moment`, before `character_actions`):

```json
          "continuity": {
            "type": "string",
            "enum": ["continue", "cut"],
            "default": "continue",
            "description": "Chaining behavior into this scene's first generated link during native-relay long-movie assembly. 'continue' (default when omitted) reseeds from the previous scene's last frame; 'cut' starts fresh via T2I — a genuine scene change (new location/time/subject)."
          },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/schema.test.ts`
Expected: PASS (all tests in the file — confirms the new optional property didn't break any existing scene_plan fixture).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/data/schemas/artifacts/scene_plan.schema.json bun-apps/pi-agent-ext-movie-director/src/schema.test.ts
git commit -m "feat(pi-agent-ext-movie-director): scene_plan.continuity field for native-relay chaining"
```

---

### Task 6: `edit_decisions` schema — add top-level `transition`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/data/schemas/artifacts/edit_decisions.schema.json`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `schema.test.ts`:

```ts
test("edit_decisions: top-level transition accepts 'none' or 'crossfade'", () => {
  const edit = {
    version: "1.0",
    render_runtime: "ffmpeg",
    transition: "none",
    cuts: [{ id: "cut-1", source: "/tmp/relay.mp4", in_seconds: 0, out_seconds: 8 }],
  };
  expect(validateArtifact("edit_decisions", edit).ok).toBe(true);
});

test("edit_decisions: transition rejects values outside 'none'/'crossfade'", () => {
  const edit = {
    version: "1.0",
    render_runtime: "ffmpeg",
    transition: "wipe",
    cuts: [{ id: "cut-1", source: "/tmp/relay.mp4", in_seconds: 0, out_seconds: 8 }],
  };
  expect(validateArtifact("edit_decisions", edit).ok).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/schema.test.ts -t "transition"`
Expected: FAIL — `additionalProperties: false` at the top level rejects the unrecognized `transition` key.

- [ ] **Step 3: Add the field to the schema**

In `edit_decisions.schema.json`, add a new top-level property (alongside `render_runtime`, before `composition_mode`):

```json
    "transition": {
      "type": "string",
      "enum": ["none", "crossfade"],
      "description": "Global transition compose-motion applies between cuts. 'none' is required when cuts are trimmed from a single native-relay output whose scene boundaries are already visually continuous (a crossfade would double-blend already-matching frames). Defaults to 'crossfade' behavior when omitted (legacy multi-source edits)."
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/data/schemas/artifacts/edit_decisions.schema.json bun-apps/pi-agent-ext-movie-director/src/schema.test.ts
git commit -m "feat(pi-agent-ext-movie-director): edit_decisions.transition field"
```

---

### Task 7: Rewrite `assets-encoder.ts` — flatten the whole movie into one relay plan

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/assets-encoder.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/assets-encoder.test.ts`

- [ ] **Step 1: Write the failing tests (full replacement of the test file)**

Replace the contents of `assets-encoder.test.ts`:

```ts
/**
 * assets-encoder.test.ts — the proactive asset-generation planner. Pure logic:
 * given a scene_plan + script, flatten every video scene's duration into one
 * ordered RelayLink[] (a single native-relay call executes the whole movie —
 * see driver-wiring.ts's produceAssets), plus one TTS call for the narration.
 */
import { describe, test, expect } from "bun:test";
import { planAssetGeneration } from "./assets-encoder.ts";

const scene = (over: Partial<Record<string, unknown>> = {}) => ({
	id: "s1",
	type: "generated",
	description: "a red cube rotating",
	start_seconds: 0,
	end_seconds: 6,
	...over,
});
const script = { sections: [{ id: "s1", text: "Behold the cube." }] };

describe("planAssetGeneration — relay links", () => {
	test("scene ≤ ceiling → ONE link, seconds = full scene duration", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 6 })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks).toHaveLength(1);
		expect(plan.relayLinks[0]).toMatchObject({ sceneId: "s1", chainIndex: 0, prompt: "a red cube rotating", seconds: 6, continuity: true });
	});

	test("scene 16s → TWO links (ceil(16/8)=2), each 8s", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 16 })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks).toHaveLength(2);
		expect(plan.relayLinks.map((l) => l.chainIndex)).toEqual([0, 1]);
		expect(plan.relayLinks.every((l) => l.seconds === 8)).toBe(true);
	});

	test("scene 20s → THREE links, each 20/3 seconds", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 20 })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks).toHaveLength(3);
		expect(plan.relayLinks.every((l) => Math.abs(l.seconds - 20 / 3) < 1e-9)).toBe(true);
	});

	test("multiple scenes flatten into ONE ordered array across scene boundaries", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ id: "s1", end_seconds: 6 }), scene({ id: "s2", start_seconds: 6, end_seconds: 10 })] } as any,
			script as any,
			{ maxCallSeconds: 8 },
		);
		expect(plan.relayLinks.map((l) => l.sceneId)).toEqual(["s1", "s2"]);
	});

	test("a scene's later links (chainIndex > 0) always continue, regardless of continuity", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 16, continuity: "cut" })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks.map((l) => l.continuity)).toEqual([false, true]);
	});

	test("continuity 'cut' on a scene's first link sets continuity:false; default/'continue' sets true", () => {
		const plan = planAssetGeneration(
			{
				scenes: [
					scene({ id: "s1", end_seconds: 6 }), // no `continuity` field -> default continue
					scene({ id: "s2", start_seconds: 6, end_seconds: 12, continuity: "cut" }),
					scene({ id: "s3", start_seconds: 12, end_seconds: 18, continuity: "continue" }),
				],
			} as any,
			script as any,
			{ maxCallSeconds: 8 },
		);
		expect(plan.relayLinks.map((l) => l.continuity)).toEqual([true, false, true]);
	});

	test("text_card / diagram scenes emit NO relay links", () => {
		const plan = planAssetGeneration({ scenes: [scene({ type: "text_card" }), scene({ type: "diagram" })] } as any, script as any, { maxCallSeconds: 8 });
		expect(plan.relayLinks).toEqual([]);
	});
});

describe("planAssetGeneration — narration", () => {
	test("a tts call is present carrying the script's narration text", () => {
		const plan = planAssetGeneration(
			{ scenes: [scene({ end_seconds: 6 })] } as any,
			{ sections: [{ id: "s1", text: "Hello" }, { id: "s2", text: "world" }] } as any,
			{ maxCallSeconds: 8 },
		);
		expect(plan.tts).toBeTruthy();
		expect(plan.tts!.text).toContain("Hello");
		expect(plan.tts!.text).toContain("world");
	});

	test("narration:'none' skips tts entirely (silent video)", () => {
		const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 6 })] } as any, { narration: "none", sections: [{ id: "s1", text: "Hello" }] } as any, { maxCallSeconds: 8 });
		expect(plan.tts).toBeUndefined();
	});

	test("the tts call is tagged with the first scene's id", () => {
		const plan = planAssetGeneration({ scenes: [scene({ id: "sc1", end_seconds: 6 })] } as any, { sections: [{ id: "s1", text: "Hello" }] } as any, { maxCallSeconds: 8 });
		expect(plan.tts?.sceneId).toBe("sc1");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/assets-encoder.test.ts`
Expected: FAIL — `planAssetGeneration` still returns `{ calls: AssetGenCall[] }`, not `{ relayLinks, tts }`.

- [ ] **Step 3: Rewrite `assets-encoder.ts`**

Replace the full file contents:

```ts
/**
 * assets-encoder.ts — the proactive asset-generation planner.
 *
 * Instead of asking the agent what to generate, the driver COMPUTES the exact
 * native-relay call from scene_plan: every video scene's duration flattens
 * into ONE ordered list of relay links (prompt + per-link duration +
 * continuity flag) across the WHOLE movie, split across a scene's own
 * boundary only when that scene's duration exceeds the practical per-link
 * quality ceiling (maxCallSeconds). A SINGLE native-relay dispatch executes
 * the entire chain natively — the model loads once, last-frame reseed and
 * concatenation happen inside Swift (see driver-wiring.ts's produceAssets).
 *
 * Pure: emits the relay-link list + tts text. Execution (one dispatch("generate",
 * {command:"native-relay", provider:"ltx", ...}) call + per-segment duration
 * probing) is wired in driver-wiring.ts.
 */

/** Scene types that need a real generated video clip, not just an overlay. */
const VIDEO_TYPES = new Set(["generated", "character_scene", "broll", "talking_head"]);

/** One native-relay segment: a single I2V generation within the whole-movie chain. */
export interface RelayLink {
	sceneId: string;
	/** 0-based index within THIS scene's own chain (not the flattened array index). */
	chainIndex: number;
	prompt: string;
	seconds: number;
	/** false = fresh T2I for this link (hard cut); true = continue from the previous link's last frame. */
	continuity: boolean;
}

export interface TtsCall {
	text: string;
	sceneId?: string;
}

export interface AssetPlan {
	relayLinks: RelayLink[];
	tts?: TtsCall;
}

interface SceneLike {
	id: string;
	type: string;
	description: string;
	start_seconds: number;
	end_seconds: number;
	/** Chaining behavior into this scene's FIRST link. Default "continue" when absent. */
	continuity?: "continue" | "cut";
}

interface ScriptLike {
	sections?: Array<{ id?: string; text?: string }>;
	narration?: string;
}

/**
 * Plan the whole movie's asset generation: one flattened list of native-relay
 * links across ALL video scenes in scene_plan order (each scene's duration
 * split across ≤ maxCallSeconds links so no single link exceeds the practical
 * per-link quality ceiling), plus one TTS narration call.
 */
export function planAssetGeneration(
	scenePlan: { scenes: SceneLike[] },
	script: ScriptLike | undefined,
	opts: { maxCallSeconds: number },
): AssetPlan {
	const relayLinks: RelayLink[] = [];

	for (const scene of scenePlan.scenes) {
		const duration = Math.max(0, scene.end_seconds - scene.start_seconds);
		if (!VIDEO_TYPES.has(scene.type) || duration <= 0) continue;

		const linkCount = Math.max(1, Math.ceil(duration / opts.maxCallSeconds));
		const perLinkSeconds = duration / linkCount;
		for (let i = 0; i < linkCount; i++) {
			relayLinks.push({
				sceneId: scene.id,
				chainIndex: i,
				prompt: scene.description,
				seconds: perLinkSeconds,
				// Only a scene's FIRST link can be a hard cut; later links within
				// the same scene are the SAME shot split across the per-link
				// ceiling, so they always continue.
				continuity: i === 0 ? scene.continuity !== "cut" : true,
			});
		}
	}

	let tts: TtsCall | undefined;
	if (script?.narration !== "none") {
		const narrationText =
			script?.narration ?? script?.sections?.map((s) => s.text ?? "").filter(Boolean).join(" ") ?? "";
		if (narrationText.trim()) {
			tts = { text: narrationText, sceneId: scenePlan.scenes[0]?.id };
		}
	}

	return { relayLinks, tts };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/assets-encoder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/assets-encoder.ts bun-apps/pi-agent-ext-movie-director/src/assets-encoder.test.ts
git commit -m "refactor(pi-agent-ext-movie-director): assets-encoder flattens the whole movie into one relay plan"
```

---

### Task 8: Rewrite `produceAssets` — single `native-relay` dispatch

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.test.ts`

This task depends on Task 1 (segment_N artifact shape) and Task 7 (new `AssetPlan` shape).

- [ ] **Step 1: Write the failing tests**

Replace the `describe("wireProduce — assets execution ...", ...)` block in `driver-wiring.test.ts` with:

```ts
describe("wireProduce — assets execution (single native-relay call for the whole movie)", () => {
	function assetsDeps(opts: { segmentDurations?: number[]; ttsDuration?: number } = {}) {
		const genCalls: Record<string, unknown>[] = [];
		const segDurations = opts.segmentDurations ?? [8, 8];
		const dispatchFn: DispatchLike = async (command, callOpts) => {
			if (command !== "generate") return { ok: true, text: JSON.stringify({}) };
			genCalls.push(callOpts);
			const capability = (callOpts as Record<string, unknown>).capability;
			if (capability === "tts") {
				return { ok: true, text: JSON.stringify({ provider: "tts", result: { artifacts: [{ path: "/tmp/narration.wav" }] } }) };
			}
			// native-relay: one artifact per segment (role segment_1, segment_2, ...) + the final mp4 as the primary artifact.
			const segmentArtifacts = segDurations.map((_, i) => ({ path: `/tmp/relay/seg0${i + 1}/segment.mp4`, role: `segment_${i + 1}` }));
			return {
				ok: true,
				text: JSON.stringify({ provider: "ltx", result: { artifacts: [{ path: "/tmp/relay/relay.mp4" }, ...segmentArtifacts] } }),
			};
		};
		const probeDuration = async (path: string) => {
			if (path === "/tmp/narration.wav") return opts.ttsDuration ?? 16;
			const m = path.match(/seg0(\d)\/segment\.mp4$/);
			return m ? segDurations[Number(m[1]) - 1]! : 0;
		};
		return { deps: makeWireDeps({ dispatchFn, probeDuration }), genCalls };
	}

	test("dispatches exactly ONE native-relay call for a two-scene movie, with provider:'ltx'", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: {
				scenes: [
					{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 },
					{ id: "s2", type: "generated", description: "a sphere", start_seconds: 8, end_seconds: 16 },
				],
			},
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const relayCalls = genCalls.filter((c) => c.command === "native-relay");
		expect(relayCalls).toHaveLength(1);
		expect(relayCalls[0]!.provider).toBe("ltx");
		const options = relayCalls[0]!.options as Record<string, unknown>;
		expect(options.prompts).toEqual(["a cube", "a sphere"]);
		expect(options.secondsPerSegment).toEqual([8, 8]);
		expect(options.segmentContinuity).toEqual([true, true]); // no scene declared continuity:"cut"
		expect(options.relayAudio).toBe("/tmp/narration.wav");
	});

	test("a scene with continuity:'cut' sets that scene's first link to false, others stay true", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: {
				scenes: [
					{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 },
					{ id: "s2", type: "generated", description: "a sphere", start_seconds: 8, end_seconds: 16, continuity: "cut" },
				],
			},
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const relayCall = genCalls.find((c) => c.command === "native-relay")!;
		expect((relayCall.options as Record<string, unknown>).segmentContinuity).toEqual([true, false]);
	});

	test("returns a SCHEMA-VALID asset_manifest with scene_boundaries derived from real probed segment durations", async () => {
		const { deps } = assetsDeps({ segmentDurations: [7.5, 8.2] });
		const out = await wireProduce(deps)("assets", {
			scene_plan: {
				scenes: [
					{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 },
					{ id: "s2", type: "generated", description: "a sphere", start_seconds: 8, end_seconds: 16 },
				],
			},
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const manifest = out.asset_manifest as Record<string, unknown>;
		expect(manifest.version).toBe("1.0");
		expect(validateArtifact("asset_manifest", manifest).ok).toBe(true);
		const boundaries = (manifest.metadata as Record<string, unknown>).scene_boundaries as Array<Record<string, unknown>>;
		expect(boundaries).toEqual([
			{ sceneId: "s1", startSeconds: 0, endSeconds: 7.5 },
			{ sceneId: "s2", startSeconds: 7.5, endSeconds: 15.7 },
		]);
	});

	test("narrative_duration_seconds in asset_manifest.metadata comes from the narration wav's real probed duration", async () => {
		const { deps } = assetsDeps({ ttsDuration: 22.4 });
		const out = await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 }] },
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const manifest = out.asset_manifest as Record<string, unknown>;
		expect((manifest.metadata as Record<string, unknown>).narrative_duration_seconds).toBe(22.4);
	});

	test("a scene_plan with no video scenes dispatches no native-relay call", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "text_card", description: "title", start_seconds: 0, end_seconds: 3 }] },
			script: { narration: "none" },
		});
		expect(genCalls.filter((c) => c.command === "native-relay")).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts -t "assets execution"`
Expected: FAIL — `produceAssets` still dispatches per-link `t2i2v` calls, not one `native-relay` call.

- [ ] **Step 3: Rewrite `produceAssets` in `driver-wiring.ts`**

Replace the imports at the top:

```ts
import { runCompletionWaypoint, runAgentWaypoint, pickProducer, type WaypointDeps } from "./waypoints.ts";
import { planAssetGeneration } from "./assets-encoder.ts";
```

(drop `AssetGenCall` from the import — it no longer exists.)

Replace `WireDeps`'s doc comment on `extractLastFrame` for now (full removal happens in Task 11 — leave the field in place this task to avoid touching `dispatch.ts` twice; just stop reading it from `produceAssets`).

Replace `firstArtifactPath` and add a new helper right after it:

```ts
/** Pull the first produced file path out of a generate result (shape varies by director). */
function firstArtifactPath(result: unknown): string | undefined {
	const r = result as { result?: { artifacts?: Array<{ path?: string }> }; artifacts?: Array<{ path?: string }> };
	return r?.result?.artifacts?.[0]?.path ?? r?.artifacts?.[0]?.path;
}

/** Ordered per-segment clip paths from a native-relay generate() response —
 *  artifacts with role "segment_1", "segment_2", ... (see adaptLtx / result.ts's
 *  buildNativeRelayDetails). Order is the numeric suffix, not array position. */
function relaySegmentPaths(result: unknown): string[] {
	const r = result as { result?: { artifacts?: Array<{ path?: string; role?: string }> }; artifacts?: Array<{ path?: string; role?: string }> };
	const artifacts = r?.result?.artifacts ?? r?.artifacts ?? [];
	return artifacts
		.filter((a): a is { path: string; role: string } => typeof a.role === "string" && /^segment_\d+$/.test(a.role) && typeof a.path === "string")
		.sort((a, b) => Number(a.role.slice(8)) - Number(b.role.slice(8)))
		.map((a) => a.path);
}
```

Replace the entire `produceAssets` function:

```ts
/** Execute the proactive asset plan: one TTS call, then ONE native-relay call for the whole movie. */
async function produceAssets(
	deps: WireDeps,
	fps: number,
	maxCallSeconds: number,
	inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const scenePlan = inputs.scene_plan as { scenes: unknown[] } | undefined;
	const script = inputs.script as Record<string, unknown> | undefined;
	if (!scenePlan) throw new Error("assets: missing scene_plan input");
	const plan = planAssetGeneration(scenePlan as never, script as never, { maxCallSeconds });
	const probe = deps.probeDuration ?? (async () => 0);

	const assets: Array<Record<string, unknown>> = [];
	let narrationPath: string | undefined;
	let narrativeDurationSeconds = 0;

	if (plan.tts) {
		const res = await deps.dispatchFn("generate", {
			capability: "tts",
			command: "tts",
			options: { text: plan.tts.text },
			projectId: deps.projectId,
			pipeline: deps.pipeline,
		});
		if (!res.ok) throw new Error(`assets generate tts failed: ${res.error}`);
		const parsed = JSON.parse(res.text) as { provider?: string };
		narrationPath = firstArtifactPath(JSON.parse(res.text));
		if (narrationPath) narrativeDurationSeconds = await probe(narrationPath);
		assets.push({
			id: "narration",
			type: "narration",
			path: narrationPath ?? "",
			source_tool: parsed.provider ?? "tts",
			scene_id: plan.tts.sceneId ?? "",
			generation_summary: "generated via tts",
			...(narrativeDurationSeconds > 0 ? { duration_seconds: Math.round(narrativeDurationSeconds * 1000) / 1000 } : {}),
		});
	}

	const sceneBoundaries: Array<{ sceneId: string; startSeconds: number; endSeconds: number }> = [];

	if (plan.relayLinks.length > 0) {
		const res = await deps.dispatchFn("generate", {
			capability: "video_generation",
			command: "native-relay",
			provider: "ltx",
			options: {
				prompts: plan.relayLinks.map((l) => l.prompt),
				secondsPerSegment: plan.relayLinks.map((l) => l.seconds),
				segmentContinuity: plan.relayLinks.map((l) => l.continuity),
				fps,
				...(narrationPath ? { relayAudio: narrationPath } : {}),
			},
			projectId: deps.projectId,
			pipeline: deps.pipeline,
		});
		if (!res.ok) throw new Error(`assets generate native-relay failed: ${res.error}`);
		const parsed = JSON.parse(res.text) as { provider?: string };
		const relayMp4Path = firstArtifactPath(JSON.parse(res.text)) ?? "";
		const segmentPaths = relaySegmentPaths(JSON.parse(res.text));

		let cursor = 0;
		for (let i = 0; i < plan.relayLinks.length; i++) {
			const link = plan.relayLinks[i]!;
			const segPath = segmentPaths[i];
			const dur = segPath ? await probe(segPath) : 0;
			const start = cursor;
			cursor += dur;
			if (link.chainIndex === 0) {
				sceneBoundaries.push({ sceneId: link.sceneId, startSeconds: start, endSeconds: cursor });
			} else {
				sceneBoundaries[sceneBoundaries.length - 1]!.endSeconds = cursor;
			}
		}

		assets.push({
			id: "relay-movie",
			type: "video",
			path: relayMp4Path,
			source_tool: parsed.provider ?? "native-relay",
			scene_id: sceneBoundaries[0]?.sceneId ?? "",
			generation_summary: `generated via native-relay (${plan.relayLinks.length} link(s))`,
			duration_seconds: Math.round(cursor * 1000) / 1000,
		});
	}

	return {
		asset_manifest: {
			version: "1.0",
			assets,
			metadata: { scene_boundaries: sceneBoundaries, narrative_duration_seconds: narrativeDurationSeconds },
		},
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts -t "assets execution"`
Expected: PASS

- [ ] **Step 5: Run the whole package's test suite (some other tests reference the old shape and need fixing here or in Task 9/10/11)**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts 2>&1 | tail -60`
Expected: the `"executes the plan with frames = ceil(duration × fps)"` and `"chaining: a >8s scene ..."` tests (from the OLD assets-execution describe block) are gone since Step 1 replaced that whole block — confirm no leftover references to the old block remain by searching: `grep -n "options.frames\|chainIndex" src/driver-wiring.test.ts` should return nothing. The `edit`/`compose`/`publish` describe blocks will fail until Tasks 9/10 land — that's expected at this point in the plan; do not attempt to fix them here.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts bun-apps/pi-agent-ext-movie-director/src/driver-wiring.test.ts
git commit -m "refactor(pi-agent-ext-movie-director): produceAssets dispatches one native-relay call"
```

---

### Task 9: Rewrite `produceEdit` — scene-boundary cuts on a shared source

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the `describe("wireProduce — deterministic edit ...", ...)` block:

```ts
describe("wireProduce — deterministic edit (scene-boundary cuts on the shared relay source)", () => {
	test("builds schema-valid edit_decisions with one cut per scene boundary, all sharing the relay mp4 as source, transition:none", async () => {
		const out = await wireProduce(makeWireDeps())("edit", {
			asset_manifest: {
				version: "1.0",
				assets: [{ id: "relay-movie", type: "video", path: "/tmp/relay/relay.mp4", source_tool: "native-relay", scene_id: "s1", duration_seconds: 15.7 }],
				metadata: {
					scene_boundaries: [
						{ sceneId: "s1", startSeconds: 0, endSeconds: 7.5 },
						{ sceneId: "s2", startSeconds: 7.5, endSeconds: 15.7 },
					],
				},
			},
		});
		const edit = out.edit_decisions as Record<string, unknown>;
		expect(edit.version).toBe("1.0");
		expect(edit.render_runtime).toBe("ffmpeg");
		expect(edit.transition).toBe("none");
		const cuts = edit.cuts as Array<Record<string, unknown>>;
		expect(cuts).toEqual([
			{ id: "cut-s1", source: "/tmp/relay/relay.mp4", in_seconds: 0, out_seconds: 7.5 },
			{ id: "cut-s2", source: "/tmp/relay/relay.mp4", in_seconds: 7.5, out_seconds: 15.7 },
		]);
		expect(validateArtifact("edit_decisions", edit).ok).toBe(true);
	});

	test("no video asset / no scene_boundaries → empty cuts (still schema-valid)", async () => {
		const out = await wireProduce(makeWireDeps())("edit", { asset_manifest: { version: "1.0", assets: [], metadata: {} } });
		const edit = out.edit_decisions as Record<string, unknown>;
		expect(edit.cuts).toEqual([]);
		expect(validateArtifact("edit_decisions", edit).ok).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts -t "deterministic edit"`
Expected: FAIL — `produceEdit` still builds one cut per `type:"video"` asset using `probeDuration`, not one cut per `scene_boundaries` entry.

- [ ] **Step 3: Rewrite `produceEdit`**

Replace the function:

```ts
/** edit → deterministic edit_decisions: one cut per SCENE BOUNDARY, all sharing
 *  the single native-relay output as source (produceAssets already probed each
 *  segment's REAL duration to build scene_boundaries — no source-clip-per-cut
 *  files anymore). transition:"none" because the relay's segments are already
 *  visually continuous (last-frame reseed inside Swift); a crossfade here would
 *  double-blend already-matching frames. No LLM — deterministic like before. */
async function produceEdit(deps: WireDeps, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
	const manifest = inputs.asset_manifest as
		| { assets?: Array<{ type?: string; path?: string }>; metadata?: { scene_boundaries?: Array<{ sceneId: string; startSeconds: number; endSeconds: number }> } }
		| undefined;
	if (!manifest?.assets) throw new Error("edit: missing asset_manifest input");
	const relayAsset = manifest.assets.find((a) => a.type === "video" && a.path);
	const boundaries = manifest.metadata?.scene_boundaries ?? [];
	const cuts =
		relayAsset?.path && boundaries.length > 0
			? boundaries.map((b) => ({ id: `cut-${b.sceneId}`, source: relayAsset.path!, in_seconds: b.startSeconds, out_seconds: b.endSeconds }))
			: [];
	return { edit_decisions: { version: "1.0", render_runtime: "ffmpeg", transition: "none", cuts } };
}
```

(`deps.probeDuration` is no longer used by `produceEdit` — leave it on `WireDeps` since `produceAssets` still needs it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts -t "deterministic edit"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts bun-apps/pi-agent-ext-movie-director/src/driver-wiring.test.ts
git commit -m "refactor(pi-agent-ext-movie-director): produceEdit builds scene-boundary cuts on the shared relay source"
```

---

### Task 10: `produceCompose` — thread `narrativeDurationSeconds` into the (now-blocking) gate

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

In the `describe("wireProduce — compose / publish", ...)` block, replace the existing `"compose → dispatch compose-motion with render_runtime ffmpeg"` test and add one more:

```ts
	test("compose → dispatch compose-motion with render_runtime ffmpeg AND narrativeDurationSeconds from asset_manifest.metadata", async () => {
		const calls: Record<string, unknown>[] = [];
		const dispatchFn: DispatchLike = async (command, opts) => {
			calls.push({ command, opts });
			if (command === "compose-motion") return { ok: true, text: JSON.stringify({ output: "/tmp/final.mp4", render_grammar: "motion" }) };
			return { ok: true, text: JSON.stringify({ ok: true }) };
		};
		await wireProduce(makeWireDeps({ dispatchFn }))("compose", {
			edit_decisions: { version: "1.0", cuts: [], render_runtime: "ffmpeg", transition: "none" },
			asset_manifest: { version: "1.0", assets: [], metadata: { narrative_duration_seconds: 22.4 } },
		});
		const compose = calls.find((c) => c.command === "compose-motion")!;
		expect((compose.opts as Record<string, unknown>).narrativeDurationSeconds).toBe(22.4);
	});

	test("compose → omits narrativeDurationSeconds when asset_manifest carries none (e.g. silent video)", async () => {
		const calls: Record<string, unknown>[] = [];
		const dispatchFn: DispatchLike = async (command, opts) => {
			calls.push({ command, opts });
			if (command === "compose-motion") return { ok: true, text: JSON.stringify({ output: "/tmp/final.mp4" }) };
			return { ok: true, text: JSON.stringify({ ok: true }) };
		};
		await wireProduce(makeWireDeps({ dispatchFn }))("compose", { edit_decisions: { version: "1.0", cuts: [], render_runtime: "ffmpeg" } });
		const compose = calls.find((c) => c.command === "compose-motion")!;
		expect(compose.opts).not.toHaveProperty("narrativeDurationSeconds");
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts -t "compose"`
Expected: FAIL — `produceCompose` doesn't read `inputs.asset_manifest` or pass `narrativeDurationSeconds` today.

- [ ] **Step 3: Update `produceCompose`**

Change the function's opening lines:

```ts
async function produceCompose(deps: WireDeps, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
	const edit = inputs.edit_decisions as Record<string, unknown> | undefined;
	if (!edit) throw new Error("compose: missing edit_decisions input");
	const manifest = inputs.asset_manifest as { metadata?: { narrative_duration_seconds?: number } } | undefined;
	const narrativeDurationSeconds = manifest?.metadata?.narrative_duration_seconds;
	const res = await deps.dispatchFn("compose-motion", {
		editDecisions: edit,
		projectId: deps.projectId,
		render_runtime: "ffmpeg",
		...(narrativeDurationSeconds ? { narrativeDurationSeconds } : {}),
	});
	if (!res.ok) throw new Error(`compose-motion failed: ${res.error}`);
	// ... rest of the function (renderReport / final_review) is UNCHANGED below this point.
```

(The rest of the function — `renderMp4Path`, `narrationMode`, the `final-review` dispatch — stays exactly as it is today; only the lines shown above change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts -t "compose"`
Expected: PASS

- [ ] **Step 5: Run the FULL driver-wiring test suite (everything from Tasks 8-10 together)**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts`
Expected: PASS (all tests in the file — this is the first point where the whole assets → edit → compose → publish chain is internally consistent again).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts bun-apps/pi-agent-ext-movie-director/src/driver-wiring.test.ts
git commit -m "feat(pi-agent-ext-movie-director): produceCompose threads narrativeDurationSeconds into the blocking precompose gate"
```

---

### Task 11: Remove the now-dead `extractLastFrame` plumbing

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/assets-runtime.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/assets-runtime.test.ts` (if it exists — check first)

Native-relay now owns last-frame chaining internally (Task 2); nothing in `produceAssets` calls `extractLastFrame` anymore since Task 8. This task deletes the now-unreferenced plumbing rather than leaving it as dead code.

- [ ] **Step 1: Confirm nothing else references it**

Run: `grep -rn "extractLastFrame\|defaultExtractLastFrame" bun-apps/pi-agent-ext-movie-director/src/*.ts`
Expected output: only `driver-wiring.ts` (the `WireDeps.extractLastFrame` field declaration, now unused), `dispatch.ts` (the wiring line), and `assets-runtime.ts` (the function definition + its own file header comment) — no other call sites. If `assets-runtime.test.ts` exists and tests `defaultExtractLastFrame`, note it for Step 4.

- [ ] **Step 2: Remove from `driver-wiring.ts`**

Remove the `extractLastFrame` field from the `WireDeps` interface:

```ts
export interface WireDeps {
	dispatchFn: DispatchLike;
	waypointDeps: WaypointDeps;
	projectId: string;
	pipeline?: string;
	fps?: number;
	maxCallSeconds?: number;
	/** Probe a clip's REAL duration in seconds (ffprobe at runtime; injected in tests). */
	probeDuration?: (path: string) => Promise<number>;
}
```

(Removed the `extractLastFrame` field and its doc comment.)

- [ ] **Step 3: Remove from `dispatch.ts`**

In the `run-pipeline` case, remove the `extractLastFrame` line from the `wireProduce({...})` call:

```ts
          produce: wireProduce({
            dispatchFn: inner,
            waypointDeps,
            projectId,
            pipeline,
            ...(deps?.probeDuration ? { probeDuration: deps.probeDuration } : { probeDuration: (p: string) => Promise.resolve(defaultProbeDuration(p)) }),
          }),
```

Update the import line that currently reads `import { defaultExtractLastFrame, defaultProbeDuration } from "./assets-runtime.ts";` to drop `defaultExtractLastFrame`:

```ts
import { defaultProbeDuration } from "./assets-runtime.ts";
```

Also remove `extractLastFrame` from the `DriverDeps`-adjacent options type in `dispatch.ts` around line 339 (`extractLastFrame?: (clipPath: string) => Promise<string>;`) — delete that line from whatever interface it's declared on.

- [ ] **Step 4: Remove `defaultExtractLastFrame` from `assets-runtime.ts`**

Delete the `defaultExtractLastFrame` function and its imports that become unused (`spawn` from `node:child_process`, `basename`/`dirname`/`join` from `node:path` — check whether `defaultProbeDuration` still needs any of them; it uses `spawnSync`, not `spawn`, and no path helpers, so `spawn`, `basename`, `dirname`, `join` all become unused). Update the file's header comment (currently describes `defaultExtractLastFrame` as the main export) to describe only `defaultProbeDuration`.

If `bun-apps/pi-agent-ext-movie-director/src/assets-runtime.test.ts` exists, remove any test cases for `defaultExtractLastFrame` there too (check the file first with `find bun-apps/pi-agent-ext-movie-director/src -iname "assets-runtime.test.ts"`).

- [ ] **Step 5: Run the full package test suite**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test`
Expected: PASS (no test references the removed field/function anymore).

- [ ] **Step 6: Typecheck (if the package has one)**

Run: `cd bun-apps/pi-agent-ext-movie-director && bunx tsc --noEmit` (skip if the package has no `tsconfig.json` typecheck script — check `package.json` scripts first)
Expected: no new errors introduced by the removed exports/imports.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts bun-apps/pi-agent-ext-movie-director/src/dispatch.ts bun-apps/pi-agent-ext-movie-director/src/assets-runtime.ts
git commit -m "refactor(pi-agent-ext-movie-director): remove dead extractLastFrame plumbing (native-relay owns chaining now)"
```

---

### Task 12: Verification — flag parity + end-to-end regression rerun

**Files:** none (verification only)

- [ ] **Step 1: Full monorepo test sweep**

Run: `( cd bun-apps/pi-agent-ext-ltx && bun test )`
Expected: PASS

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: PASS

Run: `( cd swift/ltx-video-director && swift test )`
Expected: PASS

- [ ] **Step 2: Schema validation smoke check**

Run: `bun run --cwd bun-apps/gui-movie-director check:schema` (per CLAUDE.md's Testing section — validates schemas against run.py; confirms the `scene_plan`/`edit_decisions` additions from Tasks 5/6 don't break the cross-check).
Expected: no drift reported.

- [ ] **Step 3: Real end-to-end regression — rerun the `optical-hall-detective` script**

This is the concrete regression case the design doc cites (`receipts/real-e2e-20260711-optical-hall-detective.md`: 120s script / 162.9s narration composed into only 56.28s of video). Locate that script's original topic/prompt from the receipt file, rerun it through `run-pipeline` with the SAME topic, and confirm:
1. The composed video's duration now tracks the narration's real probed duration (not a flat `N × 8s`).
2. If it's still short, `precompose-gate`'s `narrative_duration_vs_script` check now actually FAILS the pipeline (rather than silently publishing) — confirming the gate is truly wired and blocking, per decision 4, even if the upstream scene_plan duration-sizing (the "proactive layer," intentionally out of scope for this plan — see the design doc's explicit exclusions) still needs future prompt-level tuning.

Run: `python/venv/bin/python python/mlx-movie-director/run.py --self-test` is NOT the right entry point for this — instead drive it through the actual pi-agent-ext-movie-director `run-pipeline` command the same way the original receipt did (check the receipt file's header for the exact invocation used, e.g. via the `dispatch("run-pipeline", {topic: "...", pipeline: "..."})` path or the CLI wrapper it documents).
Expected: either a materially longer, coherent composed video, OR a clear pipeline failure citing `narrative_duration_vs_script`/`motion_coverage_vs_scene` — NOT a silent short-video publish like the original run.

- [ ] **Step 4: Report findings**

Write a short receipt (following the existing convention in `bun-apps/pi-agent-ext-movie-director/receipts/`) documenting the rerun's outcome, named `receipts/real-e2e-<date>-native-relay-long-movie-regression.md`, mirroring the structure of `real-e2e-20260711-optical-hall-detective.md`.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/receipts/
git commit -m "docs(pi-agent-ext-movie-director): native-relay long-movie regression rerun receipt"
```

---

## Self-review notes

- **Spec coverage:** all 8 design decisions are covered — Task 1-3 (Swift backend + fixed artifact shape), Task 4 (flag plumbing), Task 8 (`provider:"ltx"` → `ensureBinary()` satisfies decision 7 without new preflight code), Task 8 (whole-movie single call, decision 6), Task 5/7/8 (continuity scope, decision 3), Task 8/10 (blocking duration gate, decision 4), Task 9/10 (edit/compose simplification, decision 8). Decision 5 (distilled-only acceptable) requires no code — it's the absence of a `--transformer` override, already the default. The design doc's "proactive" scene_plan-duration-derivation layer is intentionally excluded from this plan (it's LLM prompt guidance, not a testable code change) — the blocking gate (Task 10) is the enforced mechanism; this is called out explicitly in Task 12 Step 3.
- **Placeholder scan:** no TBD/TODO; every step shows real code or a real runnable command.
- **Type consistency:** `RelayLink`/`AssetPlan`/`TtsCall` (Task 7) are the types `produceAssets` (Task 8) consumes — verified field names (`sceneId`, `chainIndex`, `prompt`, `seconds`, `continuity`) match exactly between the two tasks. `scene_boundaries`/`narrative_duration_seconds` keys in `asset_manifest.metadata` (Task 8) match what `produceEdit` (Task 9) and `produceCompose` (Task 10) read. `segment_N` role naming (Task 1) matches `relaySegmentPaths`'s regex (Task 8).
