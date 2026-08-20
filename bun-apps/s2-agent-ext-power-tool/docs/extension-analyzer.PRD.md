# PRD: `inspect_extensions` tool — Extension health lint

**File**: `src/index.ts` (`makeInspectExtensionsTool` + pure `analyzeExtensions`)
**Tool**: `call inspect_extensions [return_json=...] [tool_token_threshold=...]`
**Status**: shipped (text + JSON output, 8 checks, real-SDK contract-tested).

---

## Problem

This worktree's goal is **finding extension potential issues**. The power-tool
package already had `inspect_context` (measures token distribution) and
`inspect_agent` (dumps YAML state) — but **neither surfaces problems**. They
describe state; they do not lint it. An extension author or repo maintainer had
no automated way to ask "what's wrong with my loaded extensions?"

---

## Goal

One tool that runs a battery of deterministic checks over the currently-loaded
extensions / tools / skills / prompt-guidelines and prints a **severity-ranked
report** + a **per-extension token-tax breakdown**, so the heaviest / least-
specified extensions are obvious. Optional JSON output for machine consumption.

This tool is the **fact layer** for extension health. It does NOT make context-
dependent "is this worth fixing in *this* repo?" judgments — that is the job of
a consumer subagent (see *Layering* below), which reads these findings alongside
the extension source and prioritizes.

---

## Checks

Calibrated against a real run on this repo (the raw run initially reported 46
"issues"; calibration reduced that to the genuinely-actionable ones).

| Sev | Check | Flags |
|-----|-------|-------|
| 🔴 high | `duplicate-tool-name` | Same tool name from ≥2 distinct sources (silent override / `Tool "x" conflicts`) |
| 🔴 high | `missing-description` | Empty/whitespace description (model can't discover it) |
| 🟡 medium | `missing-snippet` | Tool absent from the Available-tools list (no `promptSnippet`) |
| 🟡 medium | `oversized-tool-schema` | API schema (desc + params) above `tool_token_threshold` (default **1500** tok; repeats every request) |
| 🟡 medium | `oversized-skill` | Formatted skill above `skill_char_threshold` (default **2000** ch) |
| 🟡 medium | `oversized-context-file` | Context file above `context_file_char_threshold` (default **20000** ch) |
| 🟢 low | `stale-guideline-ref` | A guideline references a backticked `` `tool` `` that isn't registered |
| ℹ️ info | `no-guidelines` | Non-builtin tool with zero `promptGuidelines` — **informational only**, not counted as an issue (guidelines are SDK-optional AND a context *cost*; absence is often a virtue) |
| ℹ️ info | `extension-token-tax` | Per-extension est. tok/req (non-builtin tools grouped by source) + total |

### Calibration rationale (why `no-guidelines` is info, threshold 1500)

- `promptGuidelines` is **optional** in the SDK (`ToolDefinition.promptGuidelines?`).
- This repo's own README measures **53 guideline bullets = ~3,259 tok** — guidelines
  are a major context cost. Treating absence as a defect inverts the real economics.
  → demoted to `info`.
- `skill_manage` (1244 tok) tripped the initial 1200 default; management tools are
  legitimately larger and 1244 is borderline. → default raised to **1500**.

---

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `return_json` | boolean? | `false` | Return `{findings, summary, total_extension_tokens}` JSON instead of a text report |
| `tool_token_threshold` | number? | `1500` | Flag tools whose API schema exceeds this many tokens |
| `skill_char_threshold` | number? | `2000` | Flag skills above this many formatted chars |
| `context_file_char_threshold` | number? | `20000` | Flag context files above this many chars |

---

## Output

Text report: header → `N issue(s): H high · M medium · L low` (actionable only;
info excluded) → severity sections (✓ clean line when zero actionable) →
**Extension token tax** table (source path | tools | est tok/req | % bar), sorted
desc, with a TOTAL row.

JSON (`return_json=true`): `{findings: Finding[], summary: {total,high,medium,low}, total_extension_tokens: number}`.

---

## Non-Goals

- **No context-dependent judgment.** "Is this missing snippet actually hurting
  *here*?" is not decided by the tool — that is the subagent layer's job.
- **No SDK changes**; `ToolInfo` fields used as-is (no `label`/`promptSnippet` on
  ToolInfo — snippet absence is detected via `opts.toolSnippets[name]`).
- **No auto-remediation**; the tool reports, it does not edit extensions.
- **No LLM call**; checks are deterministic and cheap.

---

## Layering (tool vs subagent)

| Layer | Responsibility | Where to fix false alarms |
|---|---|---|
| **Tool** (this file) | Deterministic facts + conservative severity | **Classification** fixes only — e.g. an SDK-optional field flagged as a defect (`no-guidelines` → info), or a borderline threshold. Not context judgment. |
| **Subagent prompt** (`.pi/agents/extension-auditor.md`, shipped) | Given the tool's JSON findings + extension source read access, judge per-finding true-issue vs false-alarm, produce a prioritized remediation plan | **Context-dependent** judgment — "these 16 obsidian tools are always used as a group, so missing snippets are low priority", etc. |

The two are complementary, not alternatives. The tool must stay a deterministic
fact-finder so its output is stable and cheap; the subagent adds the reasoning.

---

## Verification

- `cd bun-apps/s2-agent-ext-power-tool && bun test` (32 tests: pure checks,
  formatter, end-to-end execute, real-SDK contract).
- `bun run typecheck` clean.
- Manual: `bun bun-apps/s2-agent/src/cli.ts -p "call inspect_extensions"` →
  severity report against the repo's own extensions.

## What it found in this repo (real run, post-calibration)

- pi-obsidian's 16 tools + `zk_*` have no Available-tools snippets (real, cheap
  fix — add one-line `promptSnippet` per tool).
- pi-obsidian is the heaviest extension tax (~35%, 3237 tok/req) of ~9,197
  tok/req total non-builtin.
