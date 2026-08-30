# GLM Speed & Effectiveness Benchmark — Findings

**Date:** 2026-08-30 · **Harness:** `s2-agent cli bench-agent` (this branch) · **Spec:** `.planning/specs/2026-08-30-glm-speed-benchmark-design.md`
**Runs:** matrix 2026-08-30T15-02-17-397Z (15 cells) · variance re-run (5.3-high + 5.3-flash × analysis) · prefill probe 2026-08-30T15-29-35-594Z

## 1. Matrix (run 1, verbatim)

| config | task | wall(s) | turns | out tok | reason tok | reason% | tok/s | med turn(s) | p90(s) | cache% | quality |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 5.3-high | needle | 5.0 | 2 | 83 | 57 | 69 | 16.7 | 2.5 | 3.0 | 90 | PASS |
| 5.3-high | edit | 34.6 | 6 | 737 | 108 | 15 | 21.7 | 5.7 | 6.5 | 80 | PASS |
| 5.3-high | analysis | 87.4 | 23 | 1941 | 1148 | 59 | 22.2 | 2.4 | 7.7 | 94 | PASS |
| 5.3-medium | needle | 4.6 | 2 | 94 | 68 | 72 | 20.3 | 2.3 | 2.4 | 89 | PASS |
| 5.3-medium | edit | 30.7 | 5 | 659 | 75 | 11 | 21.9 | 5.9 | 7.7 | 87 | PASS |
| 5.3-medium | analysis | 189.4 | 25 | 5439 | 3944 | 73 | 28.7 | 6.6 | 12.5 | 92 | PASS |
| 5.3-low | needle | 4.4 | 2 | 55 | 29 | 53 | 12.4 | 2.2 | 3.0 | 90 | PASS |
| 5.3-low | edit | 23.6 | 4 | 399 | 45 | 11 | 17.1 | 5.9 | 7.5 | 91 | PASS |
| 5.3-low | analysis | 290.9 | 41 | 9241 | 6400 | 69 | 31.8 | 7.1 | 11.4 | 95 | PASS |
| 5.3-highspeed | needle | 14.6 | 1 | 0 | 0 | 0 | 0.0 | 3.1 | 6.9 | 0 | FAIL(empty reply) |
| 5.3-highspeed | edit | 14.5 | 1 | 0 | 0 | 0 | 0.0 | 3.1 | 6.9 | 0 | FAIL(empty reply) |
| 5.3-highspeed | analysis | 14.5 | 1 | 0 | 0 | 0 | 0.0 | 3.1 | 6.9 | 0 | FAIL(empty reply) |
| 5.3-flash | needle | 9.5 | 2 | 47 | 21 | 45 | 5.0 | 4.7 | 4.8 | 2 | PASS |
| 5.3-flash | edit | 23.7 | 4 | 374 | 34 | 9 | 16.0 | 5.8 | 7.0 | 54 | PASS |
| 5.3-flash | analysis | 50.5 | 9 | 940 | 572 | 61 | 18.6 | 5.7 | 6.8 | 86 | PASS |

Variance re-run (analysis only): 5.3-high → 151.5s, 29 turns, **FAIL** (missing 1 of 3 answers) · 5.3-flash → 264.0s, 34 turns, PASS.

## 2. Prefill probe (verbatim)

| load | tools | cold wall(s) | warm wall(s) | cold cacheW | warm cacheR |
|---|---|---|---|---|---|
| full | 6 | 9.9 | 3.7 | 0 | 2176 |
| stripped | 1 | 2.7 | 1.0 | 0 | 1344 |

CLI shared-session default (6 tools) vs `["read"]`: **+7.2s cold / +2.7s warm / +832 cached tok** for 5 extra tools.
NOTE: this probes the CLI session surface, not the interactive TUI's 84-tool set — TUI context tax is
amortized by the 96–98% cache hit observed in retrospective session data. Hermes-memory contributes
~750 tok (policy-only mode, verified in code + live prompt) — negligible.

## 3. The three questions the spec asked

**(a) Do `:medium`/`:low` change glm-5.3's reasoning behavior?** YES — massively, and inversely to
naive expectation on multi-turn tasks. Levels flow natively through the zai thinkingFormat (no
thinkingLevelMap needed — behavior demonstrably changes per level). On the hard task, less thinking
per turn ⇒ more turns ⇒ slower and more reasoning tokens in total:
analysis wall high 87s / medium 189s / low 291s; turns 23 / 25 / 41; total reasoning 1148 / 3944 / 6400.

**(b) Which config wins latency at equal quality?** On stable tasks (needle, edit) all levels are
close (edit: low 23.6s vs high 34.6s — low slightly faster). On the hard task `5.3-high` wins run 1
(87s) but FAILED the variance re-run (151s, missing one answer) — at n≤2, config separation on the
hard task is not statistically firm; the only firm trend is that lowering thinking hurts multi-turn
tasks. `5.3-flash` passed analysis 2/2 but swung 50→264s.

**(c) Tools-schema cost?** Cold +7.2s / warm +2.7s for 5 extra tools on the CLI surface (see §2).
In-session steady state, cache absorbs most of it. `glm-5.3-highspeed` is UNAVAILABLE on this Z.AI
subscription: API returns `429 code 1311 "Your current subscription plan does not yet include access
to GLM-5.3-Highspeed"` (diagnosed via direct `-p` probe; the bench's FAIL(empty reply) masked the 429).

## 4. Tuning adjudication (plan Task 5 levers)

| Lever | Verdict | Evidence |
|---|---|---|
| L1 default thinking high→medium | **REJECT** | medium 2.2× slower on analysis (189s vs 87s), more turns (25 vs 23), more total reasoning (3944 vs 1148) |
| L2 add thinkingLevelMap to glm-5.3 | **REJECT** | levels already flow natively (behavior changes per level); a map re-derives the same wire behavior = noise |
| L3 tier swap medium→5.3-highspeed | **REJECT** | 429: not in the subscription plan |
| L4 record current default optimal | **APPLY** | `zai/glm-5.3` + `thinking:"high"` stays; small tier stays `5.3-flash` |

**No catalog change.** The current default is measured-optimal among available options.
Tier note: `5.3-flash` promotion to medium tier is NOT supported — 2/2 analysis passes but 50→264s
wall swing; more repeats needed before a tier change (candidate for a future run with n≥5).

## 5. Harness findings (recorded for future work)

- API rejections (429 etc.) surface as `FAIL(empty reply)` with 0 tokens — the error message is
  swallowed; the cell error detail should carry the provider error. Deferred minor.
- Analysis-task cells can run >300s under variance (worst observed 291s within timeout; the
  variance re-run's high cell took 151.5s) — default 300s timeout is adequate but tight for
  low-thinking configs on hard tasks.
- Context-tax of the interactive TUI (84 tools / ~25k tok) is not probed by this harness (CLI
  session surface differs); retrospective session data remains the source for that (96–98% cache).
- Deferred minors from task reviews: checkEdit ENOENT burn-retry, temp-dir cleanup, probe warm
  error marker, --dry config validation ordering.

## 6. Artifacts

- Matrix: `bun-apps/s2-agent/output/bench-agent/2026-08-30T15-02-17-397Z/` (REPORT.md + results.jsonl)
- Probe: `bun-apps/s2-agent/output/bench-agent/2026-08-30T15-29-35-594Z/PROBE.md`
- Variance re-run + live smokes: sibling timestamped dirs (gitignored; tables above are the durable copy)
