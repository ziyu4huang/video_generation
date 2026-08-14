# Image-card model + extractor (ticket 07) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kind=image` cards to the hermes store (knowledge front-matter extended with `format`/`dimensions`/`locator`, merged OCR+vision content, text-embed only) and extend file2md with an image-extraction branch that OCRs via a new one-shot Swift Vision CLI and describes via the shared lm-studio VLM.

**Architecture:** hermes gains a fifth vault serializer — `ImageSerializer` — that reuses the knowledge zettel envelope (id/created/tags/entities/title) extended with the three image fields; `KnowledgeSerializer` learns to *reject* `record_type: image` files so dispatch is unambiguous, and the store's registries/schema widen by one kind. file2md gains `src/image/` (new input branch following its existing strategy pattern): `runVisionOcr` spawns `swift/vision-ocr-cli` (one-shot SPM binary, macOS Vision framework, JSON stdout) via `Bun.spawn`, `askImageDescribe` rides the existing `askImage` VLM seam (lm-studio `google/gemma-4-12b-qat`), and `extractImageCard` merges both into one atomic vault-md card with 02-style provenance hashes. The emitted card embeds through the **unchanged** walk-and-ingest text-embed path (default embed kinds widen to `["knowledge", "image"]`); a missing lm-studio/model degrades to an OCR-only card with a warning.

**Spec:** `.planning/2026-08-08-knowledge-pipeline/tickets/07-image-card-and-extractor.md` — Resolution quoted verbatim below (LOAD-BEARING; every decision maps to a task) — and `.planning/2026-08-08-knowledge-pipeline/specs/2026-08-08-hermes-card-store.md` (the store contract this extends).

> **Resolution (grill closed 2026-08-14)**
>
> All 5 decisions settled by the user:
>
> 1. **Card schema (kind=image)**: REUSE ticket 02's provenance front-matter, EXTEND with image-specific fields (`format`, `dimensions`, `locator`). `content` = single merged field (OCR text + vision-LLM description) — per the 2026-08-08 grill that chose BOTH OCR + vision-LLM merged into one card.
> 2. **Embed strategy**: text-embed ONLY of the merged content (consistent with the text pipeline; goes to SurrealDB HNSW). CLIP-style image-vector stays fog/future (would be SurrealDB-only per the DB rule) — do not implement now.
> 3. **Extractor placement**: EXTEND file2md (owns pdf=mupdf; reuses 02's extractor seam/pattern). OCR library = macOS Vision framework (swift-native), zero new deps.
> 4. **Chunking**: atomic — one image = one card. Multi-panel splitting stays fog.
> 5. **OCR bridge**: one-shot standalone Swift CLI invoked via subprocess. embed-mlx-server stays single-purpose; do NOT add OCR to it or touch its LaunchAgent.
>
> Fact item (not a decision): model id `google/gemma-4-12b-qat` availability in lm-studio to be verified at impl time by the implementer (the ticket Question already required this).

**Tech Stack:** TypeScript on Bun (both `bun-apps` packages), Swift 6 / SPM (macOS Vision + CoreGraphics + ImageIO, zero external deps), `yaml` pkg (hermes only — file2md hand-emits its scalar YAML), `node:crypto` sha256.

## Global Constraints

- Platform: Apple Silicon, Bun. Type-check with `bunx tsc --noEmit` inside the owning package; tests via `bun test` inside the owning package.
- NEVER use a top-level `cd` — always `( cd <dir> && ... )` or `--cwd`.
- NEVER `git add -A` — stage exact paths only.
- All written artifacts (code, comments, commit messages, docs) in English.
- **`swift/embed-mlx-server/` is OFF-LIMITS** — read-only build-convention reference; do not modify it, its LaunchAgent, or its Package.swift (Resolution #5).
- The Swift OCR CLI is built with `swift build` inside `swift/vision-ocr-cli/` (Resolution #5: one-shot subprocess bridge, no server, no LaunchAgent).
- **lm-studio availability check at impl time** (Resolution fact item): before Task 3, run `curl -s http://localhost:1234/v1/models` and confirm `google/gemma-4-12b-qat` is listed. If absent, proceed anyway — the design degrades to OCR-only cards with a warning — and record the miss in the PR description.
- Bun workspace: run `bun install` / `bun add` from `bun-apps/` (or inside the owning package dir), never the repo root; never commit `package-lock.json`.
- `<WT>` = the repo worktree root. All `git -C <WT>` calls use it.
- file2md has NO `yaml` dependency — the image-card builder hand-emits YAML (scalar-only values, safe without a serializer).
- CLIP / image-vector embedding is explicitly out of scope (Resolution #2: fog).

## File Structure (all changes)

```
swift/vision-ocr-cli/                          # NEW (T2) — one-shot Vision OCR CLI
  Package.swift                                 # SPM, zero external deps, macOS .v15
  Sources/VisionOCRCli/main.swift               # arg/stdin path → JSON {text,width,height,format} on stdout
  fixtures/make-fixture.swift                   # one-shot generator for the committed test fixture
  fixtures/hello-123.png                        # committed fixture (800x200, "HELLO 123")
bun-apps/pi-agent-ext-file2md/src/image/        # NEW (T2/T3) — image input branch
  ocr.ts                                        # runVisionOcr — Bun.spawn bridge to the Swift CLI
  ocr-cli.test.ts                               # T2 integration test (spawns the built binary; skips if absent)
  image-card.ts                                 # pure builders: hashes, id, merged content, vault-md emission
  extract-image.ts                              # extractImageCard orchestrator + isImageFile + askImageDescribe
  extract-image.test.ts                         # T3 unit tests (mocked ocr/describe injectables)
bun-apps/pi-agent-ext-file2md/src/index.ts      # MODIFY (T3) — export barrel += ./image/*
bun-apps/pi-agent-ext-hermes-memory/src/store/
  card.ts                                       # MODIFY (T1) — CardKind union += "image" (:8-14)
  image-serializer.ts                           # NEW (T1) — CardSerializer<"image">
  image-serializer.test.ts                      # NEW (T1)
  knowledge-serializer.ts                       # MODIFY (T1) — deserialize rejects record_type:"image" (:125-127)
  card-store.ts                                 # MODIFY (T1) — serializer+dedup registries (:155-171), persistableKinds (:201)
  sqlite/schema.ts                              # MODIFY (T1) — memories.target CHECK += 'image' (:75)
bun-apps/pi-agent-ext-hermes-memory/src/
  walk-and-ingest.ts                            # MODIFY (T4) — default embed kinds += "image" (:285, doc :30-37)
  image-card-ingest.test.ts                     # NEW (T4) — cross-package e2e (file2md → hermes embed path)
bun-apps/pi-agent-ext-hermes-memory/package.json # MODIFY (T4) — devDependencies += @repo/pi-agent-ext-file2md
```

---

### Task 1: hermes `kind=image` — CardKind, ImageSerializer, registry/schema widening

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts:8-14` (the `CardKind` union)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/knowledge-serializer.ts:119-127` (`deserialize` head — insert the guard right after `if (!isValidZettel(data)) return [];` at line 126)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts:155-171` (serializer + dedup registry maps), `:201` (`persistableKinds` set)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts:75` (`target TEXT ... CHECK (target IN (...))`)
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/image-serializer.ts`
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/store/image-serializer.test.ts`

**Interfaces:**
- Consumes: `Card`/`CardKind` from `./card.js`; `CardSerializer<K>` from `./card-serializer.ts` (`readonly kind: K; serialize(card: Card): string; deserialize(fileBytes: string, opts?: { filePath?: string }): Card[]`); `splitFencedYaml` from `./frontmatter-codec.js` (returns `{ data, body } | null`); `stringify` from `yaml`; `KnowledgeDedupStrategy` from `./knowledge-dedup.js` (idempotent upsert by `Card.id` — image ids are content-addressed, so the same strategy fits).
- Produces: `CardKind` including `"image"`; `export class ImageSerializer implements CardSerializer<"image">`; `export interface ImageDimensions { width: number; height: number }`.

- [ ] **Step 1: Write the failing test** `src/store/image-serializer.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { ImageSerializer } from "./image-serializer.js";
import { KnowledgeSerializer } from "./knowledge-serializer.js";

const IMAGE_MD = [
  "---",
  "id: img-deadbeef",
  "created: '2026-08-14'",
  "tags:",
  "  - zettel",
  "  - image",
  "record_type: image",
  "source_file: /abs/shot.png",
  "source_hash: aabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabbaabb",
  "content_hash: ccddccddccddccddccddccddccddccddccddccddccddccddccddccddccddccdd",
  "extractor: vision-ocr+google/gemma-4-12b-qat",
  "format: png",
  "dimensions:",
  "  width: 800",
  "  height: 200",
  "locator: shot.png",
  "---",
  "# img-deadbeef",
  "",
  "## 核心想法",
  "OCR:",
  "HELLO 123",
  "",
  "Vision:",
  "A white image with the text HELLO 123.",
].join("\n");

const PLAIN_ZETTEL = [
  "---",
  "id: z-1",
  "created: '2026-08-14'",
  "tags:",
  "  - zettel",
  "record_type: lever",
  "---",
  "# z-1",
  "",
  "## 核心想法",
  "some lever text",
].join("\n");

describe("ImageSerializer (kind=image)", () => {
  const ser = new ImageSerializer();

  it("deserialize parses an image card (merged content + image fields + provenance)", () => {
    const cards = ser.deserialize(IMAGE_MD);
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.equal(c.kind, "image");
    assert.equal(c.id, "img-deadbeef");
    assert.match(c.content, /HELLO 123/);          // merged OCR …
    assert.match(c.content, /Vision:/);            // … + vision description in ONE field
    assert.equal(c.frontmatter.record_type, "image");
    assert.deepEqual(c.frontmatter.dimensions, { width: 800, height: 200 });
    assert.equal(c.frontmatter.format, "png");
    assert.equal(c.frontmatter.locator, "shot.png");
    assert.match(String(c.frontmatter.source_hash), /^[0-9a-f]{64}$/);
    assert.match(String(c.frontmatter.content_hash), /^[0-9a-f]{64}$/);
  });

  it("deserialize returns [] for a plain knowledge zettel (no image fields)", () => {
    assert.deepEqual(ser.deserialize(PLAIN_ZETTEL), []);
  });

  it("serialize→deserialize round-trips an image card", () => {
    const [c] = ser.deserialize(IMAGE_MD)!;
    const [c2] = ser.deserialize(ser.serialize(c!))!;
    assert.deepEqual(c2, c);
  });

  it("KnowledgeSerializer rejects record_type: image files (dispatch disambiguation)", () => {
    assert.deepEqual(new KnowledgeSerializer().deserialize(IMAGE_MD), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/image-serializer.test.ts )` — Expected: FAIL (cannot resolve `./image-serializer.js`; and `"image"` not assignable to `CardKind` in later steps).

- [ ] **Step 3: Widen `CardKind`** in `src/store/card.ts` — add `| "image"` to the union at lines 8-14 (after `"planning-ticket"`), extending the doc comment with: `image cards (ticket 07): knowledge zettel envelope + format/dimensions/locator; content = merged OCR+vision text; atomic one-image-one-card.`

- [ ] **Step 4: Write** `src/store/image-serializer.ts`:
```ts
// src/store/image-serializer.ts — ticket 07: kind=image vault-md serializer.
//
// Reuses the knowledge zettel envelope (id/created/tags/entities/relations/
// title carrier — same `## 核心想法` body shape as KnowledgeSerializer) and
// EXTENDS it with the image fields (format, dimensions, locator) plus 02's
// provenance keys (source_file, source_hash, content_hash, extractor).
// `content` = the single merged field (OCR text + vision-LLM description)
// written by file2md's extractImageCard. Atomic: one image = one card.
// `Card.graph` stays undefined for image cards in this ticket (file2md emits
// no `## 連結` section); entities/relations ride the envelope and round-trip
// through `{ ...data }` untouched.
import { stringify as stringifyYaml } from "yaml";
import type { Card } from "./card.js";
import type { CardSerializer } from "./card-serializer.js";
import { splitFencedYaml } from "./frontmatter-codec.js";

const CORE_IDEA_HEADER = "## 核心想法";

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Base zettel validation (mirrors KnowledgeSerializer.isValidZettel): id +
 *  created + non-empty tags whose first entry is the literal "zettel". */
function isValidZettel(data: Record<string, unknown>): boolean {
  if (data.id == null || data.id === "") return false;
  if (data.created == null || data.created === "") return false;
  if (!Array.isArray(data.tags) || data.tags.length === 0) return false;
  return String(data.tags[0]).toLowerCase() === "zettel";
}

/** Image-specific validation: record_type "image" + format + dimensions +
 *  locator. A file missing ANY of these is NOT an image card (→ []), so a
 *  plain knowledge zettel never lands here. */
function isImageCard(data: Record<string, unknown>): boolean {
  if (String(data.record_type ?? "") !== "image") return false;
  if (typeof data.format !== "string" || data.format === "") return false;
  const d = data.dimensions as Partial<ImageDimensions> | undefined;
  if (typeof d !== "object" || d === null) return false;
  if (typeof d.width !== "number" || typeof d.height !== "number") return false;
  if (typeof d.locator !== "string" || data.locator === "") return false;
  return true;
}

function extractTitle(body: string): string | undefined {
  const m = body.match(/^# (.+)$/m);
  return m ? m[1]!.trim() : undefined;
}

function extractSection(body: string, header: string): string | null {
  const lines = body.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === header) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break; // next section header
    out.push(lines[i]!);
  }
  return out.join("\n").trim();
}

export class ImageSerializer implements CardSerializer<"image"> {
  readonly kind = "image" as const;

  deserialize(fileBytes: string, _opts?: { filePath?: string }): Card[] {
    const split = splitFencedYaml(fileBytes);
    if (!split) return [];
    const { data, body } = split;
    if (!isValidZettel(data) || !isImageCard(data)) return [];

    const title = extractTitle(body);
    const content = extractSection(body, CORE_IDEA_HEADER) ?? body.trim();

    // The decoded envelope (incl. image fields + provenance) becomes
    // `frontmatter`; `title` rides as the round-trip carrier, stripped on
    // serialize (same convention as KnowledgeSerializer).
    const envelope: Record<string, unknown> = { ...data };
    if (title) envelope.title = title;

    const card: Card = {
      id: String(data.id),
      kind: "image",
      content,
      frontmatter: envelope,
    };
    return [card];
  }

  serialize(card: Card): string {
    const fm = card.frontmatter;
    // Strip the round-trip `title` carrier from the YAML block — the title is
    // re-emitted as the `# ` heading, not a frontmatter key.
    const fmForYaml: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (k === "title") continue;
      fmForYaml[k] = v;
    }
    const yaml = stringifyYaml(fmForYaml, { lineWidth: 0 }).trimEnd();
    const title = typeof fm.title === "string" ? fm.title : card.id;
    return ["---", yaml, "---", "", `# ${title}`, "", CORE_IDEA_HEADER, card.content, ""].join("\n");
  }
}
```

- [ ] **Step 5: Add the dispatch guard** in `src/store/knowledge-serializer.ts` `deserialize`, immediately after `if (!isValidZettel(data)) return [];` (line 126):
```ts
    // ticket 07 — image cards carry record_type "image" and are owned by
    // ImageSerializer; never also deserialize them as knowledge.
    if (String(data.record_type ?? "") === "image") return [];
```

- [ ] **Step 6: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/image-serializer.test.ts )` — Expected: PASS (4 tests).

- [ ] **Step 7: Register the kind.** In `src/store/card-store.ts`: add `import { ImageSerializer } from "./image-serializer.js";` next to the KnowledgeSerializer import (line 27), then
  - in the `serializers` map (lines 155-163) add: `["image", new ImageSerializer()],`
  - in the `dedupStrategies` map (lines 164-171) add: `["image", new KnowledgeDedupStrategy()],` (idempotent upsert by `Card.id` — image ids are content-addressed `img-<sha8>`, so re-ingest is a no-op)
  - in `persistableKinds` (line 201) add `"image"` to the set literal.

- [ ] **Step 8: Widen the SQLite CHECK.** In `src/store/sqlite/schema.ts:75` change the CHECK to `CHECK (target IN ('memory', 'user', 'failure', 'knowledge', 'planning-effort', 'planning-ticket', 'image'))`. The CHECK lives in a `CREATE TABLE` — apply it with the IDENTICAL migration mechanism the `planning-effort`/`planning-ticket` widening used (locate it with `grep -rn "planning-effort" bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/` and mirror that pattern verbatim; do not invent a new migration style).

- [ ] **Step 9: Full package gates.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )` — Expected: PASS (whole suite green — no memory/knowledge/planning regression; `bun run check` for this package is `tsc`).

- [ ] **Step 10: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts bun-apps/pi-agent-ext-hermes-memory/src/store/image-serializer.ts bun-apps/pi-agent-ext-hermes-memory/src/store/image-serializer.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/knowledge-serializer.ts bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts && git -C <WT> commit -m "feat(hermes): kind=image card — CardKind, ImageSerializer, registry+schema widening (ticket 07 T1)"`

**DoD:** `CardKind` includes `"image"`; `ImageSerializer` round-trips the image zettel; `KnowledgeSerializer` returns `[]` for `record_type: image`; store registries + `persistableKinds` + `memories.target` CHECK include the new kind; full hermes suite + tsc green.

---

### Task 2: `swift/vision-ocr-cli` — one-shot Vision OCR CLI + Bun bridge

**Files:**
- Create: `swift/vision-ocr-cli/Package.swift`
- Create: `swift/vision-ocr-cli/Sources/VisionOCRCli/main.swift`
- Create: `swift/vision-ocr-cli/fixtures/make-fixture.swift` (one-shot generator, run once, committed for provenance)
- Create: `swift/vision-ocr-cli/fixtures/hello-123.png` (generated, committed)
- Create: `bun-apps/pi-agent-ext-file2md/src/image/ocr.ts`
- Test: `bun-apps/pi-agent-ext-file2md/src/image/ocr-cli.test.ts`

**Interfaces:**
- Consumes: nothing (self-contained SPM executable; system frameworks Vision/CoreGraphics/ImageIO only — build-convention reference `swift/embed-mlx-server/Package.swift:1-30`, NOT modified).
- Produces (Swift CLI contract): `vision-ocr-cli <image-path>` (path via argv[1] or stdin) → exit 0 with JSON `{"text":"…","width":800,"height":200,"format":"png"}` on stdout; exit 1 + message on stderr on any failure.
- Produces (TS): `export interface OcrResult { text: string; width: number; height: number; format: string }`; `export interface OcrOpts { cliPath?: string }`; `export async function runVisionOcr(imagePath: string, opts?: OcrOpts): Promise<OcrResult | undefined>` (never throws — undefined = CLI missing/failed, callers degrade gracefully); `export const DEFAULT_OCR_CLI: string`.

- [ ] **Step 1: Write** `swift/vision-ocr-cli/Package.swift`:
```swift
// swift-tools-version: 6.0
//
// vision-ocr-cli — one-shot macOS Vision OCR bridge (ticket 07 #4/#5).
// Usage: vision-ocr-cli <image-path>   (path may also arrive on stdin)
// stdout (exit 0): {"text":"…","width":1024,"height":768,"format":"png"}
// Errors: exit 1 + message on stderr. Zero external dependencies — Vision,
// CoreGraphics and ImageIO are macOS system frameworks. Deliberately a
// standalone CLI: embed-mlx-server stays single-purpose (NOT touched).
import PackageDescription

let package = Package(
    name: "vision-ocr-cli",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "vision-ocr-cli", targets: ["VisionOCRCli"])
    ],
    targets: [
        .executableTarget(
            name: "VisionOCRCli",
            path: "Sources/VisionOCRCli",
            linkerSettings: [
                .linkedFramework("Vision"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
            ]
        )
    ]
)
```

- [ ] **Step 2: Write** `swift/vision-ocr-cli/Sources/VisionOCRCli/main.swift`:
```swift
// vision-ocr-cli — one-shot macOS Vision OCR bridge (ticket 07 #4/#5).
import Foundation
import Vision
import CoreGraphics
import ImageIO

struct OcrOutput: Codable {
    let text: String
    let width: Int
    let height: Int
    let format: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

// Image path: argv[1], else one trimmed line from stdin.
var imagePath: String? = nil
if CommandLine.arguments.count > 1 {
    imagePath = CommandLine.arguments[1]
} else {
    let stdinData = FileHandle.standardInput.readDataToEndOfFile()
    if let s = String(data: stdinData, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
        imagePath = s
    }
}
guard let path = imagePath else {
    fail("usage: vision-ocr-cli <image-path>")
}

guard let fileData = FileManager.default.contents(atPath: path) else {
    fail("cannot read image: \(path)")
}
let cfData = fileData as CFData
guard let src = CGImageSourceCreateWithData(cfData, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fail("cannot decode image: \(path)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("vision request failed: \(error)")
}
let text = (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string }
    .joined(separator: "\n")

// UTI ("public.png") → bare format tag ("png").
let rawFormat = (CGImageSourceGetType(src) as String?) ?? "unknown"
let format = rawFormat.hasPrefix("public.") ? String(rawFormat.dropFirst("public.".count)) : rawFormat

let output = OcrOutput(text: text, width: cgImage.width, height: cgImage.height, format: format)
let encoded: Data
do {
    encoded = try JSONEncoder().encode(output)
} catch {
    fail("json encode failed: \(error)")
}
FileHandle.standardOutput.write(encoded)
```

- [ ] **Step 3: Build.** `( cd swift/vision-ocr-cli && swift build -c release )` — Expected: `Build complete!` (zero network deps; if the linker needs no explicit frameworks, keep the linkerSettings anyway — harmless).

- [ ] **Step 4: Generate the committed fixture.** Write `swift/vision-ocr-cli/fixtures/make-fixture.swift`:
```swift
// One-shot fixture generator — run from swift/vision-ocr-cli/:
//   swift fixtures/make-fixture.swift
// Writes fixtures/hello-123.png (800x200, black "HELLO 123" on white).
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let w = 800, h = 200
let cs = CGColorSpaceCreateDeviceRGB()
let ctx = CGContext(
    data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
    space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h)))
ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 96, nil)
let attrs: [CFString: Any] = [kCTFontAttributeName: font]
let line = CTLineCreateWithAttributedString(
    NSAttributedString(string: "HELLO 123", attributes: attrs))
let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
ctx.textPosition = CGPoint(
    x: (CGFloat(w) - bounds.width) / 2, y: (CGFloat(h) - bounds.height) / 2)
CTLineDraw(line, ctx)
let image = ctx.makeImage()!
let url = URL(fileURLWithPath: "fixtures/hello-123.png")
let dest = CGImageDestinationCreateWithURL(
    url as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("wrote fixtures/hello-123.png")
```
Run: `( cd swift/vision-ocr-cli && swift fixtures/make-fixture.swift )` — Expected: `wrote fixtures/hello-123.png`.

- [ ] **Step 5: Smoke the CLI.** `( cd swift/vision-ocr-cli && ./.build/release/vision-ocr-cli fixtures/hello-123.png )` — Expected: stdout JSON like `{"text":"HELLO 123","width":800,"height":200,"format":"png"}` (Vision accurate mode reads clean 96pt text reliably; text must contain `HELLO`).

- [ ] **Step 6: Write the failing integration test** `bun-apps/pi-agent-ext-file2md/src/image/ocr-cli.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { runVisionOcr } from "./ocr.js";

// src/image → pkg → bun-apps → repo root.
const CLI = new URL("../../../../swift/vision-ocr-cli/.build/release/vision-ocr-cli", import.meta.url)
  .pathname;
const FIXTURE = new URL("../../../../swift/vision-ocr-cli/fixtures/hello-123.png", import.meta.url)
  .pathname;

describe("vision-ocr-cli integration (ticket 07 T2)", () => {
  it("OCRs the committed fixture → JSON {text,width,height,format}", { skip: !existsSync(CLI) }, async () => {
    const r = await runVisionOcr(FIXTURE, { cliPath: CLI });
    assert.ok(r, "runVisionOcr returned a result");
    assert.match(r.text.toUpperCase(), /HELLO/);
    assert.equal(r.width, 800);
    assert.equal(r.height, 200);
    assert.equal(r.format, "png");
  });
  it("returns undefined (never throws) when the binary is absent", async () => {
    const r = await runVisionOcr(FIXTURE, { cliPath: "/nonexistent/vision-ocr-cli" });
    assert.equal(r, undefined);
  });
});
```

- [ ] **Step 7: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-file2md && bun test src/image/ocr-cli.test.ts )` — Expected: FAIL (cannot resolve `./ocr.js`).

- [ ] **Step 8: Write** `bun-apps/pi-agent-ext-file2md/src/image/ocr.ts`:
```ts
// src/image/ocr.ts — one-shot macOS Vision OCR bridge (ticket 07 #4/#5).
// Spawns swift/vision-ocr-cli (built via `swift build -c release`) via
// Bun.spawn and parses its JSON stdout. NEVER touches swift/embed-mlx-server.
import { existsSync } from "node:fs";

export interface OcrResult {
  text: string;
  width: number;
  height: number;
  format: string;
}

/** Repo-root-relative default binary path (src/image → pkg → bun-apps → root). */
export const DEFAULT_OCR_CLI = new URL(
  "../../../../swift/vision-ocr-cli/.build/release/vision-ocr-cli",
  import.meta.url,
).pathname;

export interface OcrOpts {
  /** Path to the vision-ocr-cli binary. Default: $VISION_OCR_CLI, then DEFAULT_OCR_CLI. */
  cliPath?: string;
}

/** Run OCR on one image. Returns undefined (never throws) when the CLI is
 *  missing or fails — callers degrade gracefully. */
export async function runVisionOcr(imagePath: string, opts: OcrOpts = {}): Promise<OcrResult | undefined> {
  const cli = opts.cliPath ?? process.env.VISION_OCR_CLI ?? DEFAULT_OCR_CLI;
  if (!existsSync(cli)) {
    process.stderr.write(
      `[file2md] vision-ocr-cli not found at ${cli} — build it with ( cd swift/vision-ocr-cli && swift build -c release )\n`,
    );
    return undefined;
  }
  const proc = Bun.spawn([cli, imagePath], { stdout: "pipe", stderr: "pipe" });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    process.stderr.write(`[file2md] vision-ocr-cli exited ${exitCode} for ${imagePath}\n`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as OcrResult;
    if (
      typeof parsed.text !== "string" ||
      typeof parsed.width !== "number" ||
      typeof parsed.height !== "number"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 9: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-file2md && bun test src/image/ocr-cli.test.ts )` — Expected: PASS (2 tests; the integration test runs because Step 3 built the binary).

- [ ] **Step 10: Type-check.** `( cd bun-apps/pi-agent-ext-file2md && bunx tsc --noEmit )` — Expected: no errors.

- [ ] **Step 11: Commit.** `git -C <WT> add swift/vision-ocr-cli/Package.swift swift/vision-ocr-cli/Sources/VisionOCRCli/main.swift swift/vision-ocr-cli/fixtures/make-fixture.swift swift/vision-ocr-cli/fixtures/hello-123.png bun-apps/pi-agent-ext-file2md/src/image/ocr.ts bun-apps/pi-agent-ext-file2md/src/image/ocr-cli.test.ts && git -C <WT> commit -m "feat(file2md): one-shot Vision OCR CLI (swift/vision-ocr-cli) + Bun.spawn bridge (ticket 07 T2)"` (never `git add swift/vision-ocr-cli/.build` — confirm `.build/` is ignored; if not, add a local `.gitignore` with `.build/` to that dir and stage it too).

**DoD:** CLI builds dependency-free, OCRs the committed fixture to exact-dimension JSON; `runVisionOcr` degrades to `undefined` on missing binary; `swift/embed-mlx-server/` untouched.

---

### Task 3: file2md image branch — extract one merged kind=image card

**Files:**
- Create: `bun-apps/pi-agent-ext-file2md/src/image/image-card.ts`
- Create: `bun-apps/pi-agent-ext-file2md/src/image/extract-image.ts`
- Modify: `bun-apps/pi-agent-ext-file2md/src/index.ts:1-11` (export barrel — append three lines)
- Test: `bun-apps/pi-agent-ext-file2md/src/image/extract-image.test.ts`

**Interfaces:**
- Consumes: `runVisionOcr`/`OcrResult` from `./ocr.js` (Task 2); `askImage(imagePath: string, question: string, opts?) => Promise<AskImageResult>` where `AskImageResult = { reply: string; ok: boolean; error?: string }` from `../vlm/ask.js` (its default target IS lm-studio `google/gemma-4-12b-qat` — decision #5's model, no new HTTP client needed).
- Produces:
  - `isImageFile(path: string): boolean`
  - `sha256Hex(input: string | Uint8Array): string`
  - `imageCardId(sourceHash: string): string` (→ `img-<first 8 hex>`)
  - `mergeImageContent(ocrText: string | undefined, visionDescription: string | undefined): string`
  - `buildImageCardMarkdown(input: ImageCardInput): string`
  - `askImageDescribe(imagePath: string): Promise<DescribeResult>` (`DescribeResult = { ok: boolean; description?: string; error?: string }`)
  - `extractImageCard(imagePath: string, opts?: ExtractImageOpts): Promise<ExtractImageResult>` with `ExtractImageOpts = { ocr?: (p: string) => Promise<OcrResult | undefined>; describe?: (p: string) => Promise<DescribeResult>; now?: () => string }` and `ExtractImageResult = { markdown: string; degraded: boolean; warnings: string[] }`.

- [ ] **Step 0: lm-studio availability check (impl-time fact item).** `curl -s http://localhost:1234/v1/models | grep -c gemma-4-12b-qat` — Expected: `1` (model present). If `0`/connection refused: continue (all tests below use injected fakes; the live path degrades per the warning design) and record the miss in the PR description.

- [ ] **Step 1: Write the failing test** `src/image/extract-image.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImageCard, isImageFile } from "./extract-image.js";
import { sha256Hex, imageCardId, mergeImageContent } from "./image-card.js";
import type { OcrResult } from "./ocr.js";

const OCR_OK: OcrResult = { text: "HELLO 123", width: 800, height: 200, format: "png" };

function tmpImage(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "f2md-img-"));
  const path = join(dir, "shot.png");
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  return { dir, path };
}

describe("isImageFile", () => {
  it("matches image extensions case-insensitively", () => {
    assert.equal(isImageFile("/a/b/shot.png"), true);
    assert.equal(isImageFile("/a/b/shot.PNG"), true);
    assert.equal(isImageFile("/a/b/doc.pdf"), false);
  });
});

describe("mergeImageContent / hashes", () => {
  it("merges OCR + Vision into ONE content field", () => {
    assert.equal(mergeImageContent("HELLO 123", "white image"), "OCR:\nHELLO 123\n\nVision:\nwhite image");
    assert.equal(mergeImageContent("HELLO 123", undefined), "OCR:\nHELLO 123");
    assert.equal(mergeImageContent(undefined, undefined), "");
  });
  it("sha256Hex + imageCardId are stable", () => {
    const h = sha256Hex("x");
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(imageCardId(h), `img-${h.slice(0, 8)}`);
  });
});

describe("extractImageCard", () => {
  it("full path: OCR + vision → merged card with image+provenance front-matter", async (t) => {
    const { dir, path } = tmpImage();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = await extractImageCard(path, {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: true, description: "A white image with the text HELLO 123." }),
      now: () => "2026-08-14",
    });
    assert.equal(r.degraded, false);
    assert.deepEqual(r.warnings, []);
    assert.match(r.markdown, /^---\n/);
    assert.match(r.markdown, /record_type: image/);
    assert.match(r.markdown, /tags: \[zettel, image\]/);
    assert.match(r.markdown, /dimensions: \{width: 800, height: 200\}/);
    assert.match(r.markdown, /locator: shot\.png/);
    assert.match(r.markdown, /format: png/);
    assert.match(r.markdown, /extractor: vision-ocr\+google\/gemma-4-12b-qat/);
    assert.match(r.markdown, /source_hash: [0-9a-f]{64}/);
    assert.match(r.markdown, /content_hash: [0-9a-f]{64}/);
    assert.match(r.markdown, /## 核心想法[\s\S]*OCR:\nHELLO 123[\s\S]*Vision:\nA white image/);
  });

  it("graceful degradation: describe fails → OCR-only card + warning (decision #5)", async (t) => {
    const { dir, path } = tmpImage();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = await extractImageCard(path, {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: false, error: "lm-studio unavailable" }),
      now: () => "2026-08-14",
    });
    assert.equal(r.degraded, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /vision-LLM unavailable/);
    assert.match(r.markdown, /extractor: vision-ocr$/m);
    assert.ok(!r.markdown.includes("Vision:"), "no Vision block when degraded");
    assert.match(r.markdown, /OCR:\nHELLO 123/);
  });

  it("OCR unavailable but vision ok → description-only card + warning", async (t) => {
    const { dir, path } = tmpImage();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = await extractImageCard(path, {
      ocr: async () => undefined,
      describe: async () => ({ ok: true, description: "A diagram of the pipeline." }),
      now: () => "2026-08-14",
    });
    assert.equal(r.degraded, true);
    assert.match(r.markdown, /extractor: google\/gemma-4-12b-qat$/m);
    assert.match(r.markdown, /dimensions: \{width: 0, height: 0\}/); // dims unknown without OCR
    assert.match(r.markdown, /Vision:\nA diagram of the pipeline\./);
  });

  it("both stages fail → throws (never emit an empty card)", async (t) => {
    const { dir, path } = tmpImage();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    await assert.rejects(
      () =>
        extractImageCard(path, {
          ocr: async () => undefined,
          describe: async () => ({ ok: false, error: "down" }),
        }),
      /no OCR text and no vision description/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-file2md && bun test src/image/extract-image.test.ts )` — Expected: FAIL (cannot resolve `./extract-image.js`).

- [ ] **Step 3: Write** `src/image/image-card.ts`:
```ts
// src/image/image-card.ts — pure builders for the kind=image vault-md card
// (ticket 07 #1: knowledge front-matter EXTENDED with format/dimensions/
// locator; content = single merged OCR+vision field; atomic one-image-one-card;
// #6: provenance hashes computed exactly like existing cards — sha256 hex).
import { createHash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable content-addressed card id: first 8 hex of the source (image-bytes) hash. */
export function imageCardId(sourceHash: string): string {
  return `img-${sourceHash.slice(0, 8)}`;
}

/** Merge OCR text + vision description into the single content field. */
export function mergeImageContent(ocrText: string | undefined, visionDescription: string | undefined): string {
  const parts: string[] = [];
  if (ocrText !== undefined && ocrText.trim() !== "") parts.push(`OCR:\n${ocrText.trim()}`);
  if (visionDescription !== undefined && visionDescription.trim() !== "") {
    parts.push(`Vision:\n${visionDescription.trim()}`);
  }
  return parts.join("\n\n");
}

export interface ImageCardInput {
  id: string;
  /** ISO date (YYYY-MM-DD). */
  created: string;
  /** Absolute path of the source image. */
  sourceFile: string;
  /** sha256 hex of the image bytes. */
  sourceHash: string;
  /** sha256 hex of the merged content string. */
  contentHash: string;
  format: string;
  width: number;
  height: number;
  /** Vault-facing location tag (image basename). */
  locator: string;
  /** Which stages produced this card, e.g. "vision-ocr+google/gemma-4-12b-qat". */
  extractor: string;
  ocrText: string | undefined;
  visionDescription: string | undefined;
}

/** Emit the vault-md image card (zettel envelope + record_type: image).
 *  YAML is hand-emitted — every value below is a plain scalar/flow literal,
 *  so no yaml dependency is needed in this package. */
export function buildImageCardMarkdown(input: ImageCardInput): string {
  const fm: string[] = [
    "---",
    `id: ${input.id}`,
    `created: ${input.created}`,
    "tags: [zettel, image]",
    "record_type: image",
    `source_file: ${input.sourceFile}`,
    `source_hash: ${input.sourceHash}`,
    `content_hash: ${input.contentHash}`,
    `extractor: ${input.extractor}`,
    `format: ${input.format}`,
    `dimensions: {width: ${input.width}, height: ${input.height}}`,
    `locator: ${input.locator}`,
    "---",
  ];
  const body: string[] = [
    "",
    `# ${input.id}`,
    "",
    "## 核心想法",
    mergeImageContent(input.ocrText, input.visionDescription),
  ];
  return fm.concat(body).join("\n") + "\n";
}
```

- [ ] **Step 4: Write** `src/image/extract-image.ts`:
```ts
// src/image/extract-image.ts — image input branch (ticket 07 #3): OCR via the
// one-shot Swift Vision CLI, optional describe via the shared VLM seam
// (askImage → lm-studio google/gemma-4-12b-qat), merged into ONE atomic
// kind=image vault-md card. Graceful degradation (decision #5): VLM failure
// → OCR-only card + stderr warning; both stages failing → throw.
import { basename, isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { askImage } from "../vlm/ask.js";
import { runVisionOcr, type OcrResult } from "./ocr.js";
import { buildImageCardMarkdown, imageCardId, mergeImageContent, sha256Hex } from "./image-card.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export function isImageFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXT.has(path.slice(dot).toLowerCase());
}

export interface DescribeResult {
  ok: boolean;
  description?: string;
  error?: string;
}

const DESCRIBE_PROMPT =
  "Describe this image factually for a knowledge base: the subject(s), the scene, any legible text, and notable details. 3-6 sentences, plain prose.";

/** Default describe stage: file2md's shared VLM seam. askImage already
 *  defaults to lm-studio google/gemma-4-12b-qat (see ../vlm/ask.ts header). */
export async function askImageDescribe(imagePath: string): Promise<DescribeResult> {
  try {
    const r = await askImage(imagePath, DESCRIBE_PROMPT);
    if (r.ok && r.reply.trim() !== "") return { ok: true, description: r.reply.trim() };
    return { ok: false, error: r.error ?? "vlm-unavailable" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ExtractImageOpts {
  /** OCR stage — default runVisionOcr (Swift Vision CLI via Bun.spawn). */
  ocr?: (imagePath: string) => Promise<OcrResult | undefined>;
  /** Describe stage — default askImageDescribe (askImage → lm-studio gemma). */
  describe?: (imagePath: string) => Promise<DescribeResult>;
  /** Clock for `created` — default today's ISO date. */
  now?: () => string;
}

export interface ExtractImageResult {
  /** The full vault-md image card (one image = one card, atomic — decision #4). */
  markdown: string;
  /** True when a stage was skipped (degraded card) — always paired with warnings. */
  degraded: boolean;
  warnings: string[];
}

export async function extractImageCard(imagePath: string, opts: ExtractImageOpts = {}): Promise<ExtractImageResult> {
  const abs = isAbsolute(imagePath) ? imagePath : resolve(imagePath);
  const ocr = opts.ocr ?? runVisionOcr;
  const describe = opts.describe ?? askImageDescribe;
  const created = (opts.now ?? (() => new Date().toISOString().slice(0, 10)))();
  const warnings: string[] = [];

  // Provenance (decision #6): source_hash over the image bytes.
  const sourceHash = sha256Hex(readFileSync(abs));

  const ocrRes = await ocr(abs);
  if (ocrRes === undefined) {
    warnings.push(`[file2md] OCR unavailable for ${abs} (vision-ocr-cli missing or failed)`);
  }

  const descRes = await describe(abs);
  const visionDescription = descRes.ok && desc.description ? desc.description : undefined;
  if (visionDescription === undefined) {
    warnings.push(
      `[file2md] vision-LLM unavailable for ${abs} (${descRes.error ?? "unknown"}) — emitting OCR-only card`,
    );
  }

  const content = mergeImageContent(ocrRes?.text, visionDescription);
  if (content === "") {
    throw new Error(`image card extraction failed for ${abs}: no OCR text and no vision description`);
  }

  const extractor = [
    ocrRes !== undefined ? "vision-ocr" : undefined,
    visionDescription !== undefined ? "google/gemma-4-12b-qat" : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join("+");

  const markdown = buildImageCardMarkdown({
    id: imageCardId(sourceHash),
    created,
    sourceFile: abs,
    sourceHash,
    contentHash: sha256Hex(content),
    format: ocrRes?.format ?? abs.slice(abs.lastIndexOf(".") + 1).toLowerCase(),
    width: ocrRes?.width ?? 0,
    height: ocrRes?.height ?? 0,
    locator: basename(abs),
    extractor,
    ocrText: ocrRes?.text,
    visionDescription,
  });

  for (const w of warnings) process.stderr.write(`${w}\n`);
  return { markdown, degraded: warnings.length > 0, warnings };
}
```

- [ ] **Step 5: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-file2md && bun test src/image/ )` — Expected: PASS (Task 2 + Task 3 tests, zero network / zero Swift dependency — everything injected).

- [ ] **Step 6: Export from the barrel.** Append to `src/index.ts`:
```ts
export * from "./image/ocr.js";
export * from "./image/image-card.js";
export * from "./image/extract-image.js";
```
Run `( cd bun-apps/pi-agent-ext-file2md && bun test && bunx tsc --noEmit )` — Expected: PASS, no errors.

- [ ] **Step 7: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-file2md/src/image/image-card.ts bun-apps/pi-agent-ext-file2md/src/image/extract-image.ts bun-apps/pi-agent-ext-file2md/src/image/extract-image.test.ts bun-apps/pi-agent-ext-file2md/src/index.ts && git -C <WT> commit -m "feat(file2md): image input branch — extractImageCard merges Vision OCR + gemma describe into one kind=image card (ticket 07 T3)"`

**DoD:** `extractImageCard` emits the exact vault-md card (image fields + 02-style provenance + merged content) for PNG/JPG/JPEG/WEBP/GIF/BMP; VLM absence degrades to OCR-only with a warning; both-stages-failed throws; all unit tests use injected fakes.

---

### Task 4: End-to-end — emitted card ingests through the existing embed path

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts:285` (default embed kinds) and the `VectorBackfillDeps.kinds` doc comment at `:30-37`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/package.json` (devDependencies += `@repo/pi-agent-ext-file2md`)
- Test: `bun-apps/pi-agent-ext-hermes-memory/src/image-card-ingest.test.ts`

**Interfaces:**
- Consumes: `extractImageCard` + `OcrResult` from `@repo/pi-agent-ext-file2md` (Task 3 barrel); `ImageSerializer` from `./store/image-serializer.js` (Task 1); `createCardStore` from `./store/card-store.js`; `walkAndIngest` from `./walk-and-ingest.js` whose `VectorBackfillDeps` (lines 30-37) takes `{ vectorStore, embedder, modelVersion, embedModel, kinds? }` and whose default at line 285 is `const kinds = deps.kinds ?? (["knowledge"] as CardKind[]);`.
- Produces: default embed kinds `["knowledge", "image"]` at `walk-and-ingest.ts:285` (decision #2: image cards text-embed their merged content through the UNCHANGED backfill seam — no CLIP, no new embed code).

- [ ] **Step 1: Add the cross-package dev dependency.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun add --dev @repo/pi-agent-ext-file2md )` — Expected: resolves from the workspace, updates `package.json` + `bun-apps/bun.lock`.

- [ ] **Step 2: Write the failing test** `src/image-card-ingest.test.ts`:
```ts
// src/image-card-ingest.test.ts — ticket 07 T4: the file2md-emitted image card
// flows through the EXISTING hermes ingest/embed path unchanged (decision #2:
// text-embed of the merged content only), and a degraded (OCR-only) card
// ingests too (decision #5).
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImageCard, type OcrResult } from "@repo/pi-agent-ext-file2md";
import { ImageSerializer } from "./store/image-serializer.js";
import { createCardStore } from "./store/card-store.js";
import { walkAndIngest } from "./walk-and-ingest.js";

const OCR_OK: OcrResult = { text: "HELLO 123", width: 800, height: 200, format: "png" };

function tmpVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "hermes-img-"));
  mkdirSync(join(dir, "vault"), { recursive: true });
  return dir;
}

function tmpImage(vault: string): string {
  const p = join(vault, "shot.png");
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  return p;
}

/** Proxy fake absorbing ANY embedder/vector-store call shape; records every
 *  string argument it is handed (batch or single-text signatures both work). */
function recordingEmbedder(log: string[]): unknown {
  return new Proxy(
    {},
    {
      get: () =>
        async (...args: unknown[]) => {
          const head = args[0];
          const texts = (Array.isArray(head) ? head : [head]).filter((x): x is string => typeof x === "string");
          log.push(...texts);
          return texts.map(() => new Array(8).fill(0.1));
        },
    },
  );
}

describe("image card ingest (file2md → hermes, ticket 07 T4)", () => {
  it("extractImageCard markdown deserializes as kind=image via ImageSerializer", async (t) => {
    const vault = tmpVault();
    t.after(() => rmSync(vault, { recursive: true, force: true }));
    const { markdown } = await extractImageCard(tmpImage(vault), {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: true, description: "A white image reading HELLO 123." }),
      now: () => "2026-08-14",
    });
    const cards = new ImageSerializer().deserialize(markdown);
    assert.equal(cards.length, 1);
    const card = cards[0]!;
    assert.equal(card.kind, "image");
    assert.match(card.content, /HELLO 123/);
    assert.match(card.content, /Vision:/);
    assert.equal(card.frontmatter.format, "png");
    assert.deepEqual(card.frontmatter.dimensions, { width: 800, height: 200 });
    assert.equal(card.frontmatter.locator, "shot.png");
    assert.match(String(card.frontmatter.source_hash), /^[0-9a-f]{64}$/);
    assert.match(String(card.frontmatter.content_hash), /^[0-9a-f]{64}$/);
  });

  it("degraded (OCR-only) card still deserializes as a valid image card", async (t) => {
    const vault = tmpVault();
    t.after(() => rmSync(vault, { recursive: true, force: true }));
    const { markdown } = await extractImageCard(tmpImage(vault), {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: false, error: "lm-studio unavailable" }),
      now: () => "2026-08-14",
    });
    const [card] = new ImageSerializer().deserialize(markdown);
    assert.equal(card!.kind, "image");
    assert.match(card!.content, /HELLO 123/);
    assert.ok(!card!.content.includes("Vision:"));
  });

  it("the image card persists through the SQLite store", async (t) => {
    const vault = tmpVault();
    t.after(() => rmSync(vault, { recursive: true, force: true }));
    const { markdown } = await extractImageCard(tmpImage(vault), {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: true, description: "A white image reading HELLO 123." }),
      now: () => "2026-08-14",
    });
    const [card] = new ImageSerializer().deserialize(markdown);
    // Mirror the exact upsert/get call shape used by the existing knowledge
    // round-trip test (grep -n "upsertCard" src/store/card-store.test.ts);
    // drop/keep `await` to match whether the store API is async.
    const store = await createCardStore({ memoryDir: join(vault, "store") });
    await store.upsertCard(card!);
    const got = await store.getCard(card!.id);
    assert.equal(got?.kind, "image");
    assert.deepEqual(got?.frontmatter.dimensions, { width: 800, height: 200 });
    await store.close();
  });

  it("walkAndIngest embeds an image card through the existing backfill path (text-embed of merged content)", async (t) => {
    const vault = tmpVault();
    t.after(() => rmSync(vault, { recursive: true, force: true }));
    const { markdown } = await extractImageCard(tmpImage(vault), {
      ocr: async () => OCR_OK,
      describe: async () => ({ ok: true, description: "A white image reading HELLO 123." }),
      now: () => "2026-08-14",
    });
    const id = new ImageSerializer().deserialize(markdown)[0]!.id;
    writeFileSync(join(vault, "vault", `${id}.md`), markdown);

    const embedded: string[] = [];
    const embedder = recordingEmbedder(embedded);
    const vectorStore = new Proxy({}, { get: () => async () => undefined });
    // If walkAndIngest needs more opts for a bare temp dir, mirror the minimal
    // shape used by the existing walk-and-ingest tests (grep -n "walkAndIngest(" src/*.test.ts).
    await walkAndIngest({
      memoryDir: join(vault, "vault"),
      vectorBackfill: {
        vectorStore: () => vectorStore as never,
        embedder: () => embedder as never,
        modelVersion: "test",
        embedModel: "nomic-embed-text-v1.5",
      },
    });
    await new Promise((r) => setTimeout(r, 200)); // fire-and-forget backfill window
    assert.ok(
      embedded.some((s) => s.includes("HELLO 123")),
      "merged image content reached the text embedder through the unchanged path",
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/image-card-ingest.test.ts )` — Expected: FAIL (the 4th test: the default embed kinds at `walk-and-ingest.ts:285` are `["knowledge"]`, so the kind=image card never reaches the embedder — `embedded` stays empty; tests 1-3 may already pass thanks to Tasks 1+3, which is fine).

- [ ] **Step 4: Widen the default embed kinds.** In `src/walk-and-ingest.ts:285` change:
```ts
  const kinds = deps.kinds ?? (["knowledge", "image"] as CardKind[]);
```
and update the `VectorBackfillDeps.kinds` doc comment (line ~37) from `(default: ["knowledge"])` to `(default: ["knowledge", "image"])`.

- [ ] **Step 5: Run test to verify it passes.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/image-card-ingest.test.ts )` — Expected: PASS (4 tests).

- [ ] **Step 6: Full gates.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )` and `( cd bun-apps/pi-agent-ext-file2md && bun test && bunx tsc --noEmit )` — Expected: PASS on both packages (no regression in the knowledge embed default behavior — existing backfill tests must stay green).

- [ ] **Step 7: Commit.** `git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/src/image-card-ingest.test.ts bun-apps/pi-agent-ext-hermes-memory/package.json bun-apps/bun.lock && git -C <WT> commit -m "feat(hermes): image cards embed through the existing text-embed path — default kinds += image (ticket 07 T4)"`

**DoD:** A file2md-emitted image card (full and OCR-only-degraded) deserializes as `kind=image`, persists through SQLite, and its merged content text-embeds via the unchanged walk-and-ingest backfill seam; both package suites + tsc green.

---

## Decision coverage map (self-review)

| Ticket 07 Resolution | Where |
|---|---|
| #1 zettel front-matter + `format`/`dimensions`/`locator`, merged single content | T1 `ImageSerializer`, T3 `buildImageCardMarkdown`/`mergeImageContent` |
| #2 text-embed ONLY, no CLIP | T4 default kinds += `"image"` on the unchanged backfill seam; Global Constraints forbid CLIP |
| #3 extend file2md, Vision framework, zero new deps | T2/T3 `src/image/` branch; SPM package has no external dependencies |
| #4 atomic one-image-one-card | T3 `extractImageCard` emits exactly one card per image (test asserts single card) |
| #5 one-shot Swift CLI, embed-mlx-server untouched, gemma via lm-studio, degradation | T2 CLI + `runVisionOcr`; T3 `askImageDescribe`/degradation tests; Global Constraints |
| #6 provenance hashes like existing cards | T3 `sha256Hex` source/content hashes asserted in T3+T4 tests |
