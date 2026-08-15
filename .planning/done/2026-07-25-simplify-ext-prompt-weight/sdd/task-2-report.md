# Task 2 Report — Slim `subagent` + `subagent_runs` tool param schemas (TDD)

**Status:** ✅ DONE
**Commit:** `c25b9243` — `refactor(subagent): slim tool param descriptions (~550 tok/req)`
**Scope:** description strings only. `execute` / `renderCall` / `renderResult` / all logic untouched.

---

## Files changed (3, all committed)

| File | Change |
| --- | --- |
| `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` | Slimmed all 15 `subagentToolSchema` param `description:` strings (verbatim from brief, one exception — see *Decisions*). |
| `bun-apps/pi-agent-ext-subagent/src/subagent-runs-tool.ts` | Added terse descriptions to the two previously-bare enum params (`action`, `status`); preserved every enum literal value. The 4 existing param descriptions were already < 200 chars and left untouched (no fat to cut). |
| `bun-apps/pi-agent-ext-subagent/tests/subagent-schema-weight.test.ts` | NEW — the RED/GREEN weight + shape test (verbatim from brief). |

---

## TDD evidence

### RED — failing test (before any src change)

Command:
```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-schema-weight.test.ts )
```
Result: **2 fail / 1 pass** (24 expect calls).
- `(fail)` `each description is terse (< 240 chars)` — first offender `model desc 297 chars` (commitScope was 507).
- `(fail)` `preserves load-bearing semantic warnings` — `"non-recoverable"` not found (current text is capital `"Non-recoverable"`; `toContain` is case-sensitive).
- `(pass)` `keeps every parameter with its optionality and type` (shape already correct: 15 params, `required: ["task"]`).

### GREEN — after slimming

Command:
```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-schema-weight.test.ts )
```
Result: **3 pass / 0 fail** (35 expect calls).

### Full suite (post-commit, clean tree)

Command:
```bash
( cd bun-apps/pi-agent-ext-subagent && bun test )
```
Result: **217 pass / 0 fail across 16 files** — incl. the two behavior-pinning suites:
- `tests/regression-subagent-contract.test.ts` ✅
- `tests/extension-subagent-registration.test.ts` ✅
- `tests/subagent-runs-tool.test.ts` ✅ (9/9 — confirms enum value additions didn't break the runs tool)

### Lint

```bash
bunx biome check src/subagent-tool.ts src/subagent-runs-tool.ts tests/subagent-schema-weight.test.ts
# → Checked 3 files. No fixes applied. (after one `biome check --write` pass for comment alignment / line-folding in the new test file)
```
All formatting-only; no semantic change to descriptions.

---

## New per-param char counts (`subagent`)

All < 240 (ceiling). `required: ["task"]`.

| param | chars | notes |
| --- | ---: | --- |
| `agent` | 97 | |
| `agentType` | 146 | |
| `task` | 131 | load-bearing: `NO access to this session's history` ✅ |
| `model` | 181 | load-bearing: `only pass a model you know is configured` ✅ (lowercase — see *Decisions*) |
| `tier` | 103 | |
| `cwd` | 57 | |
| `tools` | 100 | |
| `excludeTools` | 57 | |
| `timeoutMs` | 59 | |
| `tokenBudget` | 151 | load-bearing: `non-recoverable` ✅ (now lowercase, was `Non-recoverable`) |
| `spendBudget` | 90 | |
| `retryOnTransient` | 82 | |
| `commitScope` | 229 | was **507**; load-bearing: `never auto-reverts` ✅ |
| `schema` | 137 | |
| `schemaRepairAttempts` | 148 | |

**Max = 229** (`commitScope`). **Total description chars ≈ 1,768** (was ≈ 3,730).

`subagent_runs` enum descriptions added: `action` = 53 chars, `status` = 58 chars (both < 200).

---

## Decisions / deviations (all semantics-preserving)

1. **"16 params" in the brief/task prose is a typo — there are 15.** The schema, the brief's own `EXPECTED` array, and runtime inspection all agree on 15 params. The verbatim test (15 entries) matches reality, so the test was used as written. No action needed; flagged for clarity.

2. **Brief internal contradiction on the `model` load-bearing phrase.** The brief's verbatim *description* text reads `"...falls back. Only pass a model you know is configured."` (capital **O**, sentence-initial), but the brief's verbatim *test assertion* and the task's enumerated load-bearing phrases both require `"only pass a model you know is configured"` (lowercase). `bun:test`'s `toContain` is case-sensitive, so the verbatim description fails the verbatim test. **Resolution (in favor of the sacred load-bearing phrase):** joined with an em-dash instead of a period — `"...falls back — only pass a model you know is configured."` — so the exact lowercase phrase appears and reads naturally. 1-char-class deviation from the brief's description text; semantics identical. This is the only place the brief's description text was not used verbatim.

3. **`tokenBudget` casing:** the original was `"Non-recoverable"` (capital N, sentence-initial). Lower-cased to `"non-recoverable"` to satisfy the case-sensitive load-bearing check; same position (mid-description), same meaning.

4. **`subagent_runs` "slim" was effectively a *completion*, not a cut.** The 4 existing param descriptions (`limit` 38, `cwd` 48, `id` 40, `includeHistory` 72 chars) were already terse and below the 200-char target — no fat to trim without losing meaning. The two genuinely under-specified params were the **bare enums** `action` and `status` (no description at all). Per the brief's "guided judgment" clause and the overarching goal that Task 3 must prove the LLM *still invokes the tool correctly*, I added terse descriptions there (preserving every enum literal value). This adds a small number of tokens to a minor tool; it is dwarfed by the `subagent` savings and directly improves invocation correctness. Flagging so Task 3 / reviewer can adjudicate.

---

## Concerns

- **Token drop not measured here** (Task 3 owns the probe harness / baseline). Per the brief's estimate the `subagent` tool should fall ~1,004 → ~450 tok; the description-char total dropped ~1,962 chars (~53%), consistent with that estimate. Task 3 will confirm authoritatively.
- **Decision #4 above** (adding descriptions to `subagent_runs` `action`/`status`) is the only judgment call that adds tokens rather than removing them; it is small, justified, and isolated to one file for easy revert if the reviewer disagrees.
- **Decision #2** (em-dash + lowercase `only`) is a forced resolution of a brief self-contradiction; documented for traceability.

## Out of scope (deliberately untouched)

`execute`, `renderCall`, `renderResult`, `formatSubagentResult`, `deriveSubagentStatus`, the `subagent_runs` `execute` switch, all enums' literal values, the tool-level `description` / `promptSnippet`, optionality, types. Probe harness / baseline = Task 3.
