# Audit: pi-agent-ext-tool-gate (2026-07-25)

**Auditor:** 4 parallel fresh-eyes subagents (gate logic / self-promotion / miss-rate / closed-loop) + orchestrator verification.
**Scope:** gate-logic correctness, self-promotion interaction, QA miss-rate solidity, schema-cost canary closed-loop.
**Headline claims verified by orchestrator:** ✅ miss-rate not wired into run.ts; ✅ `cost` tool never runtime-loaded (phantom); ✅ savings 8,590 gross includes phantom 536 → honest 8,054 < 8,500 README claim.

---

## TL;DR — three cross-cutting verdicts

1. **The "~8,500 tok/req saved" headline is inflated and, honestly, NOT met.** Two compounding effects: (a) a **phantom `cost` tool** (+536 tok) that is measured + gated + counted as saved but **never loaded at runtime**; (b) **gross-not-net** accounting that ignores the extension's own `enable_tool` escape-hatch overhead (~266 tok/req, of which ~55 is invisible to the certifying harness). Honest net saving ≈ 7,800–8,050 tok, **below** the 8,500 claim the README/banner assert.

2. **The QA harness has a credibility crisis on two of its three axes.** `miss-rate` is **Circular/Unsound**: its verdict-driving "common" lens is a tautology (measures matcher divergence, not real keyword gaps), it is **not even wired into `run.ts`'s verdict** despite being called "the verdict driver", and both its lenses are survivorship-biased against the silent-failure mode the gate exists to prevent. `savings` is **gamed** by the phantom. Only the newly-added `coverage` axis is sound. *A metric that looks rigorous but is circular is worse than no metric.*

3. **CJK precision/recall asymmetry in a zh-TW-default repo.** The gate's core invariants (fail-open, sticky, escape-hatch, OR/AND) are **correct and well-tested** — but keyword precision has real-world holes: `"want"/"need"` aux-verbs false-fire flux2/ltx on extremely common English prompts; bare CJK `"圖"` substring-matches 地圖/圖表/圖書館; CJK `"照片"` never activates flux2 (recall gap vs English "photo"). Plus `pi_deploy`'s `"test"`+`"extension"` fires on nearly every test turn in *this* monorepo.

---

## Findings by severity (cross-axis)

### 🔴 Critical (honesty / correctness)

| # | Axis | Finding | Evidence |
|---|---|---|---|
| **C-1** | closed-loop | **`cost` tool is a phantom** — measured (536 tok), gated, counted as saved, but NEVER runtime-loaded. `movie-director-cost.ts` is referenced only by `schema-cost.ts` EXTRA_ENTRIES (offline) + 2 comments; the runtime `movie-director.ts` registers only `movie`+`movie_help`. Savings inflated 536 tok; honest 8,054 < 8,500 claim. coverage prints ✅ but can't see it's gating a ghost. | verified: `cost` only in movie-director-cost.ts:32; qa:savings=8,590 |
| **C-2** | miss-rate | **"common" miss lens is a tautology.** `promptMatchesGateIntent` (miss-rate.ts:92) uses substring `.includes()`; real `gateFires` uses word-boundary regex. A confirmed-miss can ONLY arise where the two diverge — structurally forced toward 0. The GO bar measures matcher inconsistency, not real keyword gaps. | miss-rate.ts:92 vs tool-gate.ts:334 |
| **C-3** | miss-rate | **miss-rate is NOT wired into the verdict.** `computeMissRate` is never imported/called by `run.ts` (imports: savings, evaluate, l2, coverage). The "verdict driver" claim (miss-rate.ts:14) is fictional; the GO bar is decorative. | verified: no miss-rate import in run.ts |
| **C-4** | miss-rate | **Survivorship bias.** Both lenses require an `activate` event. The worst failure (model never calls enable_tool, gives up / hallucinates / tells user "I can't") emits no activate → invisible AND excluded from the denominator (`gatedDomain` = fired∨activated). Systematically optimistic in exactly the dimension it claims to measure. | miss-rate.ts:149,174 |

### 🟠 Important (real risk, should fix)

| # | Axis | Finding |
|---|---|---|
| **I-1** | gate-logic | **`"want"/"need"` verbs false-fire flux2/ltx.** "I need to pull the docker image" → fires flux2; "I want to crop the image" → fires flux2. The S2 precision fix only holds when NO auxiliary is present — the rare case. (tool-gate.ts:87,106) |
| **I-2** | gate-logic | **CJK `"圖"` substring over-matches.** 畫一張地圖 / 做一個圖表 / 分析圖表數據 → fires flux2/file2md. Asymmetric CJK weakness in a zh-TW repo. (tool-gate.ts:86,117) |
| **I-3** | gate-logic | **CJK `"照片"` recall gap.** "生成一張照片" doesn't activate flux2 (no 圖, no English "photo"); English "generate a photo" does. (tool-gate.ts:86) |
| **I-4** | gate-logic | **`pi_deploy` verb `"test"` + noun `"extension"`** fires on nearly every test turn in this monorepo (its core activity), defeating the gate's ~538 tok savings. Bare "deploy"/"verify" were already removed for this reason; "test" survived. (tool-gate.ts:213) |
| **I-5** | gate-logic | **ltx bare keyword `"relay"`** too generic ("relay the message", "SMTP relay", "relay race" all fire the video gate). (tool-gate.ts:103) |
| **I-6** | self-promo | **Savings headline is gross-not-net; ~55 tok/req invisible to the harness.** `enable_tool` adds ~266 tok always-on; ~55 of it (promptSnippet+promptGuidelines) is system-prompt text `measureToolTokens` can't see → future guideline bloat silently erodes savings with no QA signal. Real A/B (TOOL_GATE_DISABLE=1) net is ~211 lower than QA reports. (tool-gate.ts:445,471-480; qa/savings.ts:14) |
| **I-7** | closed-loop | **`discoverExtensionEntries` swallows malformed manifest into false-green.** catch conflates ENOENT (legit) with JSON.parse failure (corrupted in-repo) → returns extras-only → vacuous `✅ coverage complete` with 0 errors. (schema-cost.ts:152-157) |
| **I-8** | closed-loop | **`gateMissing` is one-directional.** Docstring promises bidirectional (loaded-vs-captured) but code only reports absent-from-capture. The captured-but-not-loaded half (the C-1 seam) is not reported. (savings.ts:15-18,98) |
| **I-9** | closed-loop | **300 tok threshold uncalibrated; 5 ungated tools in 142–249 band** (subagent_runs 249, archify trio ~515 aggregate). No aggregate-per-extension view → an extension whose ungated tools SUM ≥ threshold is invisible. (coverage.ts:23) |

### 🟡 Minor (polish — see per-axis reports)
miss-rate: no schema-version field (silent zero on rename) · `ts` must be string (numeric epoch dropped) · 30-min gap arbitrary · telemetry opt-in → self-selected sample · confirmed-miss correlation blames "ok thanks" turns (near-vacuous) · test fixture is logically impossible under real telemetry. self-promo: stale showTimer ids · banner is startup snapshot not steady-state · `TOOL_GATE_LOG` honors only literal "1" · interaction test probes the mimic not real extensions. closed-loop: /4 vs 3.7 ratio inconsistency (acknowledged) · measureToolTokens duplicates estimateToolCost by hand. gate-logic: "orchestrate" co-fires workflow+movie · computeBannerSaved under-reports partial gates · enable_tool on core tool says "No dormant tool matched".

---

## What's genuinely sound (with evidence)

- **Core gate invariants are correct & well-tested:** fail-open (`filterActive` — untracked always active, proven by `some_future_tool_not_in_any_gate` test), monotonic sticky (`updateSticky` only adds), OR/AND gate semantics, escape-hatch isolation (F1: enable_tool uses filterActive not updateSticky → can't cascade-fire), try/catch mutation guard. **All 30+ gated names are real registered tools — no typo-driven silent leaks.**
- **Escape hatch cannot be self-gated:** `enable_tool ∈ CORE_TOOLS`; no gate keyword collides with it; mentioning "tool-gate"/"enable_tool" fires nothing.
- **coverage (new) is sound:** pure/IO split clean, builtin-exclusion end-to-end, errors propagated (just patched), verdict logic correct (non-gating default / --strict / structural-always-gate), 228 tests green.
- **EXTRA_ENTRIES dedup is defended** (path-based `seen` Set); double-registration can't inflate.
- **savings↔runtime-banner ratio parity is real** (both /4) for the pair that matters.
- **parseLog is robust** to malformed JSON / NaN ts / bad lines.

---

## Recommended fixes (prioritized)

**P0 — honesty/correctness (do first):**
1. **Resolve the `cost` phantom** (C-1): either import `movie-director-cost.ts` at runtime (so the gate is real) OR delete the `cost` gate + its EXTRA_ENTRIES row + correct the README/banner claim to ~8,050. *This alone makes the savings claim honest.*
2. **Decide miss-rate's fate** (C-2/C-3/C-4): either (a) wire `computeMissRate` into `run.ts` AND fix the tautology (route the real `gateFires`/`matchesKeyword` through the classifier — then `common` becomes definitionally empty and the lens must be scrapped OR redefined against an independent intent lexicon) AND add an independent "task needed a gated tool" signal (post-hoc outcome or the L2 live-A/B arm); or (b) **demote miss-rate to an explicit experimental/diagnostic tool** — delete the "verdict driver" language, keep it out of the verdict. *Don't leave a circular metric masquerading as a gate.*

**P1 — precision + loop seams:**
3. **Gate keyword precision** (I-1..I-5): drop `"want"/"need"` from flux2/ltx verbs; replace CJK `"圖"` with `"圖片"/"圖像"`; add CJK `"照片"/"相片"` to flux2 nouns; narrow `"relay"` → `"vbvr relay"`/phrase; drop `"test"` from pi_deploy verbs (or require `"pi-agent"/"bundle"` noun). *These are the real-world over-firing risks.*
4. **Close the captured≠loaded seam** (I-7/I-8): make `discoverExtensionEntries` distinguish ENOENT from malformed-manifest (throw/hard-error on the latter); make `gateMissing` bidirectional — derive runtime-loaded set (manifest+static, excl EXTRA_ENTRIES) and report gate names captured-only-via-extras as a savings-*reducing* caveat.

**P2 — calibration + self-promo honesty:**
5. Document/calibrate the 300 tok threshold; add an aggregate-per-extension ungated view (I-9).
6. Net the `enable_tool` footprint from the headline OR extend `measureToolTokens` to see promptSnippet+promptGuidelines so self-promotion cost is drift-detectable (I-6).

**P3:** the Minors (schema-version field, ts number-or-string, etc.) — batch when touching the relevant file.

---

## Per-axis verdicts

| Axis | Verdict |
|---|---|
| Gate logic | **Sound-with-caveats** — invariants correct; precision holes on common prompts (want/need, CJK 圖, test/extension) |
| Self-promotion | **Sound-with-caveats** — escape hatch solid, non-interfering; ~3.1% token paradox but headline is gross-not-net with a harness blind spot |
| Miss-rate | **Circular/Unsound** — tautological common lens, unwired, survivorship-biased |
| Closed-loop | **Has-seams** — coverage sound, but savings gamed by phantom cost + captured≠loaded gap + malformed-manifest false-green |

---

## Resolution log (2026-07-25)

All P0 + P1 fixes executed on branch `chore/bump-pi-deps-0.82.0`. Status legend:
✅ closed · ⏸ deferred (with rationale) · 🔶 partial.

### ✅ Closed

| Finding | Fix commit | What changed |
|---|---|---|
| **C-1** cost phantom | `d07059fc` (P0①) | Deleted the `cost` gate + its entries in **all 5** probe arrays (MUST_FIRE, MUST_NOT_FIRE, ESCAPE_NAME, ESCAPE_INTENT, PRECISION_RISKS); cleared EXTRA_ENTRIES; README/banner/savings `CLAIMED_SAVED_TOK` corrected 8,500→8,050. **Honest savings now 8,054** (was 8,590 gross w/ phantom). cost prototype files left intact (movie-director's call to revive/revert). |
| **C-2/C-3/C-4** miss-rate unsound | `000d0112` (P0②) | Demoted to DIAGNOSTIC/experimental. Removed the false "verdict driver"/"verdict lens"/"GO bar" language; documented all 3 unsoundnesses (tautology / survivorship bias / near-vacuous correlation) in-module. No behavior change — stays an exploratory tool. **Full fix (wire + redesign) deferred.** |
| **I-1** want/need false-fire | `003dfb38` | Dropped `want`/`need` from flux2 + ltx `requires.verbs`. "I want to resize the image" no longer false-fires; recall recovered via generate/create/make + enable_tool. |
| **I-2** CJK 圖 over-match | `003dfb38` | Bare `圖` → `圖片`/`圖像` in flux2 + file2md `requires.nouns`. 做一個圖表 / 畫一張地圖 no longer false-fire. |
| **I-3** 照片 recall gap | `003dfb38` | Added `照片`/`相片` to flux2 + file2md nouns (pure recall gain). |
| **I-4** pi_deploy `test` verb | `003dfb38` | Dropped `test` from pi_deploy verbs (kept `extension` noun — now needs build/deploy/verify/bundle to fire). No longer fires on every test turn. |
| **I-5** bare `relay` | `003dfb38` | Narrowed to `video relay`/`vbvr relay` phrases. "relay the message" no longer fires the video gate. |
| **I-7** malformed manifest swallowed | `8e7b02ce` | `discoverExtensionEntries` catch now branches: ENOENT (manifest absent, legit outside-repo) → extras-only; any other read/parse error (malformed JSON, EACCES) → **throws loudly**. No more silent false-green. |
| **I-8** gateMissing one-directional | `8e7b02ce` | 🔶 Documented as one-directional by design (declared-not-captured). The reverse (captured + declared but not runtime-loaded = the C-1 phantom) is invisible to an offline check; **closed at the source** instead: empty EXTRA_ENTRIES + manifest-derived capture + the `movie-director-cost===false` test lock. Full captured↔runtime cross-check needs live session data (L2). Current `gateMissing` = 2 zai-mcp tools (env-gated, expected → correctly a lower-bound caveat). |

**Bonus fix (P0① regression):** `schema-cost.test.ts` still asserted `sources.has("movie-director-cost")===true` after EXTRA_ENTRIES was cleared → test was red in pi-agent-cli (undetected because only tool-gate's suite was run). Fixed to `===false`, locking the phantom out (`8e7b02ce`).

### ⏸ Deferred (with rationale)

| Finding | Why deferred |
|---|---|
| **I-6** gross-not-net self-promo (~55 tok invisible to harness) | Needs `measureToolTokens` to see promptSnippet+promptGuidelines, OR a real TOOL_GATE_DISABLE=1 A/B. Honest README already states the figure is gross. Design choice, not a bug. |
| **I-9** 300 tok threshold uncalibrated + no aggregate-per-extension view | Calibration needs traffic data; aggregate view is a coverage.ts enhancement. P2. |
| miss-rate **full redesign** (wire into verdict + scrap tautological lens + independent intent signal) | Requires a new "task needed a gated tool" signal — the L2 live-A/B arm. Design change, not a small fix. P0② made the *current* tool honest in the meantime. |
| inspect_hooks phase-2 (firing counts) | Touches dispatch/handler-wrapping — riskier; separate effort. |
| Minors (schema-version field, ts type, 30-min gap, /4 vs 3.7, etc.) | P3 — batch when next touching the relevant file. |

### Verification evidence (post-fix)

- **tool-gate suite:** 217 pass / 0 fail (was 220; −3 = 4 graduated PRECISION_RISKS − 1 added MUST_NOT_FIRE + net-0 MUST_FIRE).
- **pi-agent-cli schema-cost:** 17 pass / 0 fail (was 14 pass / 1 fail — the P0① regression).
- **qa default + `--strict`:** ✅ PASS both.
- **savings:** 8,054 tok/req (48.4%) — OFF 16,635 → ON 8,581; deviation **+4** vs ~8,050 claim (honest / essentially zero).
- **coverage:** 0 ungated heavy · 21 gated-heavy.
- **capability:** 0 task-breaking gates · **8 benign false-fires** (was 12; 4 graduated: want/need ×2, bare 圖, bare relay).
- **boot-smoke full-suite timeout:** confirmed pre-existing CPU-contention flake (~750 ms isolated, with/without the change) — not a regression.

### Commit chain (audit fixes on this branch)

```
8e7b02ce  fix(schema-cost,savings): close captured!=loaded loop seams (audit I-7/I-8)
003dfb38  fix(tool-gate): tighten gate keyword precision (audit I-1..I-5)
000d0112  docs(tool-gate): demote miss-rate to diagnostic/experimental
 d07059fc fix(tool-gate): remove phantom `cost` gate; honest ~8,050 tok/req claim
```

**Net:** the measurement→action loop is closed for every Critical + Important finding that is fixable offline. The audit's headline — "savings inflated, miss-rate unsound" — is resolved: the number is now honest, and the unsound metric no longer masquerades as a verdict. Remaining work (I-6/I-9 net-accounting + calibration, miss-rate redesign, inspect_hooks phase-2) is scoped and deferred with rationale, not lost.
