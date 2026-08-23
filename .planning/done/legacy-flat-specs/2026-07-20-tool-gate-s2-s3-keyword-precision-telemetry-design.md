# Tool-Gate S2+S3 — Keyword Precision + Runtime Token Measurement (design)

- **Date:** 2026-07-20
- **Status:** Design (awaiting plan)
- **Scope:** `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (+ tests)
- **Sub-project:** S2 + S3 of three (S1 landed in #713)

---

## 1. Context

S1 (#713) shipped the `enable_tool` escape hatch, the movie gate, narrowed inspect, per-turn
`allToolNames` refresh, the phantom-banner fix, and S3-lite telemetry (turn/activate/miss_candidate
JSONL). Two follow-on problems remain:

| ID | Issue | Severity |
|----|-------|----------|
| **S2** | Keyword matching is **substring** over a set with many over-broad **bare words**. `image`/`scene`/`style`/`swap`/`render` (flux2), `draft` (krea2), `video`/`電影`/`動畫` (ltx), `describe`/`what is in`/`vision`/`pdf` (file2md), `chain` (workflow), `collect`/`organize` (research), `movie`/`compose` (movie) false-fire on everyday turns ("coding style", "docker image", "video call", "draft an email", "describe the problem", "supply chain", "collect the data"). They auto-activate heavy tools the user never wanted, wasting the context the gate exists to save. | MED |
| **S3** | `savedTokens` is a **hardcoded static field** that drifts. Measured 2026-07-20: `flux2 = 654` tok vs hardcoded `1411` (2× off). The headline "saves ~X tok/req" number is misleading, with no mechanism keeping it honest as tools evolve. | MED |

### 1.1 Why S2 is safe to do aggressively now

S1's `enable_tool` escape hatch backstops **false-negatives**: if a genuine intent matches no keyword,
the model calls `enable_tool({intent:"make an image"})`. So S2 can optimize for **precision**
(fewer false-fires) — the hatch covers the tail.

### 1.2 The measurement formula is known and dependency-free

`schema-cost.ts:20` defines a tool's token cost as
`Math.round((description.length + JSON.stringify(parameters).length) / 4)` (charsPerToken = 4; no
real tokenizer). Pure string arithmetic — `tool-gate` replicates it inline at `session_start` with
**no cross-package dependency**, costing ~µs per gated tool, never drifting, measuring the tools
*actually loaded this session*.

---

## 2. Design

### 2.1 Self-review discovery: bare-word removal alone is insufficient

The initially-chosen "Aggressive: remove all bare words" strategy was found during spec self-review
to **crater common-case recall** for the **core nouns** `image`/`video`:

- Compound phrases are brittle: keyword `generate image` does **not** match `"generate an image"`
  (the `an` breaks the substring). So removing bare `image` and adding `generate image` still misses
  the single most common image-gen phrasing.
- The escape hatch then routes **high-frequency** intents ("generate an image", "make a video") —
  not the tail it was designed for.

But removing `image`/`video` *is* needed to kill the false-fires the user cited ("docker image",
"video call"). Substring + word-boundary cannot distinguish "docker image" (false) from "generate an
image" (true) — both contain `image` as a whole word.

**Resolution: co-occurrence.** A gate may declare a `requires` trigger — fire only when the prompt
contains **≥1 noun AND ≥1 verb**. `"generate an image"` (generate + image) fires; `"docker image"`
(image, no gen-verb) does not; `"video call"` (video, no verb) does not; `"make a video"` (make +
video) fires. This achieves the user's precision goal **without** the recall loss. It is applied
**only** to the core-noun gates (flux2/ltx/file2md); every other gate is fixed by plain bare-word
removal.

### 2.2 Shared mechanism — `matchesKeyword` + `gateFires`

`matchesKeyword` (word-boundary for single ASCII tokens, substring for phrases/CJK) is unchanged
from the first draft. `gateFires` is new — it combines keyword match with optional co-occurrence:

```ts
/** Word-boundary for single ASCII tokens (prevents "flux" in "conflux", "image" in
 *  "images"); substring for multi-word phrases and CJK. */
export function matchesKeyword(keyword: string, promptLower: string): boolean {
  const kw = keyword.toLowerCase();
  if (/^[a-z0-9]+$/i.test(keyword))
    return new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i").test(promptLower);
  return promptLower.includes(kw);
}

export interface CoOccurrence { nouns: string[]; verbs: string[] }

interface ToolGate {
  names: string[];
  /** Unambiguous triggers — matched via `matchesKeyword`. */
  keywords: string[];
  description: string;
  /** Optional co-occurrence trigger: fire iff prompt has ≥1 noun AND ≥1 verb.
   *  Used only for core nouns whose bare form false-fires (image/video/pdf). */
  requires?: CoOccurrence;
}

/** A gate fires if any keyword matches, OR its `requires` co-occurrence is met. */
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

`computeActiveTools` and `matchIntent` both switch from `gate.keywords.some(...)` to
`gateFires(gate, promptLower)`. Pure + unit-testable (no `pi`).

### 2.3 S2 gate audit

**(a) Bare-word removal** (unambiguous bad words — no recall cost, no co-occurrence needed):

| Gate | REMOVE | KEEP / ADD keywords |
|------|--------|---------------------|
| **flux2** | `scene` `style` `swap` `render` | KEEP `flux` `flux2` `outpaint` `upscale image` `t2i` `圖像` `圖片` `生成圖`. ADD `txt2img` `產圖` `繪圖` `修圖` `去背` `換臉` `做成圖` `轉成圖` (replaces broken literal `把...做成`). |
| **krea2** | `draft` | KEEP `krea` `草圖` `快速生成`. ADD `krea2` `即時生成` `實時繪圖`. |
| **inspect** | (S1 already narrowed) | UNCHANGED. |
| **workflow** | `chain` | KEEP `workflow` `pipeline` `orchestrate` `fan.out` `parallel agent` `multi-step`. |
| **research** | `collect` `organize` | KEEP `bilibili` `youtube` `video trending` `vault notes` `import memory`. ADD `collect videos` `organize vault` `收集影片` `整理筆記`. |
| **movie** | `movie` `compose` (bare) | KEEP `montage` `preflight` `storyboard` `分鏡` `剪輯` `影片製作` `導演`. ADD `make a movie` `movie director` `compose video` `compose scene` `電影製作`. |

**(b) Co-occurrence** for the core nouns whose bare form must go but whose recall must survive:

| Gate | `requires` (noun ∧ verb) | + unambiguous `keywords` |
|------|--------------------------|--------------------------|
| **flux2** | nouns `image` `picture` `photo` `圖` ∩ verbs `generate` `create` `make` `draw` `render` `produce` `生成` `做` `畫` `繪` | (row a) |
| **ltx** | nouns `video` `影片` `視頻` `視訊` `動畫` `電影` ∩ verbs `generate` `create` `make` `animate` `produce` `render` `生成` `做` `製作` `剪` | KEEP `ltx` `t2v` `i2v` `vbvr` `relay` `storyboard`. ADD `影片特效`. |
| **file2md/vision** | nouns `pdf` `document` `文件` `scan` ∩ verbs `read` `convert` `parse` `extract` `ocr` `讀` `轉` `解析` | KEEP `file2md` `vlm` `ocr` `caption` `to markdown` `轉 markdown` `read this image` `分析圖片` `分析圖像` `識別` `讀圖` `看圖`. |

> The ltx nouns `影片`/`視頻` stay in `requires` (not bare keywords): `"下載影片"` (download video)
> has the noun but no gen-verb → no fire; `"生成影片"` (noun + 生成) → fires. This is the
> precision/recall line — core nouns fire only alongside a generation/action verb.

**Effect table (now all accurate):**

| Prompt | Result | Why |
|--------|--------|-----|
| `"docker image cleanup"` | `[]` | image noun, no gen-verb |
| `"generate an image of a cat"` | `[flux2]` | image + generate |
| `"coding style"` | `[]` | `style` removed |
| `"video call"` | `[]` | video noun, no verb |
| `"make a video"` | `[ltx]` | video + make |
| `"做動畫"` | `[ltx]` | 動畫 + 做 |
| `"下載影片"` | `[]` | 影片 noun, no verb |
| `"draft an email"` | `[]` | `draft` removed |
| `"describe the problem"` | `[]` | `describe` removed; problem∉nouns |
| `"read this pdf"` | `[file2md]` | pdf + read |
| `"supply chain"` | `[]` | `chain` removed |
| `"collect the data"` | `[]` | `collect` removed |
| `"orchestrate a montage"` | `[movie]` | `montage` keyword |

### 2.4 S3 — remove `savedTokens`, measure at runtime

1. **Drop the static field.** `interface ToolGate` no longer has `savedTokens`. (Every `savedTokens:`
   line in the `GATES` literal is deleted — these were the stale numbers.)
2. **New pure helper `measureToolTokens`** (replicates `schema-cost.ts:20`):
   ```ts
   export function measureToolTokens(tool: { description?: string; parameters?: unknown }): number {
     const desc = (tool.description ?? "").length;
     const params = JSON.stringify(tool.parameters ?? {}).length;
     return Math.round((desc + params) / 4);
   }
   ```
3. **At `session_start`:** build `measuredTokens: Map<string, number>` = each tool name →
   `measureToolTokens(tool)` over `pi.getAllTools()`, cached in a closure var for the session.
   Missing schema → 0 (fail-safe).
4. **`computeBannerSaved` signature change** — takes the measured map:
   ```ts
   export function computeBannerSaved(
     active: string[],
     allToolNames: string[],
     measuredTokens: Map<string, number>,
   ): number {
     return GATES
       .filter((g) => g.names.some((n) => allToolNames.includes(n))) // loaded
       .filter((g) => !g.names.some((n) => active.includes(n)))      // gated
       .reduce((sum, g) => sum + g.names.reduce((s, n) => s + (measuredTokens.get(n) ?? 0), 0), 0);
   }
   ```
5. **Banner + telemetry** use the measured `saved`. The `turn` telemetry entry gains `savedTok`
   (measured sum of currently-gated loaded gates) for parity with the banner.

**Why not import `pi-agent-ext-power-tool/schema-cost`?** Couples a lightweight always-on extension
to a heavier optional one + its dep graph. The formula is two lines of string arithmetic — inlining
is strictly better. (Impl re-reads `schema-cost.ts:20` + `estimate.ts:22-23` to confirm before coding.)

### 2.5 Verification points (impl-time)

- `pi.getAllTools()` element exposes `.description` (string) + `.parameters` (TypeBox schema object)
  — needed for `measureToolTokens`. Confirm via `types.d.ts` `registerTool`; adapt accessor if the
  runtime object differs.
- Re-confirm `schema-cost` counts *only* `description + parameters` so the inline number matches.

### 2.6 Testing

- **`matchesKeyword`:** `"conflux"` ¬match `flux`; `"flux model"` matches. `"generate image"` matches
  `"generate an image"` is **false** (the `an` breaks it) — this pin documents WHY co-occurrence is
  needed. CJK `"做動畫"` matches keyword `做動畫`.
- **`gateFires` co-occurrence:** with a gate `{requires:{nouns:["image"],verbs:["generate"]}}`:
  `"generate an image"` → true; `"docker image"` → false; `"generate a picture"` (picture∉nouns) →
  false. A gate with matching `keywords` fires regardless of `requires`.
- **Keyword audit (`computeActiveTools`):** every row of the §2.3 Effect table as a case.
- **`matchIntent` parity:** spot-check `"describe the architecture" → []`, `"make an image" → [flux2]`
  (image + make via requires).
- **`measureToolTokens`:** `{description:"abcd", parameters:{a:1}}` → `Math.round((4 + paramsLen) / 4)`.
- **`computeBannerSaved` (new sig):** sums only loaded+gated gates; absent tools contribute 0.
- **Compat:** existing 4 `computeActiveTools` tests + 4 banner tests pass (updated for new sig +
  audited keywords); the S1 test pinning `"docker image cleanup" → [flux2]` is **flipped** to `→ []`
  (the S2 deliverable).

### 2.7 Error handling

- `measureToolTokens` is total (missing fields → 0); `JSON.stringify` guarded so a malformed schema
  never crashes `session_start`.
- `matchesKeyword`/`gateFires` are pure string ops — cannot throw.
- `escapeRegExp` prevents regex-injection from any keyword/noun/verb string.
- No change to existing `try/catch` discipline (`enable_tool.execute`, banner timers, telemetry
  writes all guarded as in S1).

---

## 3. Correctness review (performed before writing this spec)

| Claim | Verdict |
|-------|---------|
| `schema-cost` formula = `(description + parameters) / 4` | ✅ `schema-cost.ts:20`, `estimate.ts:22-23` |
| Default charsPerToken = 4 (no tokenizer) | ✅ `estimate.ts:22` default + `estimate.test.ts:60` |
| `pi.getAllTools()` exposes `.description` + `.parameters` | ⚠️ confirm at impl (§2.5) |
| Co-occurrence kills docker-image/video-call while keeping generate-an-image/make-a-video | ✅ reasoned (§2.3 Effect table) — to be pinned by tests |
| Bare-word removal (style/draft/describe/chain/collect) has no recall cost | ✅ no genuine intent relies on these as bare triggers |
| Word-boundary `\b` safe for `[a-z0-9]+`; `escapeRegExp` prevents injection | ✅ |
| CJK → substring correct (no segmenter needed) | ✅ |
| Removing bare words doesn't break the escape hatch | ✅ hatch consumes `gateFires`; it's the false-negative safety net by design |
| #711 (goal-todo→core-task) didn't rename `todo`/`goal_complete` | ✅ confirmed — `CORE_TOOLS` unaffected |

---

## 4. Out of scope (deferred)

- **Live-updating banner:** the banner is a 5 s `session_start` transient; updating an
  already-dismissed widget is pointless. The measured number is already live in telemetry
  (`turn.savedTok`).
- **Miss-rate dashboard / CLI report:** `miss_candidate` JSONL is already emitted (S1); an analyzer
  is a separate tool.
- **Extending co-occurrence beyond core nouns:** if `miss_candidate` telemetry shows other gates
  over-routing through the hatch, their triggers can gain `requires` — data-driven, not speculative.
- **H — cross-extension `setActiveTools` last-writer-wins:** still unaddressed (additive hatch
  doesn't worsen it).

---

## 5. Next step

Invoke the **writing-plans** skill to turn this spec into a TDD implementation plan:
(`matchesKeyword` + `gateFires` tests → keyword/co-occurrence audit → `measureToolTokens`/
`computeBannerSaved` tests → wire into `session_start`/banner/telemetry → flip the S1-pinned test).
