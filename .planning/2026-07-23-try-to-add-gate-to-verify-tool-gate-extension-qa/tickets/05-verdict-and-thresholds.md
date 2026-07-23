## Question

Synthesize the **verdict + thresholds** — the decision this whole map exists to
reach: *is tool-gate worth it?* This is a grilling ticket (needs your judgment on
acceptable risk), not something the agent decides alone.

**Inputs (from the three tracks):**
- savings numbers (ticket 00) — does ~8,500 tok/req hold?
- L1 gate results (ticket 02) — every gate fires on intent, zero lookalike
  false-fires, every gate escape-hatch-reachable?
- L2 A/B delta (ticket 04) — does gating a tool hurt task accuracy?

**The verdict framing (literature-grounded):**
- **ToolChoiceConfusion** (arXiv:2606.06284): fewer active tools should *reduce*
  wrong-tool confusion — so a positive L2 (no accuracy loss) + real savings is a
  double win. If L2 shows accuracy loss, weigh it against the confusion-reduction
  benefit tool-gate was meant to deliver.
- **The Tool-Use Tax** (arXiv:2605.00136): gating's token savings may or may not
  beat the capability cost — this is genuinely open in the literature, so the
  verdict is a real finding either way, not a foregone conclusion.

**Decisions to put to you (grilling):** the thresholds — savings floor (tok or %),
max acceptable L1 false-fire count (propose 0), max acceptable L2 accuracy delta
(-propose ≤ a few %). Then: keep tool-gate as-is / tighten its gates / add the
`TOOL_GATE_DISABLE` toggle / escalate to a fix effort.

**Deliverable:** a one-page verdict (numbers + thresholds + recommendation) and,
if negative, a scoped pointer to a follow-up "fix tool-gate" effort (out of scope
here — see map).

**type:** grilling
**blocked by:** [00 savings-measurement](00-savings-measurement.md), [02 harness-skeleton-and-l1-gate](02-harness-skeleton-and-l1-gate.md), [04 l2-task-suite-and-run](04-l2-task-suite-and-run.md)
**claimed:** wayfind-session (2026-07-23) — ✅ CLOSED

## Resolution — verdict: NET POSITIVE, keep tool-gate

Both quality dimensions PASS the default bar; `--strict` is red until 4
task-breaking gates are fixed. **Thresholds encoded into `bun run qa`**
(`SAVINGS_FLOOR` + `taskBreakingGates` strict logic) — durable, not prose.

### The numbers (encoded verdict)
- **Savings: PASS.** 5,554 tok/req (38.6%); floor = ≥15% ∧ ≥2,000 tok (met).
  Claim ~8,500 overstated ~35% → docs follow-up, not a mechanism failure.
- **Capability: PASS (default).** L1 intended-behavior solid (27/27, 18/18,
  9/9, 9/9). 4 task-breaking gates (krea2, zai-mcp, inspect, movie) are
  recoverable via `enable_tool({name})` → non-gating by default.
- **`--strict`: FAIL** — 4 task-breaking gates open. **False-fires excluded**
  (6 benign false-fires never gate, per the grilling decision).

### Thresholds (the bar, now in qa/run.ts)
- savings floor: ≥15% AND ≥2,000 tok.
- default pass = floor ∧ L1-intended ∧ savings-sane.
- strict pass = default ∧ zero task-breaking gates.
- false-fires: never gate.

### Recommendation: KEEP + scoped follow-up (out of this effort's scope)
1. Correct README/banner claim (~5.5k, not ~8.5k).
2. Fix the 4 task-breaking blind/misroute gates (krea2, zai-mcp, inspect,
   movie→workflow): add keywords/`requires` so intent-mode reaches them.
3. Fix the high-severity inspect false-fire ("inspect element").
4. Fix dead keyword (workflow `fan.out` → `fan-out`).
5. Resolve the storyboard overlap (ltx vs movie).

### Honesty caveats
- **Live usage not measured** (no model in this env). Reachability is
  deterministic; live is armed (`bun run qa --l2 --model X`). If live later
  shows agents fail to reach the 4 gates even by name, the verdict hardens.
- N=3 flake budget is a prototype default — not statistically rigorous.

**Asset:** `qa/run.ts` (`SAVINGS_FLOOR`, strict=taskBreakingGates),
`qa/evaluate.ts` (`taskBreakingGates`).
