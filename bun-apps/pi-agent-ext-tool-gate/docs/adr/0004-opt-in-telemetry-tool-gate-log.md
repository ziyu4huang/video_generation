**ID:** `ADR-tool-gate-0004` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0004: Opt-in telemetry (`TOOL_GATE_LOG`)

Date: 2026-07-20 (S3, F4 flip)
Status: accepted
See: [spec `2026-07-20-tool-gate-s2-s3-keyword-precision-telemetry-design.md`](../../../../docs/superpowers/specs/2026-07-20-tool-gate-s2-s3-keyword-precision-telemetry-design.md)

## Context

The **dormant-tool miss rate** — how often keyword matching fails to fire a gate the agent actually needed — is the central risk metric of the whole mechanism. Without measuring it, the escape-hatch risk (ADR-0001) is structural-but-invisible: you cannot tell whether gates are catching real intent or quietly stranding the agent. But telemetry that emits on every turn would be noisy in production and a log-size/privacy concern.

## Decision

Add `emitToolGateLog`, **opt-in** (silent by default):

- `TOOL_GATE_LOG=1` → emit JSONL to **stderr**;
- `TOOL_GATE_LOG_PATH=<file>` → append JSONL to a **file**;
- both off → silent.

Three event kinds: `turn` (every `before_agent_start`: gates fired, dormant gates, active/total counts, saved tok), `activate` (an `enable_tool` call), `miss_candidate` (a turn that fired no gate but has ≥1 dormant gate — the miss-rate numerator). Write failures are swallowed (telemetry is non-essential). **F4 (2026-07-20):** flipped from opt-out to opt-in so production sessions stay quiet unless the developer explicitly enables it.

## Consequences

- The miss rate is **measurable on demand**: the `qa:miss` harness parses a telemetry log into escape-rate + confirmed-miss lenses.
- Production is silent; the developer opts in only when measuring.
- The agent harness itself exports `TOOL_GATE_LOG_PATH` in the developer's live sessions — which is how the empirical data behind effort `2026-07-30` ticket 00 (zero observed workflow-gate friction) was gathered. Tests that assert on `emitToolGateLog`'s stderr path must be **hermetic** to this var (snapshot/delete/restore per test, matching the hermes `config.test.ts` PR #938 pattern — applied to `tool-gate.test.ts` in this same effort).

## Alternatives considered

- **Opt-out / always-on.** *Rejected:* noisy on every turn in production; log-size + privacy concern.
- **No telemetry.** *Rejected:* the miss rate stays invisible — the core risk metric unmeasured.
- **Sample-only (emit N% of turns).** *Rejected:* the signal lives in the *rare* `activate` / `miss_candidate` events; sampling would miss them.
