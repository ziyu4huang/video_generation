# Base-tech benchmark v2 — complex variants (self-arc-15)

Lanes: bun-terminal × rpc (arc-13 earned them; bun-pty N/A by arbitration, tmux lost).
Deployed-only; per-case receipts under output/ (scratch).

## Dimension table

| dimension | case | bun-terminal | rpc |
|---|---|---|---|
| continuity (turn-3 recall) | cx-multi-turn | ✅ 6.7s | ✅ 4.5s |
| mid-flight control (abort→quiet→recover) | cx-midturn-abort | ✅ | ✅ · protocol-ack |
| long-output fidelity (cumulative latch vs full text) | cx-long-output | ✅ · 20/20 lines · 6498B | ✅ · 20/20 lines · 470B |
| error visibility (failing bash surfaces) | cx-error-path | ✅ 6.7s | ✅ 5.8s |

## Per-case verdicts

- bun-terminal · cx-multi-turn: pass
- bun-terminal · cx-midturn-abort: pass
- bun-terminal · cx-long-output: pass
- bun-terminal · cx-error-path: pass
- rpc · cx-multi-turn: pass
- rpc · cx-midturn-abort: pass
- rpc · cx-long-output: pass
- rpc · cx-error-path: pass

## Base-suite reference (arc-13, committed)

- bun-terminal 0.834 (production seat) · rpc 0.847 (structured complement) — `.planning/2026-09-06-self-arc-13/results/comparison.md`
- This matrix: 8/8 green.

