# Spec: s2-agent-ext-compact — Claude Code-style /compact for s2-agent

Date: 2026-08-22
Status: approved (design review passed in-session 2026-08-22)
Branch: `feat/s2-agent-compact-cc-style`

## Problem

s2-agent (renamed pi-agent) ships a built-in `/compact` whose 7-section summary prompt
(Goal / Constraints / Progress / Key Decisions / Next Steps / Critical Context) loses
information that Claude Code's compaction preserves: verbatim user messages, exact file
paths, current-work quoting, and instruction passthrough (`/compact <instructions>`).

The upstream project `~/proj/pi-smart-compact` (24.7k LOC, EESV pipeline) proves the
seam: `pi.on("session_before_compact")` returning
`{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }` fully replaces the
host-built summary, and any handler error silently falls back to built-in compaction.

## Goal

A new extension `bun-apps/s2-agent-ext-compact` that replaces the summary *content*
with a Claude Code-style 8-section summary augmented by pi-smart-compact's
highest-value hints, while leaving cut-point selection, session-tree handling, and all
failure paths to the host. Plus an offline A/B replay harness proving the change is a
measurable improvement.

## Non-goals (deliberately not ported from pi-smart-compact)

Yield gate, verify/repair loop, telemetry, backup/restore, context-graph. Each needs
its own state machine and persistence layer; this effort targets behavior alignment +
measurability. If A/B shows hallucination pressure that needs verify/repair, that is a
data-backed follow-up.

## Design

### Package & registration

- `bun-apps/s2-agent-ext-compact` (`@repo/s2-agent-ext-compact`)
- Entry: `extensions/compact.ts` (ONE registered entry), `main: "./src/index.ts"` lib face
- `load: static` in `bun-apps/s2-agent/src/registry-config.ts` + `deploy:` block
  (pure TS, zero native deps → clean base-set member; no `vendor:` needed)
- Deploy: YES (user decision) — the extension must ride the portable `s2-agent.sh` tree

### Runtime (single seam)

`pi.on("session_before_compact")`:

```
event.preparation → build prompt → 1 LLM call →
  return { compaction: { summary, firstKeptEntryId, tokensBefore, details } }
                                    ↓ any error
                  notify + return undefined → host runs built-in compaction
```

`firstKeptEntryId` / `tokensBefore` are reused verbatim from host preparation — cut-point
logic untouched. Worst-case failure = summary quality regresses to built-in; the session
tree can never be corrupted by this extension.

Key host properties relied upon (verified in-session 2026-08-22):
- `emit()`: last non-undefined handler result wins; handler throw → swallowed →
  `undefined` → automatic built-in fallback
- `s2-agent-ext-task` also hooks `session_before_compact` (goal-state preservation
  only, returns no compaction) — no conflict
- Host publicly exports `generateSummaryWithUsage` / `findCutPoint` /
  `parseSessionEntries` / `serializeConversation` / `estimateTokens` — A/B arm A calls
  the real built-in functions, not a reimplementation

### Module split (all pure functions except the hook; each unit-testable)

| Module | Responsibility |
|---|---|
| `src/prompt.ts` | CC-style prompt assembly; pure `(PromptInput) => { system, user }` |
| `src/file-ops.ts` | Deterministic file-op extraction (preparation.fileOps + repo tool names incl. multi_edit/patch) |
| `src/session-type.ts` | Infer debugging / implementation / review / discussion from tool-call composition |
| `src/user-messages.ts` | Verbatim user-message collection (CC section 6), capped |
| `src/summarize.ts` | The single LLM call, via host-exported path / central model tier |
| `src/config.ts` | enabled / model override / token budget |
| `extensions/compact.ts` | Hook wiring + error degradation |

### Prompt (core)

Claude Code shape: `<analysis>` section-by-section self-check first, then `<summary>`
with sections: Primary Request and Intent / Key Technical Concepts / Files and Code
Sections / Errors and fixes / Problem Solving / All user messages / Pending Tasks /
Current Work / Optional Next Step.

Six hints layered on from pi-smart-compact:
1. `<verified-files>` ground-truth block above the conversation — file list from
   deterministic extraction; prompt forbids inventing paths outside it (removes the
   highest-hallucination field from LLM hands)
2. session-type-specific instructions (read-only tools ⇒ REVIEW, not implementation)
3. exact-identifier rule — never rewrite code identifiers
4. no "Done" without evidence (passing test or user confirmation)
5. `previousSummary` present ⇒ UPDATE variant — preserve existing sections, overlay
   changes (mirrors host UPDATE prompt and upstream delta)
6. `customInstructions` appended as `Additional focus:` (host convention) —
   `/compact <instructions>` works with zero extra command registration

### A/B replay harness (`scripts/ab.ts`, `bun run ab`)

- N sufficiently-large real sessions from `~/.pi/agent/sessions` (4151 files, up to
  12MB); `--session <path>` to pin one
- `parseSessionEntries` → `findCutPoint(...)` computes ONE shared cut point fed to both arms
- Arm A = host `generateSummaryWithUsage()` itself; Arm B = our prompt; same model,
  same maxTokens
- Metrics: compression ratio, summary tokens, wall ms, provider usage/cost
- Quality: fact set built from deterministic extraction (touched paths, user requests,
  error strings); judge model blind-scores shuffled X/Y arms on recall + rubric
- Output: per-session table + means; `--json` to file

### Tests & CI

`bun test` (prompt snapshot, file-ops extraction, session-type inference, hook-throw →
built-in degradation) + `tsc --noEmit`. Scripts MUST be named `test` / `typecheck` —
local_ci resolves gates by script NAME. Cross-package typecheck via s2-agent must stay
green.

### Learning record

`docs/UPSTREAM-LESSONS.md` in the package records pi-smart-compact's portable
conclusions (EESV layering, yield gate, canonical section parsing vs
`includes("## goal")`, pending-slot / branch-provenance necessity, and why this version
deliberately omits what it omits). `CONTEXT.md` per repo domain convention.

## Acceptance

1. Extension registered static + deploy; deployed `s2-agent.sh` tree includes it
2. `/compact` in a live session produces the CC-style 8-section summary
3. `/compact <instructions>` appends `Additional focus:` and the summary obeys it
4. Handler error (e.g. LLM unreachable) degrades to built-in compaction with a notify
5. A/B harness runs both arms on ≥5 real sessions, JSON report produced
6. `bun test` + `typecheck` + local_ci green
