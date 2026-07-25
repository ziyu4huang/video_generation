# Spec: tool-gate coverage check — close the measurement→action loop

**Date:** 2026-07-25
**Effort:** low–medium (one new QA module + wiring + tests; no runtime change)
**Branch:** TBD (create from `chore/bump-pi-deps-0.82.0` or main)
**Status:** design approved (threshold 300 tok; verdict non-gating by default, `--strict` only)

## Problem

power-tool and tool-gate are a **measurement↔action** pair that are *not closed*:

- power-tool's `schema-cost` measures every tool's per-request token cost.
- tool-gate's `GATES` array is **hand-maintained** — every heavy tool must be added by name.
- **Gap:** if a new heavy extension lands but is not added to any gate, tool-gate's
  fail-open design keeps it always-active (safe — no breakage) but the **savings
  silently degrade**. Nothing detects "a heavy tool exists that nobody gated."

The 2026-07-24 wayfinder map explicitly names this as fog:

> *self-tuning gate set (auto-discover heavy tools to gate from schema-cost + usage
> rather than hardcoding `GATES`)* — parked behind the miss-rate verdict (ticket 05).

This effort **sharpens the structural-discovery half** of that fog item into a
concrete, shippable ticket. (The usage/auto-tuning half stays fog.)

## Goal

A new offline QA, `qa/coverage.ts`, that answers:

> **"Which registered tools are heavy (≥ threshold tok/req) but NOT tracked by any
> tool-gate gate — i.e. candidates the author forgot to gate?"**

It is a **third, independent axis** alongside the two existing QA dimensions:

| Axis | Question | Existing QA |
|---|---|---|
| Savings | How much does gating save? | `qa/savings.ts` ✅ |
| Recall | Does keyword matching catch real intents? | `qa/miss-rate.ts` ✅ (2026-07-24) |
| **Coverage** | **Are all heavy tools gated at all?** | **this spec** |

Coverage ≠ recall (prompt-level) and ≠ savings (amount). It is **structural
completeness** — author-facing, not agent- or prompt-facing.

## The closed loop (why this is "接起量測→行動")

```
power-tool schema-cost  ──measures──▶  per-tool tok/req
        │
        ▼
qa/coverage.ts  ──finds──▶  heavy tools NOT in TRACKED_TOOLS  (this work)
        │
        ▼
author adds a GATE entry
        │
        ▼
qa/savings.ts   ──confirms──▶  the new gate's recovered tok/req
```

Before this: the loop is open (savings measures what *is* gated; nothing flags what
*should* be). After: `bun run qa` surfaces both the savings AND the coverage gap.

## Architecture

**Lives in tool-gate** (not power-tool) to preserve the existing one-way dependency:

```
tool-gate  ──imports──▶  power-tool schema-cost (via pi-agent-cli)
                       (qa/savings.ts already does this; coverage.ts mirrors it)
```

power-tool does **not** import tool-gate → **no circular dependency**. This is the
core constraint that shaped the design (rejected: power-tool importing `GATES`;
rejected: a shared gated-manifest artifact).

### `qa/coverage.ts` (~120 LOC, mirrors `savings.ts` shape)

```ts
import { buildSchemaCostReport, resolveRepoRoot } from "../../pi-agent-cli/src/commands/schema-cost.ts";
import { CORE_TOOLS, GATES, TRACKED_TOOLS } from "../extensions/tool-gate.ts";

export const DEFAULT_COVERAGE_THRESHOLD = 300; // tok/req — configurable

export interface UngatedTool { name: string; tokens: number; source: string; }
export interface CoverageReport {
  root: string;
  threshold: number;
  totalTools: number;
  heavyTools: number;          // tools >= threshold (excl. builtins)
  ungated: UngatedTool[];      // heavy AND not in TRACKED_TOOLS (excl. builtins)
  gatedHeavy: number;          // heavy AND tracked — healthy
  pass: boolean;               // ungated.length === 0
}
export async function measureCoverage(root?: string, threshold?: number): Promise<CoverageReport>
export function formatCoverage(r: CoverageReport): string[]
export function assertSane(r: CoverageReport): string[]  // structural guards
```

**Logic (pure after the one `buildSchemaCostReport` call):**

1. `report = await buildSchemaCostReport(root)` — same call `savings.ts` uses.
2. For each tool with `source !== "(builtin)"` and `approxTokens >= threshold`:
   - if `TRACKED_TOOLS.has(name)` → counted as `gatedHeavy` (healthy).
   - else → pushed to `ungated` (the finding).
3. Sort `ungated` desc by tokens.

### `qa/run.ts` wiring

- Add a `CoverageReport` field to `QaResult` + a `## Coverage` report block.
- Add one summary line to `runQa`'s stdout summary.
- Add `--coverage-threshold <n>` CLI flag (default 300).
- **Verdict:** coverage does **not** affect `pass` by default (mirrors how benign
  false-fires are reported-but-not-gating). Under `--strict`, `ungated.length > 0`
  → FAIL (mirrors `taskBreakingGates` under `--strict`).
- `reason` string extended to mention coverage only under `--strict`.

### `package.json`

Add `"qa:coverage": "bun run qa/coverage.ts"` (parallel to `qa:savings` / `qa:miss`).

### `extensions/tool-gate.ts`

One-word change: `const TRACKED_TOOLS` → `export const TRACKED_TOOLS`. Already
computed at module load; exporting it lets coverage.ts (and a future savings.ts
refactor) use it directly instead of recomputing. Zero behavior change.

## Key decisions (approved)

1. **Threshold = 300 tok** (configurable via `--coverage-threshold`).
   Rationale: the cheapest current gate recovery is ~93 tok (`arxiv_paper`,
   bundled) / ~538 tok (`cost`); 300 sits below most worthwhile standalone gates
   but above noise. Surfaced as advisory; author can tighten per-run.
2. **Verdict non-gating by default; `--strict` only.** A new ungated heavy tool
   may be intentional (a tool that should stay always-on). Mirrors the existing
   treatment of task-breaking gates + false-fires (reported always, gated only
   under `--strict`).
3. **Builtins excluded.** `read`/`write`/`bash` etc. are in `CORE_TOOLS` by design
   and cannot be gated — never report them.
4. **No runtime change.** This is offline QA only. The runtime `measureToolTokens`
   `/ 4` duplication with power-tool's `DEFAULT_CHARS_PER_TOKEN` is **out of scope**
   here (a separate, smaller follow-up) — coverage uses the *authoritative*
   `buildSchemaCostReport` path, so its numbers cannot drift regardless.

## Tests (`qa/coverage.test.ts`)

Pure-logic tests (no SDK, no repo boot), mirroring `savings.test.ts` style:

- `measureCoverage` against a **fake** `SchemaCostReport` fixture:
  - heavy ungated tool → reported in `ungated`.
  - heavy gated tool → counted in `gatedHeavy`, not in `ungated`.
  - builtin heavy tool (e.g. `bash`) → never reported.
  - sub-threshold tool → ignored.
  - `pass === true` iff `ungated.length === 0`.
- `formatCoverage`: GO bar renders `✅` when empty, `❌` + list when not.
- `assertSane`: empty report / negative threshold → structural problem.
- Threshold override via param.
- (integration) a snapshot/inline assertion of the **real repo** run — the known
  gated set should yield a stable `gatedHeavy` count (like savings' structural
  sanity). Exact ungated count is **not** snapshotted (it changes as extensions
  are added — that is the point of the check).

## Out of scope

- **Usage-aware auto-tuning** (gate by *how often* a tool is called, not just
  schema cost) — the other half of the 2026-07-24 fog item; stays fog.
- **Power-tool runtime nudge** (Part 2): enhancing `oversized-tool-schema`'s
  message with a "consider gating (tool-gate) or lazy-loading" hint. Decoupled,
  one-line message change, no new check. **Tracked as an optional follow-up** —
  not required to close the loop (the QA is the authoritative path).
- **Eliminating the `/ 4` heuristic duplication** between tool-gate's
  `measureToolTokens` and power-tool's `estimateTokens`. Separate follow-up;
  coverage is immune (uses `buildSchemaCostReport`).
- **Changing the core pipeline** (`updateSticky`/`filterActive`/`gateFires`) or
  the fail-open + sticky contract — stable, pinned, not on trial.

## Files touched

| File | Action | LOC |
|---|---|---|
| `bun-apps/pi-agent-ext-tool-gate/qa/coverage.ts` | NEW | ~120 |
| `bun-apps/pi-agent-ext-tool-gate/qa/coverage.test.ts` | NEW | ~90 |
| `bun-apps/pi-agent-ext-tool-gate/qa/run.ts` | EDIT (Coverage block + flag + summary) | ~+40 |
| `bun-apps/pi-agent-ext-tool-gate/package.json` | EDIT (`qa:coverage` script) | +1 |
| `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` | EDIT (`export TRACKED_TOOLS`) | 1-word |
| `bun-apps/pi-agent-ext-tool-gate/README.md` | EDIT (document the coverage axis) | ~+15 |

## Verification

```bash
# unit + integration
( cd bun-apps/pi-agent-ext-tool-gate && bun test )

# the new QA standalone
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa:coverage

# full QA gate still passes (coverage is non-gating by default)
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa

# --strict surfaces coverage as a gate (should still pass if repo is fully gated)
bun run --cwd bun-apps/pi-agent-ext-tool-gate qa --strict
```

Success = all tests green + `qa:coverage` runs and reports a stable `gatedHeavy`
count + `bun run qa` unchanged (non-gating) + `qa --strict` still passes (repo is
currently fully gated — if it isn't, that's a real finding, not a test failure).
