# Base-tech benchmark comparison (self-arc-13)

## Per-case outcomes

| case | bun-terminal | bun-pty | tmux | rpc |
|---|---|---|---|---
| trivial-ask | ✅ 152ms | N/A | ✅ 942ms | ✅ 4684ms |
| boot-to-ready | ✅ | N/A | ✅ | ✅ |
| tui-gesture | ✅ 152ms | N/A | ✅ 1245ms | N/A |
| state-probe | ✅ | N/A | ✅ | ✅ |
| robustness-3x | ✅ | N/A | ✅ | ✅ |
| subagent-dispatch | ✅ 151ms | N/A | ✅ 7434ms | ✅ 12234ms |

## Scores (eligible lanes only)

| tech | total | fidelity | robustness | async | latency | simplicity |
|---|---|---|---|---|---|---|
| bun-terminal | 0.834 | 1.00 | 1.00 | 0.50 | 0.40 | 1.00 |
| bun-pty | INELIGIBLE (robustness 0/3) | — | — | — | — | — |
| tmux | 0.719 | 0.80 | 1.00 | 0.50 | 0.12 | 0.87 |
| rpc | 0.847 | 1.00 | 1.00 | 1.00 | 0.04 | 0.92 |

## Capability matrix

| tech | rendered truth | dialogs | async events | external deps | adapter LOC |
|---|---|---|---|---|---|
| bun-terminal | yes | keystroke | screen | none | 100 |
| bun-pty | yes | keystroke | screen | script(1) | 121 |
| tmux | yes | keystroke | screen | tmux 3.7c | 104 |
| rpc | no (structured) | protocol | stream | none | 156 |

## Recommendation

- **Production lane: bun-terminal**
- Structured complement: rpc
- incumbent bun-terminal leads (or ties) among eligible rendered-truth lanes

