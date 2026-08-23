---
type: task
status: open
---

# 20 — Mermaid → IR converter: convert + validate in one call

## Question

Turn pasted mermaid into a copy-adaptable, *valid* archify IR in one console call, instead
of hand-writing the IR JSON from schema memory.

## What to build

A deterministic line-based converter, `bun run mermaid:convert <input.mmd>`, implementing
the mechanical subset of the vendored "Mermaid as an Input Dialect" mapping
(`vendored/SKILL.md` §) for **all 5 schemas**:

- `flowchart`/`graph` → `workflow` (default `--type`) or `architecture` or `dataflow`
  (`--type` explicit; dataflow uses the D8 convention: subgraph → stage, flow labels =
  edge label or `to <targetLabel>`).
- `sequenceDiagram` → `sequence` (auto-detected), `stateDiagram`(-v2) → `lifecycle`
  (auto-detected). `--type` given for an auto-dialect → usage error.

Subset parser (hand-written, no mermaid AST, zero new deps) with deterministic placement
(spec §7.1.3), shared semantic-typing keyword table (§7.1.4), and **hard errors with
file/line for recognized-but-unbounded syntax** — never a silent drop (a half-converted
IR is valid-but-wrong). After conversion, the same call always runs the vendored
`validate` (real render+composition gate) — the **valid-IR-out contract**: green validate
on the fixture corpus is a bug-level requirement, not a stretch.

Ships as `scripts/mermaid-convert.ts` (scripts/deck.ts pattern) + package.json script +
docs wiring. **No new extension tool** (D9, schema-cost), no schema/emitter/renderer
changes, no IR-library or flagship-deck changes, `vendored/SKILL.md` untouched.

## Acceptance

- [x] `bun run mermaid:convert` converts fixtures for all 5 schema targets (flowchart→
      workflow default, `--type architecture`, `--type dataflow`, auto sequence, auto
      lifecycle); structural tests assert topology preserved (ids, labels, edges).
- [x] Every fixture conversion exits 0 **and** the vendored `validate` is green — the
      valid-IR-out contract; `--no-validate` skips the gate (exit 0 on conversion only).
- [x] Unbounded constructs fail with a hard error naming file/line, tested ≥1 per dialect
      (sequence `alt`/`-)>`, state composite, nested subgraph, flowchart `&&` link);
      style-only constructs (`linkStyle`, unmatched `classDef`) are dropped per the doc.
- [x] CLI contract: IR to stdout by default; `--out <path>` writes the file and sets
      `meta.output`; `--type` mismatch with an auto-dialect → usage error; exit codes
      0 (converted+valid) / 1 (conversion or validation failure with diagnostics) / 2
      (usage error).
- [x] Semantic typing per the fixed table, asserted: `db|store` → database, `auth|fw` →
      security, `queue|bus` → messagebus; workflow diamond `{}` → `type: security` +
      `tag: "decision"`; sequence `-->>` → `variant: return`; lifecycle `[*]` → `type: start`.
- [x] `tests/mermaid-convert.test.ts` (fixture corpus + parser unit tests +
      error cases) green; full `bun run test` green in `s2-agent-ext-archify`;
      `bun run typecheck` clean.
- [x] `scripts/mermaid-convert.ts` added to the scripts-dir-contract allowlist
      (`s2-agent-ext-devops/tests/scripts-dir-contract.test.ts`), that test green.
- [x] Docs wired: `skills/archify/SKILL.md` authoring-loop line + README pointer; the
      unbounded-syntax list documented in `--help`; `vendored/SKILL.md` byte-untouched.
- [x] No existing example/source file changes; IR library + flagship deck untouched;
      suite compat tests green (D5).

## Resolution

Shipped + merged 2026-08-24 on PR #1943 (squash `9944f7b9`, verify-merge CLEAN):
`bun run mermaid:convert` — line-based subset parser (flowchart/sequenceDiagram/stateDiagram)
for all 5 schemas with deterministic placement (workflow columns on the vendored grid's
[0,1,3,5] subset, back-edge return-left, 2nd+ fan-outs drop/bottom-channel + legend-band
check, sublabel-lift), shared whole-word semantic typing, hard line-numbered errors for
unbounded syntax, convert-time routing bounds (same-lane skip, intermediate-lane window,
shared-row loops, lane caps 4/3), and the checker-suggested labelAt fix loop. CLI: stdout
pure JSON, --out (+meta.output), --no-validate, exit 0/1/2, --help bound list. 44 tests
(10-fixture corpus through the real vendored gate, structural label pins, bound/error cases,
CLI exit codes, gated off CI per portability P2). Docs: README § Mermaid → IR converter +
SKILL.md pointer. Gates: `bun run test` 693 pass / 21 skip / 0 fail, typecheck clean,
ci-local --gates 27/27. Two independent reviewer passes: round 1 majors+minors fixed
(3dba85a7), round 2 approve with 2 over-cautious bounds fixed (bcbe0384). No new tool (D9),
schema-cost unchanged, vendored/SKILL.md untouched.
closed: 2026-08-24 (implemented)
