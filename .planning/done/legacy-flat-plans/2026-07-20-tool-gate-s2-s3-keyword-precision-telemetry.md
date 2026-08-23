# Tool-Gate S2+S3 — Keyword Precision + Runtime Token Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dynamic tool-gate's keyword matching precise (kill false-fires on everyday dev turns while preserving recall on genuine generation intents) and replace stale hardcoded `savedTokens` with runtime-measured schema cost.

**Architecture:** Two pure additions — `matchesKeyword` (word-boundary for ASCII tokens, substring for phrases/CJK) and `gateFires` (keyword match OR an optional `requires:{nouns,verbs}` co-occurrence trigger) — consumed by both `computeActiveTools` and `matchIntent`. A third pure helper `measureToolTokens` (replicates schema-cost's `(description+parameters)/4`) feeds a session-cached `measuredTokens` map that `computeBannerSaved` reads instead of the removed static `savedTokens` field.

**Tech Stack:** TypeScript, TypeBox (`import { Type } from "typebox"`), `bun:test`, pi extension API (`ExtensionAPI`).

**Spec:** `docs/superpowers/specs/2026-07-20-tool-gate-s2-s3-keyword-precision-telemetry-design.md`

## Global Constraints

- Test runner: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )` — always subshell, never top-level `cd` (repo `no-cd-drift.sh` guard).
- TypeBox import is `import { Type } from "typebox"` (repo alias, NOT `@sinclair/typebox`).
- `execute` return shape: `{ content: [{ type: "text" as const, text: "..." }], details: undefined }`.
- Token formula (verbatim from `schema-cost.ts:20`): `Math.round((description.length + JSON.stringify(parameters).length) / 4)`, charsPerToken = 4.
- All written output (code, comments, commits) in English.
- Only TWO files change: `extensions/tool-gate.ts` + `extensions/tool-gate.test.ts`. The banner test file (`__tests__/tool-gate-banner.test.ts`) is untouched (it tests `scheduleToolGateBanner` in isolation).

---

## File Structure

- **Modify:** `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` — add `escapeRegExp`/`matchesKeyword`/`gateFires`/`CoOccurrence`/`measureToolTokens`; add `requires?` to `ToolGate`; rewrite `GATES` keywords; switch `computeActiveTools`+`matchIntent` to `gateFires`; remove `savedTokens`; build `measuredTokens` at `session_start`; change `computeBannerSaved` signature; add `turn.savedTok`.
- **Modify:** `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts` — add `matchesKeyword`/`gateFires`/`measureToolTokens` unit tests; flip the S1 `"docker image cleanup"` pin; add the S2 Effect-table + false-fire cases; update `computeBannerSaved` test for the new signature.

---

## Task 1: `matchesKeyword` + `escapeRegExp` (pure matcher)

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (add two functions before `computeActiveTools`)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `escapeRegExp(s: string): string`, `matchesKeyword(keyword: string, promptLower: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Add this block to `extensions/tool-gate.test.ts` (and add `matchesKeyword` to the existing import on line 2):

Update the import line (currently `import { computeActiveTools, CORE_TOOLS, GATES, computeBannerSaved, matchIntent } from "./tool-gate.ts";`) to also import `matchesKeyword`:

```ts
import { computeActiveTools, CORE_TOOLS, GATES, computeBannerSaved, matchIntent, matchesKeyword } from "./tool-gate.ts";
```

Append a new describe block at the end of the file:

```ts
describe("matchesKeyword (S2)", () => {
  test("word-boundary: 'flux' does NOT match inside 'conflux'", () => {
    expect(matchesKeyword("flux", "use the conflux library")).toBe(false);
  });
  test("word-boundary: 'flux' matches as a whole word", () => {
    expect(matchesKeyword("flux", "use the flux model")).toBe(true);
  });
  test("phrase substring: 'generate image' is NOT a substring of 'generate an image' (the gap co-occurrence closes)", () => {
    // This is the brittleness that motivates the requires:{nouns,verbs} design in Task 2/3.
    expect(matchesKeyword("generate image", "generate an image of a cat")).toBe(false);
  });
  test("phrase substring: 'generate image' matches 'generate image now'", () => {
    expect(matchesKeyword("generate image", "generate image now")).toBe(true);
  });
  test("CJK substring: '做動畫' matches a CJK prompt", () => {
    expect(matchesKeyword("做動畫", "幫我做動畫")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `matchesKeyword is not defined` (or "is not exported").

- [ ] **Step 3: Write the minimal implementation**

In `extensions/tool-gate.ts`, add these two functions immediately **before** the `export function computeActiveTools(` definition (i.e., after the `scheduleToolGateBanner` function and its closing brace, before the `// ── Extension entry ──` section's `computeActiveTools`):

```ts
// ── Keyword matching (S2) ────────────────────────────────────────

/** Escape a string for safe embedding in a RegExp (prevents regex-injection
 *  from keyword/noun/verb content). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `keyword` appear in the (already lowercased) prompt?
 *  - Single ASCII token (`^[a-z0-9]+$`): word-boundary match — prevents "flux"
 *    matching inside "conflux", "image" inside "images".
 *  - Multi-word phrase or CJK: substring (no word boundaries without a
 *    segmenter; phrases are specific enough once bare words are removed). */
export function matchesKeyword(keyword: string, promptLower: string): boolean {
  const kw = keyword.toLowerCase();
  if (/^[a-z0-9]+$/i.test(keyword)) {
    return new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i").test(promptLower);
  }
  return promptLower.includes(kw);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — all 5 new `matchesKeyword` tests green, and the pre-existing 33 still pass (38 total).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): matchesKeyword — word-boundary for ASCII tokens, substring for phrases/CJK (S2)"
```

---

## Task 2: `gateFires` + `CoOccurrence` + `requires?` (co-occurrence matcher)

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (add `CoOccurrence` interface, `requires?` to `ToolGate`, `gateFires` function)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Consumes: `matchesKeyword` (Task 1).
- Produces: `CoOccurrence` (interface `{ nouns: string[]; verbs: string[] }`), `gateFires(gate: ToolGate, promptLower: string): boolean`, and a new optional `requires?: CoOccurrence` field on `ToolGate`.

- [ ] **Step 1: Write the failing tests**

Add `gateFires` to the import line, and add a synthetic-gate import type. Update the import to:

```ts
import { computeActiveTools, CORE_TOOLS, GATES, computeBannerSaved, matchIntent, matchesKeyword, gateFires } from "./tool-gate.ts";
import type { ToolGate } from "./tool-gate.ts";
```

Append at the end of the file:

```ts
describe("gateFires (S2 co-occurrence)", () => {
  const coreNounGate: ToolGate = {
    names: ["fake"],
    keywords: ["outpaint"],
    description: "x",
    requires: { nouns: ["image", "picture"], verbs: ["generate", "make"] },
  };

  test("keyword match fires regardless of requires", () => {
    expect(gateFires(coreNounGate, "please outpaint this")).toBe(true);
  });
  test("noun + verb co-occurrence fires", () => {
    expect(gateFires(coreNounGate, "generate an image of a cat")).toBe(true);
  });
  test("noun without a gen-verb does NOT fire (the docker-image case)", () => {
    expect(gateFires(coreNounGate, "docker image cleanup")).toBe(false);
  });
  test("verb without a noun does NOT fire", () => {
    expect(gateFires(coreNounGate, "generate a report")).toBe(false);
  });
  test("gate without requires fires only on keywords", () => {
    const plain: ToolGate = { names: ["p"], keywords: ["montage"], description: "x" };
    expect(gateFires(plain, "orchestrate a montage")).toBe(true);
    expect(gateFires(plain, "generate an image")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `gateFires is not defined`, and `requires` is not a known property.

- [ ] **Step 3: Write the minimal implementation**

In `extensions/tool-gate.ts`:

(a) Add the `requires?` field to the `ToolGate` interface and define `CoOccurrence`. Find the existing interface:

```ts
interface ToolGate {
  names: string[];
  keywords: string[];
  /** One-line description — used for enable_tool intent matching + list output. */
  description: string;
  /** Approximate tokens saved when gated (for logging) */
  savedTokens: number;
}
```

Replace it with:

```ts
/** Co-occurrence trigger: a gate fires when the prompt has ≥1 noun AND ≥1 verb.
 *  Used only for core nouns (image/video/pdf) whose bare form false-fires
 *  (docker image, video call) but whose recall on common intents
 *  (generate an image, make a video) must survive. */
export interface CoOccurrence {
  nouns: string[];
  verbs: string[];
}

interface ToolGate {
  names: string[];
  /** Unambiguous triggers — matched via matchesKeyword. */
  keywords: string[];
  /** One-line description — used for enable_tool intent matching + list output. */
  description: string;
  /** Optional co-occurrence trigger (noun ∧ verb). See CoOccurrence. */
  requires?: CoOccurrence;
  /** Approximate tokens saved when gated (for logging) */
  savedTokens: number;
}
```

(b) Add `gateFires` immediately **after** the `matchesKeyword` function:

```ts
/** A gate fires if any keyword matches, OR its `requires` co-occurrence
 *  (≥1 noun AND ≥1 verb) is met. Pure: no pi dependency. */
export function gateFires(gate: ToolGate, promptLower: string): boolean {
  if (gate.keywords.some((kw) => matchesKeyword(kw, promptLower))) return true;
  if (gate.requires) {
    const noun = gate.requires.nouns.some((n) => matchesKeyword(n, promptLower));
    const verb = gate.requires.verbs.some((v) => matchesKeyword(v, promptLower));
    if (noun && verb) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — 5 new `gateFires` tests green; 43 total (38 + 5).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): gateFires + CoOccurrence requires — noun∧verb co-occurrence matcher (S2)"
```

---

## Task 3: keyword/co-occurrence audit — switch matchers + rewrite `GATES`

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (rewrite the `GATES` literal; switch `computeActiveTools` and `matchIntent` to `gateFires`)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Consumes: `gateFires` (Task 2), `matchesKeyword` (Task 1).
- Produces: the audited `GATES` (with `requires` on flux2/ltx/file2md); `computeActiveTools`/`matchIntent` now route through `gateFires`.

- [ ] **Step 1: Write/modify the failing tests FIRST**

(a) **Flip the S1 pin.** Find this test in the `matchIntent (S1)` describe block:

```ts
  test("S1 over-broad pin: 'docker image cleanup' → flux2 (image keyword); S2 narrows", () => {
    expect(matchIntent("docker image cleanup", GATES, sticky()).map((g) => g.names[0])).toEqual(["flux2"]);
  });
```

Replace it with:

```ts
  test("S2 flip: 'docker image cleanup' → [] (image noun, no gen-verb)", () => {
    expect(matchIntent("docker image cleanup", GATES, sticky()).map((g) => g.names[0])).toEqual([]);
  });
```

(b) **Add the S2 Effect-table + false-fire cases.** Append a new describe block at the end of the file:

```ts
describe("S2 keyword audit (computeActiveTools Effect table)", () => {
  const all = [...CORE_TOOLS, "flux2", "flux2_help", "krea2", "krea2_help", "ltx", "ltx_help",
    "file2md", "vision_ask", "inspect_extensions", "workflow", "workflow_help",
    "collect_videos", "movie", "movie_help"];
  const act = (prompt: string) => computeActiveTools(prompt, all, new Set(CORE_TOOLS));

  test("docker image cleanup → []", () => {
    expect(act("docker image cleanup")).toEqual(expect.arrayContaining([...CORE_TOOLS]));
    expect(act("docker image cleanup")).not.toContain("flux2");
  });
  test("generate an image of a cat → flux2 (generate+image)", () => {
    expect(act("generate an image of a cat")).toContain("flux2");
  });
  test("coding style → []", () => {
    expect(act("coding style")).not.toContain("flux2");
  });
  test("video call → []", () => {
    expect(act("video call")).not.toContain("ltx");
  });
  test("make a video → ltx (make+video)", () => {
    expect(act("make a video")).toContain("ltx");
  });
  test("做動畫 → ltx (做+動畫)", () => {
    expect(act("做動畫")).toContain("ltx");
  });
  test("下載影片 → [] (影片 noun, no gen-verb)", () => {
    expect(act("下載影片")).not.toContain("ltx");
  });
  test("draft an email → []", () => {
    expect(act("draft an email")).not.toContain("krea2");
  });
  test("describe the problem → []", () => {
    expect(act("describe the problem")).not.toContain("file2md");
  });
  test("read this pdf → file2md (read+pdf)", () => {
    expect(act("read this pdf")).toContain("file2md");
  });
  test("supply chain → []", () => {
    expect(act("supply chain")).not.toContain("workflow");
  });
  test("collect the data → []", () => {
    expect(act("collect the data")).not.toContain("collect_videos");
  });
  test("orchestrate a montage → movie (montage keyword)", () => {
    expect(act("orchestrate a montage")).toContain("movie");
  });
});

describe("S2 matchIntent false-fire cases", () => {
  const sticky = () => new Set(CORE_TOOLS);
  const first = (prompt: string) => matchIntent(prompt, GATES, sticky()).map((g) => g.names[0]);

  test("describe the architecture → []", () => {
    expect(first("describe the architecture")).toEqual([]);
  });
  test("make an image → [flux2] (make+image via requires)", () => {
    expect(first("make an image")).toEqual(["flux2"]);
  });
  test("conflux library → [] (flux word-boundary, not inside conflux)", () => {
    expect(first("use the conflux library")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — the flipped pin, the Effect-table cases, and the false-fire cases all fail (the matcher still uses bare `image`/`video` substrings).

- [ ] **Step 3: Rewrite the `GATES` literal**

In `extensions/tool-gate.ts`, replace the **entire** `export const GATES: ToolGate[] = [ ... ];` literal with:

```ts
/**
 * Gated tool groups. A gate fires (via gateFires) if any keyword matches, OR
 * its optional `requires` co-occurrence (≥1 noun AND ≥1 verb) is met.
 *
 * S2 audit (2026-07-20): over-broad bare words removed (image/scene/style/swap/
 * render/draft/video/電影/動畫/describe/what is in/vision/pdf/chain/collect/
 * organize/movie/compose). Core nouns (image/video/pdf) moved behind `requires`
 * so they fire only alongside a generation/action verb — killing false-fires
 * (docker image, video call) while preserving recall (generate an image, make a
 * video). Keywords are matched case-insensitively; single ASCII tokens use word
 * boundaries, phrases/CJK use substring.
 */
export const GATES: ToolGate[] = [
  {
    names: ["flux2", "flux2_help"],
    keywords: [
      "flux", "flux2", "outpaint", "upscale image", "t2i", "txt2img",
      "圖像", "圖片", "生成圖", "產圖", "繪圖", "修圖", "去背", "換臉",
      "做成圖", "轉成圖",
    ],
    requires: {
      nouns: ["image", "picture", "photo", "圖"],
      verbs: ["generate", "create", "make", "draw", "render", "produce", "生成", "做", "畫", "繪"],
    },
    description: "Flux2 image generation — text-to-image, i2i, faceswap, outpaint, upscale, restore",
    savedTokens: 1411,
  },
  {
    names: ["krea2", "krea2_help"],
    keywords: ["krea", "krea2", "草圖", "快速生成", "即時生成", "實時繪圖"],
    description: "Krea2 fast image generation — real-time draft to image",
    savedTokens: 641,
  },
  {
    names: ["ltx", "ltx_help"],
    keywords: ["ltx", "t2v", "i2v", "vbvr", "relay", "storyboard", "影片特效"],
    requires: {
      nouns: ["video", "影片", "視頻", "視訊", "動畫", "電影"],
      verbs: ["generate", "create", "make", "animate", "produce", "render", "生成", "做", "製作", "剪"],
    },
    description: "LTX video generation — text/image-to-video, upscale, storyboard, relay",
    savedTokens: 1802,
  },
  {
    names: ["file2md", "vision_ask"],
    keywords: [
      "file2md", "vlm", "ocr", "caption", "to markdown", "轉 markdown",
      "read this image", "分析圖片", "分析圖像", "識別", "讀圖", "看圖",
    ],
    requires: {
      nouns: ["pdf", "document", "文件", "scan", "image", "picture", "photo", "圖"],
      verbs: ["read", "convert", "parse", "extract", "ocr", "describe", "caption", "讀", "轉", "解析", "分析"],
    },
    description: "Document/image understanding — file→markdown, VLM describe, OCR, caption",
    savedTokens: 685,
  },
  {
    names: ["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology"],
    keywords: [
      "inspect", "schema cost", "pathology", "extension health",
      "工具開銷", "context window", "token usage",
    ],
    description: "Agent/extension introspection — context tokens, extension health, pathology",
    savedTokens: 770,
  },
  {
    names: ["workflow", "workflow_help"],
    keywords: [
      "workflow", "pipeline", "orchestrate", "fan.out", "parallel agent",
      "multi-step",
    ],
    description: "Workflow orchestrator — multi-agent fan-out/pipeline JavaScript scripts",
    savedTokens: 706,
  },
  {
    names: ["collect_videos", "organize_vault_notes", "import_memory_to_vault"],
    keywords: [
      "bilibili", "youtube", "collect videos", "video trending",
      "vault notes", "organize vault", "import memory",
      "收集影片", "整理筆記",
    ],
    description: "Research tools — collect trending videos, organize vault notes, import memory",
    savedTokens: 723,
  },
  {
    names: ["movie", "movie_help"],
    keywords: [
      "montage", "preflight", "storyboard", "分鏡", "剪輯",
      "影片製作", "導演", "make a movie", "movie director",
      "compose video", "compose scene", "電影製作",
    ],
    description: "Movie orchestrator — idea→script→scene→assets→edit→compose pipeline",
    savedTokens: 632,
  },
];
```

- [ ] **Step 4: Switch `computeActiveTools` to use `gateFires`**

In `computeActiveTools`, find this loop:

```ts
  for (const gate of GATES) {
    const matches = gate.keywords.some((kw) => promptLower.includes(kw));
    if (matches) {
      for (const name of gate.names) sticky.add(name);
    }
  }
```

Replace it with:

```ts
  for (const gate of GATES) {
    if (gateFires(gate, promptLower)) {
      for (const name of gate.names) sticky.add(name);
    }
  }
```

- [ ] **Step 5: Switch `matchIntent` to use `gateFires`**

In `matchIntent`, find:

```ts
  return gates.filter((g) => {
    if (g.names.every((n) => sticky.has(n))) return false; // skip already-active
    const fields = g.keywords.map((k) => k.toLowerCase());
    return fields.some((f) => f.length > 0 && needle.includes(f));
  });
```

Replace it with:

```ts
  return gates.filter((g) => {
    if (g.names.every((n) => sticky.has(n))) return false; // skip already-active
    return gateFires(g, needle);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — the flipped pin, all Effect-table cases, all false-fire cases, AND the pre-existing tests (computeActiveTools sticky/fail-open, the 4 matchIntent cases that still hold, GATES data, telemetry, enable_tool, computeBannerSaved) all green.

> **If any pre-existing matchIntent test fails,** re-check the audited keyword/requires lists against that test's prompt. Known-good cases (must still pass): `"make a video"→ltx`, `"generate an image of a cat"→flux2`, `"describe this picture"→file2md` (describe verb + picture noun), `"做一個 movie 分鏡"→movie` (分鏡 keyword), `"orchestrate a parallel pipeline"→workflow`.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): S2 keyword audit — co-occurrence for core nouns, bare-word removal elsewhere

Switches computeActiveTools + matchIntent to gateFires. Rewrites GATES:
- flux2/ltx/file2md gain requires:{nouns,verbs} (image/video/pdf fire only
  with a gen-verb → kills 'docker image'/'video call', keeps 'generate an
  image'/'make a video').
- Removes unambiguous bare words (scene/style/swap/render/draft/describe/
  chain/collect/organize/movie/compose/電影/動畫) with zero recall cost.
- Adds compound phrases + CJK terms.
Flips the S1 'docker image cleanup' pin to []. Adds the full Effect table."
```

---

## Task 4: `measureToolTokens` (pure, replicates schema-cost)

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (add `measureToolTokens`)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `measureToolTokens(tool: { description?: string; parameters?: unknown }): number`.

- [ ] **Step 1: Write the failing test**

Add `measureToolTokens` to the import line, then append at the end of the file:

```ts
describe("measureToolTokens (S3)", () => {
  test("replicates schema-cost.ts:20 — round((desc + params) / 4)", () => {
    const tool = { description: "abcd", parameters: { a: 1 } }; // desc=4, params=JSON.stringify({a:1})='{"a":1}'=7
    const expected = Math.round((4 + 7) / 4); // = round(2.75) = 3
    expect(measureToolTokens(tool)).toBe(expected);
  });
  test("missing description + parameters → treats as empty (0 + '{}'", () => {
    // desc="" (0), params=JSON.stringify({})='{}' (2) → round(2/4)=1
    expect(measureToolTokens({})).toBe(1);
  });
  test("long description scales linearly", () => {
    const short = measureToolTokens({ description: "x", parameters: {} });
    const long = measureToolTokens({ description: "x".repeat(400), parameters: {} });
    expect(long).toBeGreaterThan(short * 50);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `measureToolTokens is not defined`.

- [ ] **Step 3: Write the minimal implementation**

In `extensions/tool-gate.ts`, add this function in the **Telemetry** section (immediately after the `computeBannerSaved` function, before `export default function toolGateExtension`):

```ts
/**
 * Estimate a single tool's API schema-cost in tokens. Replicates the
 * schema-cost CLI heuristic verbatim (`schema-cost.ts:20`):
 *   Math.round((description.length + JSON.stringify(parameters).length) / 4)
 * charsPerToken = 4 (no real tokenizer). Pure + dependency-free — inlined here
 * (not imported from pi-agent-ext-power-tool) to keep this always-on extension
 * decoupled. Missing description/parameters are treated as empty (0). The
 * JSON.stringify is guarded so a malformed schema never crashes session_start.
 */
export function measureToolTokens(tool: { description?: string; parameters?: unknown }): number {
  const desc = (tool.description ?? "").length;
  let params = 0;
  try {
    params = JSON.stringify(tool.parameters ?? {}).length;
  } catch {
    params = 0; // non-serializable schema — fail-safe, never crash
  }
  return Math.round((desc + params) / 4);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — 3 new tests green.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): measureToolTokens — inline schema-cost heuristic (S3)"
```

---

## Task 5: wire S3 — remove `savedTokens`, build `measuredTokens`, new `computeBannerSaved` sig

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (remove `savedTokens` from `ToolGate` + every gate; build `measuredTokens` map at `session_start`; change `computeBannerSaved` signature; banner + `turn` telemetry use measured values)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Consumes: `measureToolTokens` (Task 4).
- Produces: `computeBannerSaved(active: string[], allToolNames: string[], measuredTokens: Map<string, number>): number`; `ToolGate` no longer has `savedTokens`.

- [ ] **Step 1: Update the `computeBannerSaved` test for the new signature**

Find the `describe("computeBannerSaved (S1 G fix)")` block. Replace its single test with:

```ts
describe("computeBannerSaved (S3 — runtime measured tokens)", () => {
  test("sums measured tokens of loaded+gated gates only (no phantom, no static field)", () => {
    // Mock tools with real description+parameters so measureToolTokens is deterministic.
    const mockTool = (name: string, desc: string) => ({ name, description: desc, parameters: { p: 1 } });
    const loadedNames = [...CORE_TOOLS, "ltx", "ltx_help", "flux2", "flux2_help"];
    const loadedTools = [
      ...CORE_TOOLS_ARRAY().map((n) => mockTool(n, "core")),
      mockTool("ltx", "video tool"),
      mockTool("ltx_help", "video help"),
      mockTool("flux2", "image tool"),
      mockTool("flux2_help", "image help"),
    ];
    const measured = new Map(loadedTools.map((t) => [t.name, measureToolTokens(t)]));
    // CORE-only active ⇒ ltx & flux2 are gated; movie is NOT loaded ⇒ excluded.
    const active = computeActiveTools("", loadedNames, new Set(CORE_TOOLS));
    const saved = computeBannerSaved(active, loadedNames, measured);
    const expected = measured.get("ltx")! + measured.get("ltx_help")!
      + measured.get("flux2")! + measured.get("flux2_help")!;
    expect(saved).toBe(expected);
  });

  test("a gate whose tools are absent from allToolNames contributes 0 (no phantom)", () => {
    const measured = new Map([["movie", 999], ["movie_help", 999]]);
    // movie not in allToolNames → excluded even though measured + gated
    const saved = computeBannerSaved([...CORE_TOOLS], [...CORE_TOOLS], measured);
    expect(saved).toBe(0);
  });
});
```

Add a tiny helper at the top of the file (after the imports) so the test can spread CORE_TOOLS into an array of names — `CORE_TOOLS` is a `Set`:

```ts
const CORE_TOOLS_ARRAY = (): string[] => Array.from(CORE_TOOLS);
```

> Note: `measureToolTokens` must be added to the import line in Step 3; do it now so this test type-checks.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `computeBannerSaved` still takes 2 args; `measuredTokens`/`measureToolTokens` import missing; `savedTokens` still on gates.

- [ ] **Step 3: Remove `savedTokens` from `ToolGate` + every gate**

(a) In the `ToolGate` interface, delete the `savedTokens` field line:

```ts
  /** Approximate tokens saved when gated (for logging) */
  savedTokens: number;
```

(b) Delete every `savedTokens: <n>,` line from the `GATES` literal (8 of them — one per gate).

- [ ] **Step 4: Change `computeBannerSaved` signature + implementation**

Find the current `computeBannerSaved`:

```ts
export function computeBannerSaved(active: string[], allToolNames: string[]): number {
  return GATES
    .filter((g) => g.names.some((n) => allToolNames.includes(n))) // loaded
    .filter((g) => !g.names.some((n) => active.includes(n)))      // gated
    .reduce((sum, g) => sum + g.savedTokens, 0);
}
```

Replace it with:

```ts
/**
 * Sum the measured schema-token cost of gates that are (a) actually loaded
 * this session (at least one name in `allToolNames`) and (b) currently gated
 * (no name in `active`). `measuredTokens` is built once at session_start from
 * measureToolTokens — never drifts, measures the tools actually present.
 */
export function computeBannerSaved(
  active: string[],
  allToolNames: string[],
  measuredTokens: Map<string, number>,
): number {
  return GATES
    .filter((g) => g.names.some((n) => allToolNames.includes(n))) // loaded
    .filter((g) => !g.names.some((n) => active.includes(n)))      // gated
    .reduce(
      (sum, g) => sum + g.names.reduce((s, n) => s + (measuredTokens.get(n) ?? 0), 0),
      0,
    );
}
```

- [ ] **Step 5: Build `measuredTokens` at `session_start` and pass it through**

(a) Add a closure var. Find the `toolGateExtension` function's opening:

```ts
export default function toolGateExtension(pi: ExtensionAPI) {
  let allToolNames: string[] = [];
  let sticky = new Set<string>(CORE_TOOLS);
  let lastPrompt = ""; // captured each turn; read by enable_tool (T5)
```

Add `measuredTokens`:

```ts
export default function toolGateExtension(pi: ExtensionAPI) {
  let allToolNames: string[] = [];
  let sticky = new Set<string>(CORE_TOOLS);
  let lastPrompt = ""; // captured each turn; read by enable_tool (T5)
  let measuredTokens = new Map<string, number>(); // built at session_start (S3)
```

(b) In the `session_start` handler, build the map and use it. Find:

```ts
    const active = computeActiveTools("", allToolNames, sticky);
    pi.setActiveTools(active);

    // G fix: only count loaded gates (computeBannerSaved filters by allToolNames).
    const saved = computeBannerSaved(active, allToolNames);
```

Replace with:

```ts
    // S3: measure each loaded tool's schema cost once for the session.
    measuredTokens = new Map(
      pi.getAllTools().map((t: { name: string; description?: string; parameters?: unknown }) =>
        [t.name, measureToolTokens(t)]),
    );

    const active = computeActiveTools("", allToolNames, sticky);
    pi.setActiveTools(active);

    // G fix + S3: only count loaded gates, using measured (not stale) token costs.
    const saved = computeBannerSaved(active, allToolNames, measuredTokens);
```

- [ ] **Step 6: Add `savedTok` to the per-turn telemetry entry**

In the `before_agent_start` handler, find the `emitToolGateLog({ kind: "turn", ... })` call:

```ts
    emitToolGateLog({
      kind: "turn", ts: new Date().toISOString(),
      promptLen: prompt.length, gatesFired, dormantGates,
      activeCount: active.length, totalCount: allToolNames.length,
    });
```

Replace with:

```ts
    emitToolGateLog({
      kind: "turn", ts: new Date().toISOString(),
      promptLen: prompt.length, gatesFired, dormantGates,
      activeCount: active.length, totalCount: allToolNames.length,
      savedTok: computeBannerSaved(active, allToolNames, measuredTokens),
    });
```

- [ ] **Step 7: Run the full suite to verify everything passes**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — the 2 updated `computeBannerSaved` tests green; the enable_tool tests still green (their `{name}`-only mock tools measure harmlessly); the banner test file untouched; total all-green.

> **If the enable_tool tests fail** with a `computeBannerSaved`/`measuredTokens` error: the enable_tool `setupPi` mock returns `getAllTools: () => loadedTools.map((name) => ({ name }))`. `measureToolTokens({name})` returns 1 (empty desc + `"{}"` params), so `measuredTokens` builds fine and `computeBannerSaved` works. The enable_tool tests do not assert token counts, so they pass unchanged. No test edit needed there.

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): S3 — runtime-measured token cost, drop stale savedTokens

Removes the static savedTokens field (flux2 was 1411 hardcoded vs 654 measured).
measureToolTokens (schema-cost heuristic) runs once at session_start over the
actually-loaded tools → measuredTokens map. computeBannerSaved takes the map;
banner + turn telemetry use measured values. Never drifts; no cross-package dep."
```

---

## Self-Review (run after all tasks)

**1. Spec coverage:**
- §2.2 `matchesKeyword` → Task 1 ✓
- §2.2 `gateFires`/`CoOccurrence`/`requires` → Task 2 ✓
- §2.3 keyword audit + Effect table → Task 3 ✓
- §2.4 `measureToolTokens` → Task 4 ✓
- §2.4 `computeBannerSaved` new sig + session_start wiring + `turn.savedTok` + `savedTokens` removal → Task 5 ✓
- §2.6 testing — every bullet has a test in Tasks 1-5 ✓

**2. Placeholder scan:** none — every code step shows complete code.

**3. Type consistency:**
- `gateFires(gate: ToolGate, promptLower: string)` — used identically in `computeActiveTools` (Task 3 Step 4) and `matchIntent` (Step 5) ✓
- `computeBannerSaved(active, allToolNames, measuredTokens: Map<string, number>)` — signature matches in `session_start` (Task 5 Step 5) and the `before_agent_start` telemetry (Step 6) ✓
- `measureToolTokens(tool: { description?: string; parameters?: unknown })` — matches the `pi.getAllTools()` map callback typing in Task 5 Step 5 ✓
- `ToolGate.requires?: CoOccurrence` — added in Task 2, consumed in Task 3's `GATES` ✓; `savedTokens` kept through Task 3, removed in Task 5 ✓
