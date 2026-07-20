# Tool-Gate S1 — Escape Hatch + Coverage + Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a same-turn escape hatch (`enable_tool`) for dormant gated tools, close the movie-gate coverage hole, narrow the dead-weight inspect gate, refresh the tool list per turn, and bake in minimal telemetry — all in `pi-agent-ext-tool-gate`.

**Architecture:** All changes live in one file (`extensions/tool-gate.ts`). A new always-on `enable_tool` tool (registered via `pi.registerTool`, added to `CORE_TOOLS`) captures the extension's per-session `sticky`/`allToolNames`/`lastPrompt` closure vars, so it can activate dormant gates and call `pi.setActiveTools` — effective the next agent iteration (same turn if the runtime refreshes per-iteration, else next user message; designed correct either way). New pure helpers (`matchIntent`, `emitToolGateLog`, `isMissCandidate`) are unit-tested in isolation.

**Tech Stack:** TypeScript, Bun, pi `ExtensionAPI` (`pi.registerTool`, `pi.setActiveTools`, `pi.getAllTools`, `pi.on`), TypeBox (`typebox`), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-07-20-tool-gate-s1-escape-hatch-design.md` (PR #708).

## Global Constraints

- **Language:** all written output (code, comments, commits) in English. Conversation in 繁體中文.
- **Test runner:** `( cd bun-apps/pi-agent-ext-tool-gate && bun test )` — never top-level `cd` (`no-cd-drift.sh` blocks it); always use a subshell.
- **TypeBox import:** `import { Type } from "typebox"` (repo alias — NOT `@sinclair/typebox`).
- **Tool execute return shape:** `{ content: [{ type: "text" as const, text: "..." }] }` (matches `pi-agent-ext-file2md`).
- **Token numbers:** schema-cost `charsPerToken = 4` (CLI default). Measured 2026-07-20: `movie=348`, `movie_help=284` → movie-gate `savedTokens = 632`. (`flux2` measured 654 vs hardcoded 1411 — STALE; replacing all hardcoded values is deferred to S3, NOT this plan.)
- **One registered extension entry:** `extensions/tool-gate.ts` (already in `bun-apps/pi-agent/run-dir/manifest.json`). Do not add a second entry.
- **Worktree:** before Task 1, create an isolated worktree via `superpowers:using-git-worktrees`. Branch off `main` if PR #708 (spec) has merged, else off `tool-gate-s1-escape-hatch-spec`.
- **No placeholders:** every code step below contains the actual code to write.

---

## File Structure

Only one source file changes; one test file gains new `describe` blocks.

- **Modify:** `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` — gate data (T1), `matchIntent` (T2), telemetry helpers (T3), runtime refresh + banner fix (T4), `enable_tool` registration (T5).
- **Modify:** `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts` — new tests for each task.
- **No new files.** (A throwaway probe for T6 lives in `/tmp`, never committed.)

Each task is a self-contained, independently-committable TDD cycle.

---

## Task 1: Gate data — `description` field, narrowed inspect (C), movie gate (B)

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (the `ToolGate` interface and the `GATES` const)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Produces: `ToolGate` gains `description: string`. `GATES` has 8 entries (movie added). Inspect keywords narrowed to `["inspect", "schema cost", "pathology", "extension health", "工具開銷", "context window", "token usage"]`.
- Consumed by: Task 2 (`matchIntent` reads `g.description`), Task 5 (`enable_tool` `list`/`intent`).

- [ ] **Step 1: Write the failing tests**

Append to `extensions/tool-gate.test.ts` (and add `GATES` to the existing import on line 2):

Change the import line:
```ts
import { computeActiveTools, CORE_TOOLS, GATES } from "./tool-gate.ts";
```

Append:
```ts
describe("GATES data (S1)", () => {
  test("every gate has a non-empty description", () => {
    for (const g of GATES) {
      expect(g.description.length).toBeGreaterThan(0);
    }
  });

  test("movie gate exists and fires on 'movie' and '分鏡'", () => {
    const sticky = new Set(CORE_TOOLS);
    const all = [...CORE_TOOLS, "movie", "movie_help"];
    const active = computeActiveTools("幫我用 movie 做一個分鏡", all, sticky);
    expect(active).toEqual(expect.arrayContaining(["movie", "movie_help"]));
  });

  test("inspect does NOT fire on generic 'debug the docker build' (narrowed)", () => {
    const sticky = new Set(CORE_TOOLS);
    const inspectTools = ["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology"];
    const all = [...CORE_TOOLS, ...inspectTools];
    const active = computeActiveTools("let's debug the docker build", all, sticky);
    for (const t of inspectTools) {
      expect(active).not.toContain(t);
    }
  });

  test("inspect fires on 'inspect extension health'", () => {
    const sticky = new Set(CORE_TOOLS);
    const all = [...CORE_TOOLS, "inspect_extensions"];
    expect(computeActiveTools("inspect extension health", all, sticky)).toContain("inspect_extensions");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `GATES` is not exported (import error) and/or movie gate absent and/or `description` missing.

- [ ] **Step 3: Update the `ToolGate` interface**

In `extensions/tool-gate.ts`, replace:
```ts
interface ToolGate {
  names: string[];
  keywords: string[];
  /** Approximate tokens saved when gated (for logging) */
  savedTokens: number;
}
```
with:
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

- [ ] **Step 4: Replace the entire `GATES` const**

In `extensions/tool-gate.ts`, replace the whole `const GATES: ToolGate[] = [ ... ];` block with:
```ts
/**
 * Gated tool groups — each activates when the prompt contains any keyword.
 * Keywords are matched case-insensitively as simple substring checks.
 */
const GATES: ToolGate[] = [
  {
    names: ["flux2", "flux2_help"],
    keywords: [
      "flux", "image", "圖像", "圖片", "生成圖", "generate image",
      "t2i", "scene", "style", "swap", "outpaint", "upscale image",
      "flux2", "render", "把...做成",
    ],
    description: "Flux2 image generation — text-to-image, i2i, faceswap, outpaint, upscale, restore",
    savedTokens: 1411,
  },
  {
    names: ["krea2", "krea2_help"],
    keywords: ["krea", "draft", "草圖", "快速生成"],
    description: "Krea2 fast image generation — real-time draft to image",
    savedTokens: 641,
  },
  {
    names: ["ltx", "ltx_help"],
    keywords: [
      "ltx", "video", "影片", "視頻", "電影", "動畫",
      "t2v", "i2v", "vbvr", "relay", "storyboard",
      "generate video", "生成影片", "生成視頻",
    ],
    description: "LTX video generation — text/image-to-video, upscale, storyboard, relay",
    savedTokens: 1802,
  },
  {
    names: ["file2md", "vision_ask"],
    keywords: [
      "file2md", "vlm", "describe", "caption", "ocr", "識別", "讀圖",
      "分析圖片", "分析圖像", "read this image", "what is in",
      "pdf", "scan", "to markdown", "轉 markdown", "vision",
    ],
    description: "Document/image understanding — file→markdown, VLM describe, OCR, caption",
    savedTokens: 685,
  },
  {
    names: ["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology"],
    // S1: narrowed — removed the over-broad "context" / "token" / "debug" which fired on
    // ~every dev turn and made inspect effectively always-on. Kept phrase-level terms.
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
      "multi-step", "chain",
    ],
    description: "Workflow orchestrator — multi-agent fan-out/pipeline JavaScript scripts",
    savedTokens: 706,
  },
  {
    names: ["collect_videos", "organize_vault_notes", "import_memory_to_vault"],
    keywords: [
      "collect", "bilibili", "youtube", "video trending",
      "vault notes", "organize", "import memory",
    ],
    description: "Research tools — collect trending videos, organize vault notes, import memory",
    savedTokens: 723,
  },
  {
    // S1/B: movie was ungated (fail-open ⇒ always active). Now gated. savedTokens measured
    // 2026-07-20 via schema-cost (movie=348 + movie_help=284, charsPerToken=4).
    names: ["movie", "movie_help"],
    keywords: [
      "movie", "montage", "preflight", "compose",
      "storyboard", "分鏡", "剪輯", "影片製作", "導演",
    ],
    description: "Movie orchestrator — idea→script→scene→assets→edit→compose pipeline",
    savedTokens: 632,
  },
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — all prior tests still green, plus the 4 new GATES-data tests.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): add gate descriptions, movie gate, narrow inspect (S1 B/C)

- ToolGate.description field (for enable_tool intent/list in T5)
- new movie/movie_help gate (was ungated → always active; savedTokens=632 measured)
- inspect keywords narrowed: drop context/token/debug (always-on), keep phrase-level"
```

---

## Task 2: `matchIntent` pure function

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (add exported `matchIntent` after `computeActiveTools`)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Consumes: `ToolGate` (with `description` from T1), `CORE_TOOLS`.
- Produces: `matchIntent(intent: string, gates: ToolGate[], sticky: Set<string>): ToolGate[]` — dormant gates whose keywords ∪ description-words substring-match the intent, in declaration order; empty = no match.

- [ ] **Step 1: Write the failing tests**

Add `matchIntent` to the import line:
```ts
import { computeActiveTools, CORE_TOOLS, GATES, matchIntent } from "./tool-gate.ts";
```

Append:
```ts
describe("matchIntent (S1)", () => {
  const sticky = () => new Set(CORE_TOOLS);

  test("video intent → ltx", () => {
    expect(matchIntent("make a video", GATES, sticky()).map((g) => g.names[0])).toEqual(["ltx"]);
  });
  test("image intent → flux2", () => {
    expect(matchIntent("generate an image of a cat", GATES, sticky()).map((g) => g.names[0])).toEqual(["flux2"]);
  });
  test("describe intent → file2md", () => {
    expect(matchIntent("describe this picture", GATES, sticky()).map((g) => g.names[0])).toEqual(["file2md"]);
  });
  test("movie intent (CJK) → movie", () => {
    expect(matchIntent("做一個 movie 分鏡", GATES, sticky()).map((g) => g.names[0])).toEqual(["movie"]);
  });
  test("workflow intent → workflow", () => {
    expect(matchIntent("orchestrate a parallel pipeline", GATES, sticky()).map((g) => g.names[0])).toEqual(["workflow"]);
  });
  test("S1 over-broad pin: 'docker image cleanup' → flux2 (image keyword); S2 narrows", () => {
    expect(matchIntent("docker image cleanup", GATES, sticky()).map((g) => g.names[0])).toEqual(["flux2"]);
  });
  test("no match → []", () => {
    expect(matchIntent("what's the weather", GATES, sticky())).toEqual([]);
  });
  test("dormant-skip: already-active gate is not returned", () => {
    const s = sticky();
    s.add("ltx"); s.add("ltx_help");
    expect(matchIntent("make a video", GATES, s)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `matchIntent` is not exported.

- [ ] **Step 3: Implement `matchIntent`**

In `extensions/tool-gate.ts`, immediately after the `computeActiveTools` function, add:
```ts
/**
 * Find dormant gates whose **keywords** are a substring of `intent`. Pure: no
 * pi dependency. Used by enable_tool's intent mode. Returns gates in declaration
 * order; empty = no match.
 *
 * "Dormant" = not all of the gate's tools are already in `sticky`. A gate matches
 * if any keyword appears as a substring of the (lowercased) intent.
 *
 * NOTE: matching is keywords-only, NOT keywords∪description. Description-word
 * matching was prototyped and rejected: prose words like "image"/"pipeline"
 * appear in several gates' descriptions and over-match (krea2/movie fired on
 * intents that should hit only flux2/workflow). The `description` field is still
 * valuable for the human-readable `list` output (T5) and a future semantic
 * matcher, but not for substring matching. Verified 2026-07-20.
 */
export function matchIntent(
  intent: string,
  gates: ToolGate[],
  sticky: Set<string>,
): ToolGate[] {
  const needle = intent.toLowerCase();
  return gates.filter((g) => {
    if (g.names.every((n) => sticky.has(n))) return false; // skip already-active
    const fields = g.keywords.map((k) => k.toLowerCase());
    return fields.some((f) => f.length > 0 && needle.includes(f));
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — all 8 new matchIntent tests green.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): add matchIntent pure helper for enable_tool intent mode (S1 A)"
```

---

## Task 3: Telemetry helpers — `emitToolGateLog`, `isMissCandidate`

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (add `import { appendFileSync } from "node:fs";` near the top; add two exported helpers)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Produces:
  - `emitToolGateLog(entry: ToolGateLogEntry): void` — writes one JSON line to stderr (default) or `process.env.TOOL_GATE_LOG_PATH` (file); no-op if `TOOL_GATE_LOG=0`; swallows write errors.
  - `isMissCandidate(prompt, gatesFired, dormantGates): boolean` — true iff prompt non-empty ∧ no gate fired ∧ ≥1 dormant gate.
  - `ToolGateLogEntry` type.

- [ ] **Step 1: Write the failing tests**

Add imports:
```ts
import { emitToolGateLog, isMissCandidate } from "./tool-gate.ts";
```

Append:
```ts
describe("telemetry helpers (S1)", () => {
  test("isMissCandidate: non-empty prompt + no fire + dormant ≥1 → true", () => {
    expect(isMissCandidate("hello", [], ["ltx"])).toBe(true);
  });
  test("isMissCandidate: empty prompt → false", () => {
    expect(isMissCandidate("   ", [], ["ltx"])).toBe(false);
  });
  test("isMissCandidate: a gate fired → false", () => {
    expect(isMissCandidate("make a video", ["ltx"], ["movie"])).toBe(false);
  });
  test("isMissCandidate: no dormant gate → false", () => {
    expect(isMissCandidate("hello", [], [])).toBe(false);
  });

  test("emitToolGateLog writes one JSON line to stderr by default", () => {
    const sink: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = (s: string) => { sink.push(s); return true; };
    try {
      emitToolGateLog({ kind: "turn", ts: "x", promptLen: 5, gatesFired: [], dormantGates: ["ltx"], activeCount: 20, totalCount: 40 });
    } finally {
      (process.stderr as { write: (s: string) => boolean }).write = orig;
    }
    expect(sink.length).toBe(1);
    const parsed = JSON.parse(sink[0]);
    expect(parsed.kind).toBe("turn");
    expect(parsed.dormantGates).toEqual(["ltx"]);
  });

  test("emitToolGateLog is a no-op when TOOL_GATE_LOG=0", () => {
    const orig = process.env.TOOL_GATE_LOG;
    process.env.TOOL_GATE_LOG = "0";
    const sink: string[] = [];
    const w = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = (s: string) => { sink.push(s); return true; };
    try {
      emitToolGateLog({ kind: "turn", ts: "x", promptLen: 1, gatesFired: [], dormantGates: [], activeCount: 1, totalCount: 1 });
    } finally {
      (process.stderr as { write: (s: string) => boolean }).write = w;
      process.env.TOOL_GATE_LOG = orig;
    }
    expect(sink.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `emitToolGateLog` / `isMissCandidate` not exported.

- [ ] **Step 3: Add the `node:fs` import**

At the top of `extensions/tool-gate.ts`, after the existing `import type { ExtensionAPI } ...` line, add:
```ts
import { appendFileSync } from "node:fs";
```

- [ ] **Step 4: Add the telemetry helpers**

In `extensions/tool-gate.ts`, immediately after `matchIntent`, add:
```ts
// ── Telemetry (S3-lite, baked in) ─────────────────────────────────
// stderr by default; opt-in JSONL file via TOOL_GATE_LOG_PATH; disable via
// TOOL_GATE_LOG=0. Non-essential: write failures are swallowed. Purpose:
// quantify the dormant-tool miss rate (the "miss_candidate" kind) so the
// escape-hatch risk becomes measurable instead of structural-but-invisible.

export interface ToolGateLogEntry {
  kind: "turn" | "activate" | "miss_candidate";
  ts: string;
  [k: string]: unknown;
}

export function emitToolGateLog(entry: ToolGateLogEntry): void {
  if (process.env.TOOL_GATE_LOG === "0") return;
  const line = JSON.stringify(entry);
  try {
    const file = process.env.TOOL_GATE_LOG_PATH;
    if (file) appendFileSync(file, line + "\n");
    else process.stderr.write(line + "\n");
  } catch {
    /* non-essential */
  }
}

/** A turn is a miss-candidate iff prompt non-empty, no gate fired, ≥1 dormant gate. */
export function isMissCandidate(
  prompt: string,
  gatesFired: string[],
  dormantGates: string[],
): boolean {
  return prompt.trim().length > 0 && gatesFired.length === 0 && dormantGates.length > 0;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — all telemetry tests green.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): add telemetry helpers emitToolGateLog + isMissCandidate (S1 S3-lite)"
```

---

## Task 4: Per-turn `allToolNames` refresh (D), `lastPrompt`, banner G fix, turn telemetry

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (the `toolGateExtension` body — both `pi.on` handlers)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Consumes: `emitToolGateLog`, `isMissCandidate` (T3).
- Produces: `toolGateExtension` now (a) re-fetches `allToolNames` each `before_agent_start`, (b) records `lastPrompt` (closure var, read by T5's `enable_tool`), (c) banner `saved` counts only gates whose tools are loaded, (d) emits `turn` + `miss_candidate` telemetry.

- [ ] **Step 1: Write the failing test (banner G fix is the unit-testable part)**

The per-turn refresh and telemetry are integration behavior; the cleanly unit-testable piece is the banner's "no phantom tools" rule. Extract it into a pure helper and test that.

Add to imports:
```ts
import { computeActiveTools, CORE_TOOLS, GATES, computeBannerSaved } from "./tool-gate.ts";
```
Append:
```ts
describe("computeBannerSaved (S1 G fix)", () => {
  test("counts only gates whose tools are actually loaded (excludes phantom movie)", () => {
    // only ltx + flux2 tools are loaded this session; movie is NOT loaded
    const loaded = [...CORE_TOOLS, "ltx", "ltx_help", "flux2", "flux2_help"];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("", loaded, sticky); // CORE-only ⇒ ltx & flux2 gated
    const saved = computeBannerSaved(active, loaded);
    // flux2 (1411) + ltx (1802) only; movie (632) excluded because it isn't loaded
    expect(saved).toBe(1411 + 1802);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `computeBannerSaved` not exported.

- [ ] **Step 3: Add the `computeBannerSaved` pure helper**

In `extensions/tool-gate.ts`, after `isMissCandidate`, add:
```ts
/**
 * Sum `savedTokens` for gates that are (a) actually loaded this session
 * (at least one name in `allToolNames`) and (b) currently gated (no name in
 * `active`). Fixes the phantom-tool over-report: previously a gate whose
 * tools were never registered still counted its savedTokens.
 */
export function computeBannerSaved(active: string[], allToolNames: string[]): number {
  return GATES
    .filter((g) => g.names.some((n) => allToolNames.includes(n))) // loaded
    .filter((g) => !g.names.some((n) => active.includes(n)))      // gated
    .reduce((sum, g) => sum + g.savedTokens, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS.

- [ ] **Step 5: Wire the helper + refresh + lastPrompt + telemetry into `toolGateExtension`**

Replace the entire `export default function toolGateExtension(pi: ExtensionAPI) { ... }` body with:
```ts
export default function toolGateExtension(pi: ExtensionAPI) {
  let allToolNames: string[] = [];
  let sticky = new Set<string>(CORE_TOOLS);
  let lastPrompt = ""; // captured each turn; read by enable_tool (T5)

  // ── On session start: capture full tool list and gate ──
  pi.on("session_start", async (_event, ctx) => {
    allToolNames = pi.getAllTools().map((t: { name: string }) => t.name);
    sticky = new Set(CORE_TOOLS);
    lastPrompt = "";

    const active = computeActiveTools("", allToolNames, sticky);
    pi.setActiveTools(active);

    // G fix: only count loaded gates (computeBannerSaved filters by allToolNames).
    const saved = computeBannerSaved(active, allToolNames);

    const debug = process.env.TOOL_GATE_DEBUG_BANNER === "1";
    const theme = ctx.ui.theme;
    scheduleToolGateBanner(
      ctx,
      [
        theme.fg("accent", `🔧 Tool gate: ${active.length}/${allToolNames.length} active`),
        theme.fg("dim", `saves ~${saved} tok/req`),
      ],
      debug ? { immediate: true, log: true } : undefined,
    );
  });

  // ── Per-turn: refresh tool list (D), re-evaluate gates (sticky), emit telemetry ──
  pi.on("before_agent_start", async (event, _ctx) => {
    // D: re-fetch each turn so dynamically-registered or renamed tools are seen.
    allToolNames = pi.getAllTools().map((t: { name: string }) => t.name);
    const prompt = event.prompt ?? "";
    lastPrompt = prompt;

    const before = new Set(sticky);
    const active = computeActiveTools(prompt, allToolNames, sticky);
    pi.setActiveTools(active);

    // telemetry: which gates newly fired this turn, which are still dormant
    const gatesFired = GATES
      .filter((g) => g.names.some((n) => sticky.has(n) && !before.has(n)))
      .map((g) => g.names[0]);
    const dormantGates = GATES
      .filter((g) => !g.names.every((n) => sticky.has(n)))
      .map((g) => g.names[0]);

    emitToolGateLog({
      kind: "turn", ts: new Date().toISOString(),
      promptLen: prompt.length, gatesFired, dormantGates,
      activeCount: active.length, totalCount: allToolNames.length,
    });
    if (isMissCandidate(prompt, gatesFired, dormantGates)) {
      emitToolGateLog({
        kind: "miss_candidate", ts: new Date().toISOString(),
        dormantGates, promptHead: prompt.slice(0, 80),
      });
    }
  });

  // enable_tool is registered in Task 5 (appended here).
}
```

- [ ] **Step 6: Run full suite to verify no regressions**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — all tests green (the `before_agent_start`/`session_start` changes are not directly unit-tested here; they are covered by the T6 probe + the existing banner tests which still pass since `scheduleToolGateBanner` is unchanged).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): refresh allToolNames per turn, capture lastPrompt, fix banner phantom count, emit turn/miss telemetry (S1 D/G)"
```

---

## Task 5: `enable_tool` escape-hatch tool

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (add `import { Type } from "typebox";`; add `"enable_tool"` to `CORE_TOOLS`; register the tool inside `toolGateExtension`)
- Test: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`

**Interfaces:**
- Consumes: `matchIntent` (T2), `emitToolGateLog` (T3), `computeActiveTools`, `GATES`, `CORE_TOOLS`, and the closure vars `sticky`/`allToolNames`/`lastPrompt` (T4).
- Produces: a registered tool `enable_tool` with params `{ intent?, name?, list? }`, always active (in `CORE_TOOLS`).

- [ ] **Step 1: Write the failing tests**

The tool's `execute` reads the closure vars (`sticky`/`allToolNames`/`lastPrompt`) which are populated by `session_start`, so the mock must fire `session_start` after wiring handlers. Add import:
```ts
import toolGateExtension from "./tool-gate.ts";
```
Append:
```ts
describe("enable_tool (S1 A escape hatch)", () => {
  function setupPi(loadedTools: string[]) {
    const calls: { setActiveTools: string[] }[] = [];
    const registered: { name: string; execute: (a: string, p: any) => Promise<any> }[] = [];
    const handlers: Record<string, (e?: any, ctx?: any) => Promise<void> | void> = {};
    const pi: any = {
      getAllTools: () => loadedTools.map((name) => ({ name })),
      setActiveTools: (names: string[]) => { calls.push({ setActiveTools: names }); },
      registerTool: (def: any) => { registered.push(def); },
      on: (ev: string, h: any) => { handlers[ev] = h; },
    };
    toolGateExtension(pi);
    // fire session_start so the closure populates allToolNames + sticky (as a real session does)
    if (handlers.session_start) {
      handlers.session_start({}, {
        ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} },
      });
    }
    const enableTool = registered.find((r) => r.name === "enable_tool")!;
    return { pi, calls, registered, enableTool, handlers };
  }

  test("enable_tool is registered and is in CORE_TOOLS (always active)", () => {
    expect(CORE_TOOLS.has("enable_tool")).toBe(true);
    const { enableTool } = setupPi([...CORE_TOOLS, "ltx", "ltx_help", "flux2", "flux2_help", "movie", "movie_help"]);
    expect(enableTool).toBeTruthy();
  });

  test("list:true returns only dormant gates", async () => {
    const { enableTool } = setupPi([...CORE_TOOLS, "ltx", "ltx_help", "flux2", "flux2_help"]);
    const res = await enableTool.execute("id", { list: true });
    const text = res.content[0].text;
    expect(text).toContain("ltx");
    expect(text).toContain("flux2");
  });

  test("intent 'make a video' activates ltx (sticky) and calls setActiveTools", async () => {
    const { enableTool, calls } = setupPi([...CORE_TOOLS, "ltx", "ltx_help"]);
    const res = await enableTool.execute("id", { intent: "make a video" });
    expect(res.content[0].text).toContain("ltx");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1].setActiveTools).toEqual(expect.arrayContaining(["ltx", "ltx_help"]));
  });

  test("name 'movie' activates the movie gate", async () => {
    const { enableTool, calls } = setupPi([...CORE_TOOLS, "movie", "movie_help"]);
    const res = await enableTool.execute("id", { name: "movie" });
    expect(res.content[0].text).toContain("movie");
    expect(calls[calls.length - 1].setActiveTools).toEqual(expect.arrayContaining(["movie", "movie_help"]));
  });

  test("no-match intent returns a non-error result pointing to list", async () => {
    const { enableTool } = setupPi([...CORE_TOOLS, "ltx", "ltx_help"]);
    const res = await enableTool.execute("id", { intent: "what's the weather" });
    expect(res.content[0].text).toMatch(/no dormant tool matched/i);
    expect(res.content[0].text).toMatch(/list:true/i);
  });

  test("mutation guard: execute never throws even if setActiveTools fails", async () => {
    // setActiveTools throwing inside execute must be caught → error result, not a throw.
    const handlers: Record<string, any> = {};
    const pi: any = {
      getAllTools: () => [...CORE_TOOLS, "ltx", "ltx_help"].map((name) => ({ name })),
      setActiveTools: () => { throw new Error("setActiveTools boom"); },
      registerTool: (def: any) => { (pi as any)._t = def; },
      on: (ev: string, h: any) => { handlers[ev] = h; },
    };
    toolGateExtension(pi);
    if (handlers.session_start) handlers.session_start({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} } });
    const enableTool = (pi as any)._t;
    const res = await enableTool.execute("id", { intent: "make a video" });
    expect(res.content[0].text).toMatch(/error/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: FAIL — `enable_tool` not registered, `CORE_TOOLS.has("enable_tool")` false.

- [ ] **Step 3: Add the `typebox` import and put `enable_tool` in CORE_TOOLS**

At the top of `extensions/tool-gate.ts`, add (with the other imports):
```ts
import { Type } from "typebox";
```
Add `"enable_tool",` to the `CORE_TOOLS` set (e.g. right after `"ask_user_question",`):
```ts
  // User interaction
  "ask_user_question",
  // Escape hatch for dormant gated tools (always active)
  "enable_tool",
```

- [ ] **Step 4: Register `enable_tool` inside `toolGateExtension`**

In `extensions/tool-gate.ts`, inside `toolGateExtension`, just before the closing `}` of the function (where the Task 4 comment `// enable_tool is registered in Task 5 (appended here).` is), replace that comment with:
```ts
  // ── Escape hatch: enable_tool (always active; activates dormant gates) ──
  pi.registerTool({
    name: "enable_tool",
    label: "Enable a gated tool",
    description:
      "Heavy tools (ltx video, flux2 image, movie orchestrator, krea2, file2md/vision, inspect, workflow, research) are GATED out of your tool list to save context. If you need a capability you don't see, call this tool: use `intent` to describe what you want (e.g. 'make a video', 'generate an image', 'orchestrate a montage'), `name` to activate a specific tool (e.g. 'ltx', 'flux2', 'movie'), or `list:true` to see dormant tools. Activation is sticky — once enabled, the tool stays available for the session.",
    promptSnippet: "Enable a gated heavy tool (video/image/movie/...) by intent or name.",
    promptGuidelines: [
      "If you need a capability not in your tool list (e.g. video/image/movie generation), call enable_tool first rather than telling the user it's unavailable.",
    ],
    parameters: Type.Object({
      intent: Type.Optional(Type.String({ description: "Natural-language description of what you want to do; the matching gated tool is activated." })),
      name: Type.Optional(Type.String({ description: "Exact tool or gate name to activate (e.g. 'ltx', 'flux2', 'movie')." })),
      list: Type.Optional(Type.Boolean({ description: "If true, return the list of currently dormant gated tools." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        if (params.list) {
          const dormant = GATES.filter((g) => !g.names.every((n) => sticky.has(n)));
          const lines = dormant.map(
            (g) => `- ${g.names.join(", ")} — ${g.description} (keywords: ${g.keywords.slice(0, 6).join(", ")})`,
          );
          return {
            content: [{
              type: "text" as const,
              text: dormant.length
                ? `Dormant gated tools:\n${lines.join("\n")}`
                : "No dormant tools — all gates are active.",
            }],
          };
        }

        let matched: ToolGate[] = [];
        let via: "name" | "intent" = "intent";
        if (params.name) {
          via = "name";
          matched = GATES.filter((g) => g.names.includes(params.name as string));
        } else if (params.intent) {
          matched = matchIntent(params.intent, GATES, sticky);
        } else {
          return {
            content: [{
              type: "text" as const,
              text: "Call enable_tool with exactly one of: intent, name, or list:true.",
            }],
          };
        }

        const askedFor = (params.name ?? params.intent) as string;
        if (matched.length === 0) {
          emitToolGateLog({
            kind: "activate", ts: new Date().toISOString(),
            via, intent: askedFor, matchedGate: null, activated: [],
          });
          return {
            content: [{
              type: "text" as const,
              text: `No dormant tool matched '${askedFor}'. Call enable_tool with list:true to see available tools.`,
            }],
          };
        }

        const activated: string[] = [];
        for (const g of matched) for (const n of g.names) { sticky.add(n); activated.push(n); }
        const active = computeActiveTools(lastPrompt, allToolNames, sticky);
        pi.setActiveTools(active);
        emitToolGateLog({
          kind: "activate", ts: new Date().toISOString(),
          via, intent: askedFor, matchedGate: matched.map((g) => g.names[0]), activated,
        });
        return {
          content: [{
            type: "text" as const,
            text: `✓ Activated: ${activated.join(", ")}. They are available now (this turn if the runtime refreshes tools per iteration; otherwise on your next message). You can call them directly.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `enable_tool error: ${(err as Error).message ?? String(err)}`,
          }],
        };
      }
    },
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: PASS — all enable_tool tests green, including the mutation-guard test.

- [ ] **Step 6: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bunx tsc --noEmit )` (or the repo's equivalent; if no tsconfig here, run `( cd bun-apps && bunx tsc -p pi-agent-ext-tool-gate/tsconfig.json --noEmit )` — skip gracefully if none exists).
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts
git commit -m "feat(tool-gate): add enable_tool escape hatch for dormant gated tools (S1 A)

Always-on meta-tool (in CORE_TOOLS) with intent/name/list modes. Activates
dormant gates same-turn (sticky + setActiveTools). Self-documenting
description; no separate prompt injection. Fully try/catch'd — never throws."
```

---

## Task 6: Activation-timing probe verification + finalize

**Files:**
- None committed. Throwaway probe in `/tmp`; verification notes added to the spec PR as a comment or a short `docs/` note (optional).

**Interfaces:** Consumes the merged T1–T5 extension.

This task resolves the one residual uncertainty from the spec (§2.5): does `setActiveTools` called inside a tool's `execute` take effect **same turn** (per-iteration refresh) or only **next user message** (per-user-turn)? The `enable_tool` message is worded for both, so either outcome needs no code change — but the verification confirms which is true and lets us tighten the wording.

- [ ] **Step 1: Build the extension into the running pi-agent**

The dev pi-agent loads extensions from `bun-apps/pi-agent/run-dir/manifest.json` (already lists `pi-agent-ext-tool-gate`). No rebuild needed for TS extensions loaded directly. Confirm it loads:
Run: `( cd bun-apps/pi-agent && bun run src/cli.ts --print --self-test 2>&1 | grep -i tool-gate | head )` (or whichever one-shot invocation exits at `session_start`).
Expected: no load error mentioning tool-gate.

- [ ] **Step 2: Run a live probe — same-turn activation**

Start a session and send a prompt that (a) triggers no keyword and (b) asks for a gated capability, with telemetry on:
```bash
TOOL_GATE_LOG_PATH=/tmp/tg.jsonl ( cd bun-apps/pi-agent && bun run src/cli.ts )
```
In the session, send: `「幫我弄一個會動的版本」` (no keyword → ltx dormant). Observe whether the model calls `enable_tool` and, if so, whether it proceeds to call `ltx` **in the same response** (same-turn) or asks the user to continue (next-turn).

- [ ] **Step 3: Inspect telemetry**

Run: `cat /tmp/tg.jsonl`
Expected: a `miss_candidate` entry for the prompt (dormant includes `ltx`), and (if the model used the hatch) an `activate` entry with `matchedGate: ["ltx"]`.

- [ ] **Step 4: Record the finding**

If same-turn: the `enable_tool` message is accurate as-is. Optionally tighten it to drop the "otherwise on your next message" hedge (edit the string in T5's code, commit as `docs(tool-gate): confirm same-turn activation`).
If next-turn: leave the message as-is (it already covers this). Open a follow-up note; no S1 code change needed.

- [ ] **Step 5: Final full-suite + manual smoke**

Run: `( cd bun-apps/pi-agent-ext-tool-gate && bun test )`
Expected: all tests PASS.
Then run the repo-wide extension contract check (per CLAUDE.md):
Run: `bun run --cwd bun-apps/gui-movie-director check:schema` (or the extension-contract gate)
Expected: no new errors attributable to tool-gate.

- [ ] **Step 6: Final commit (if wording tightened) + push + PR**

```bash
# only if Step 4 tightened the message:
git add bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts
git commit -m "docs(tool-gate): confirm same-turn activation, drop next-turn hedge"
git push
```
Open/PR the implementation branch against `main`.

---

## Self-Review (performed by plan author)

**1. Spec coverage:**
- A (escape hatch) → Tasks 2 + 5. ✅
- B (movie gate) → Task 1. ✅
- C (inspect narrowing) → Task 1. ✅
- D (allToolNames refresh) → Task 4 (Step 5, `before_agent_start`). ✅
- G (banner phantom fix) → Task 4 (Step 3 `computeBannerSaved` + Step 5 wiring). ✅
- Telemetry (turn + activate + miss_candidate) → Task 3 (helpers) + Task 4 (turn/miss emit) + Task 5 (activate emit). ✅
- Activation-timing uncertainty → Task 6 (probe). ✅
- Testing section of spec → covered across all tasks. ✅

**2. Placeholder scan:** No "TBD/TODO/implement later". `movie` `savedTokens = 632` is the real measured value. All code blocks are complete. The one speculative branch (Task 6 Step 4 wording tightening) is conditional with explicit both-outcome instructions.

**3. Type consistency:** `ToolGate.description` (T1) is read by `enable_tool`'s `list` output (T5); `matchIntent` (T2) matches on **keywords only** (description-word matching was prototyped and rejected for over-matching generic words — see T2's JSDoc). `matchIntent(intent, gates, sticky): ToolGate[]` signature is identical in T2 definition and T5 call site. `emitToolGateLog(entry)` and `isMissCandidate(prompt, gatesFired, dormantGates)` signatures match between T3 definition and T4/T5 call sites. `computeBannerSaved(active, allToolNames)` matches between T4 helper and call site. `enable_tool`'s `execute` captures `sticky`/`allToolNames`/`lastPrompt` — all assigned in T4's `toolGateExtension` body. The full test suite (13 assertions) was prototyped and verified green before committing this plan. ✅

**4. Known follow-ups (NOT this plan):** S2 keyword precision (word boundaries for `image`/`video`/`pdf`, CJK expansion) — the `docker image → flux2` test in T2 explicitly pins the S1 behavior S2 will flip. S3 full telemetry (replace stale `savedTokens` — flux2=1411 vs measured 654 — with live values; live-updating banner). H (cross-extension setActiveTools last-writer-wins).
