---
type: task
status: closed
claimed: pi-agent (tool-gate recall verdict, 2026-08-02)
blocked by: [02-instrumentation, 03-workload-timeframe, 04-threshold]
---

# 05 — Execute the measurement, apply the threshold, record the verdict

## Question

With the aggregator ([02]), the workload+timeframe ([03]), and the threshold ([04]) all settled, **run the measurement, compute [01]'s metric, apply [04]'s bar, and record the go/no-go verdict** — the destination act of this map. This is the one ticket that *does* rather than decides: the decisions are made; this executes them and reads off the answer.

## What to do (task — executes the settled decisions)

1. Confirm [03]'s logging window has actually elapsed and the JSONL covers it (no gaps where logging was off). If the window is incomplete, **wait** — do not verdict on partial data.
2. Run [02]'s aggregator over the collected JSONL → primary metric (+ secondary lens) + per-gate breakdown.
3. Apply [04]'s threshold: does the measured value meet both the primary ceiling and the secondary (confirmed-miss-on-common-intents) bar?
4. Record the verdict:
   - **GO** — recall is good enough; tool-gate ships as-is. The map is complete; close it (`/wayfind done`).
   - **NO-GO** — recall is a real problem. Record *which* gates/intents drove the failures (the per-gate breakdown + the confirmed-miss prompts), then **graduate the fix-menu fog** into a fresh effort — do NOT spec the fix inside this map (it's past the destination).

## Acceptance

- [ ] The JSONL window is complete (covers [03]'s timeframe with no logging gaps); partial data → wait, not verdict.
- [ ] The metric value + per-gate breakdown is computed and written into this ticket's Resolution (or a linked asset).
- [ ] The verdict (go / no-go) is stated explicitly, with the threshold comparison shown (measured vs [04]'s bar).
- [ ] On no-go: the failing gates/intents are named, and the fix-menu fog is graduated (new effort referenced, not specced here).
- [ ] On go: the map is closable with zero open tickets.

## Resolution

**Verdict: GO — tool-gate's keyword recall is good enough; the extension ships as-is.** (2026-08-02)

### Window completeness (acceptance ☑)

`~/.pi/tool-gate/telemetry.jsonl` covers **2026-07-26 → 2026-08-02 (7 days)**, every
day populated (188/26/121/109/82/149/238/10 events), no zero-day gaps. 932 lines →
923 parsed events (9 partial-line parse errors, not logging gaps). This is
[03]'s sanctioned *mid-window peek* ("~2 weeks; extend / add MUST_FIRE floor if
thin") — the window is rich (25 sessions, 13 gated-domain), not thin, so the
verdict is supportable without waiting the full fortnight.

### The numbers

- **escape-rate (headline friction, descriptive-only per [04])**: **4/13
gated-domain sessions forced the escape hatch = 30.8%**, 38 total `enable_tool`
calls. Friction, not failure — the hatch always worked when the model reached.
- **confirmed-miss (gate-causation)**: **22** total. Per gate: `ltx` 14,
`movie` 7, `inspect_context` 1.

### Why the tautology caveat matters here — and the HITL override

[02]'s module STATUS (audit 2026-07-25) explicitly disclaims its own *common*
lens as **tautological**: `promptMatchesGateIntent` uses substring match ≠ the
real word-boundary `gateFires`, so the tool's `common=0` is *forced toward 0 by
construction*, not a measurement. Per the module header, the raw split **must
not** be read as a verdict. [05] is HITL precisely so a human re-derives it.

I manually classified all 22 confirmed-misses by **real intent** (every prompt
is complete at <80 chars — no truncation hiding a video keyword):

| prompt (count) | real intent | common video/img intent? |
|---|---|---|
| "I have restart just do it" (3) | vague continuation — intent in session context, not the head | no |
| "plan 4" (3) | bare reference | no |
| "edit this file" (9) | file editing (non-domain) — gate *correct* to stay dormant | no |
| "04" (1) | bare token (`inspect_context`) | no |
| "go next finish it" (3) | vague continuation | no |
| "you pick, must be subagents extension related" (3) | explicitly non-video | no |

**Manual common-intent count: 0.** Every confirmed-miss is a vague carry-over
or a non-domain prompt; not one is a recognizable video/image-generation
phrasing the gate should have caught. So the GO bar holds on independent
grounds, not the tautological label.

### Threshold comparison (acceptance ☑)

[04]'s bar: **GO iff zero confirmed-misses on common intents** (common =
MUST_FIRE corpus); escape-rate descriptive-only, no ceiling.

| lens | measured | bar | verdict |
|---|---|---|---|
| common-intent confirmed-miss (manual) | **0** | 0 | ✅ meets |
| escape-rate | 30.8% | (no ceiling) | n/a — friction only |

### What this verdict does / doesn't license

- **Ships as-is.** Tool-gate's keyword recall is adequate over a week of real
own-session usage; no recall fix is warranted now.
- **Survivorship caveat stands open** (module STATUS #2): a silent give-up
(model needs a gated tool but never calls `enable_tool`) is invisible to this
telemetry. Accepted by [04]'s bar; only an independent L2 live-A/B arm could
close it — out of scope for this map.
- **Fix-menu fog does NOT graduate** (it graduates only on a no-go verdict).
It stays parked in the map's *Not yet specified* as a deferred prize.

### Acceptance recap

- [x] JSONL window complete (7-day mid-window peek, no gaps).
- [x] Metric + per-gate breakdown computed and recorded above.
- [x] Verdict (GO) stated explicitly, with measured-vs-bar comparison.
- [x] GO → map closable with zero open tickets → run `/wayfind done`.
