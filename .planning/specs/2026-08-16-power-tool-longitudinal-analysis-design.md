# power-tool longitudinal analysis — design

Date: 2026-08-16
Scope: `bun-apps/pi-agent-ext-power-tool`
Precondition: **spec step 2c must land first** (see
`.planning/specs/2026-08-15-core-packages-simplification-design.md`) — this design
builds on the transcript scanner that 2c relocates into power-tool.

## Goal

Give power-tool a memory. Today every diagnostic it produces is destroyed at session
end, so the two questions the owner actually wants answered cannot be answered at
all:

1. **Agent behaviour pathology trend** — is the retry-loop / error-storm /
   context-saturation rate going up or down over time and across releases?
2. **Tool health regression** — is any tool's error rate or p95 latency degrading?

## Measured starting state

| Layer | Artifact | Lifetime | Long-term analysis |
|---|---|---|---|
| Live detection | `src/pathology/accumulator.ts` — 500-call ring buffer, per-`sessionId` bucket | cleared on `session_start`; memory only | ✗ evaporates |
| Live output | status-line warning + `inspect_pathology` | rendered, never stored | ✗ no pathology has ever been recorded |
| Raw substrate | `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl` | **already permanent** — 478 project dirs | ✓ but written by pi core, not power-tool |
| Offline aggregate | `tools-metrics` (615 lines, in `pi-agent`, relocating via 2c) | recomputed per invocation, never stored | ~ cross-session, but ad-hoc query only |
| Cost | `bun-apps/pi-agent/baselines/schema-cost-baseline.json` | one snapshot + canary | ~ a single point, not a series |

The gap is not missing data. It is the **absence of a time series**.

## Findings that shaped the design

Verified against real transcripts and the live worktree set on 2026-08-16.

1. **Transcripts already contain everything the four detectors need.** Confirmed
   present: `toolCall.arguments` (→ `argsSig` reconstructible → retry-loop),
   `toolResult.isError` (→ error storm), per-assistant-message
   `usage.totalTokens` (→ context saturation), assistant message count (→ turn
   count). No detector is starved of input.

2. **`analyzePathology()` is already decoupled from the accumulator.** It is a pure
   function over `PathologyInput` (`src/pathology/types.ts:27`). The seam that
   historical replay needs **already exists** — only a `SessionScan → PathologyInput`
   adapter is missing. The detectors themselves are not modified by this work.

3. **`tools-metrics` already owns a transcript scanner**, and 2c already moves it
   into power-tool. Building a second parser here would be the wrong shape: one
   reader, two consumers (tool health + pathology replay). The existing scanner
   reads only `{type, name, id}` and must be widened to also carry `arguments` and
   `usage`.

4. **Two incompatible cwd encodings coexist** in `~/.pi/agent/sessions/`:
   `--Users-huangziyu-proj-video_generation__memory--` preserves underscores,
   `-Users-huangziyu-proj-video-generation--embed` converts them to dashes —
   evidently different encoder versions. Decoding directory names would silently
   drop data at the version boundary. The `session` event carries an authoritative
   `cwd` field; **group by that, never by directory name**.

5. **`git worktree list` is not a sufficient scope filter.** `video_generation__archify`
   has 4 session directories of history but is no longer a live worktree. Deleted
   worktrees are precisely the *finished* efforts — excluding them discards the most
   conclusive data. Conversely one live worktree (`/private/tmp/precheck-rename`)
   sits outside the repo family prefix, so the prefix alone is not sufficient either.

6. **Subdirectories get their own session directory** (`…__archify-bun-apps-pi-agent--`).
   Scope matching must be prefix-based, not exact-match. 66 of the 478 directories
   belong to this repo family.

7. **Deterministic commands still have no `ExtensionSubcommandSpec` contract**
   (finding #4 of the 2026-08-15 spec). The new command is hand-written under
   `commands/`, alongside the `tools-metrics` that 2c brings in.

## Approach — derive-first hybrid

Rejected alternatives:

- **Pure runtime emitter** (write a pathology summary at session end). History resets
  to zero, and any threshold change makes previously written records semantically
  incomparable *and* unrecomputable. The detector thresholds are still being tuned,
  so this fails on the axis that matters most.
- **Pure offline replay.** Recomputable and retroactive, but cannot say *which
  version was running* — which is exactly what turns a trend into a conclusion, and
  the owner's first-priority question is framed per-release.

Chosen: **replay as the backbone, plus a minimal sidecar carrying only what
transcripts cannot reconstruct.** Derived numbers are never stored — always
recomputed — so a threshold change re-derives the entire history consistently.

```
~/.pi/agent/sessions/**/*.jsonl        (existing, unmined)
        │
        ▼  scan.ts          — the one transcript reader (from 2c)
   SessionScan { cwd, startedAt, calls[], results[], usage[] }
        │
        ▼  replay.ts        — pure
   PathologyInput → analyzePathology() → per-session findings
        │
        ▼  join on sessionId
   sidecar.jsonl            (new, minimal — environment facts only)
        │
        ▼  aggregate.ts     — pure
   time series · regression verdicts
```

### Modules

```
src/history/
  scan.ts       ← the tools-metrics scanner, widened; sole transcript reader
  replay.ts     ← SessionScan → PathologyInput → analyzePathology()   (pure)
  scope.ts      ← repo-family + worktree scope resolution              (pure)
  sidecar.ts    ← session_start environment fingerprint (only new write path)
  aggregate.ts  ← per-session results + fingerprints → series + regressions (pure)
```

**No cache module.** The design originally called for one; a measured full scan
of the family corpus (3,391 files / 491 MB) completes in **1.0 s**, and a full
detector replay over it in **0.94 s**. A cache would add invalidation surface to
save a second. Dropped.

`replay.ts` and `aggregate.ts` are pure functions over already-parsed inputs,
matching the package's established shape (`analyzePathology`, `computeMetrics`) so
the logic is unit-testable with fixture data and zero filesystem access.

### Data contracts

**`argsSig` must be imported from `src/pathology/detector.ts`**, the same export the
accumulator uses (`accumulator.ts:22`). Reimplementing it would let live detection
and historical replay disagree about what "the same call" means, and the divergence
would be invisible.

**Sidecar record** — written at `session_start`, one line, environment facts only:

```jsonc
{ "sessionId": "...", "ts": "...", "cwd": "...",
  "gitSha": "...", "piVersion": "...", "toolFingerprint": "<hash>", "toolCount": 30 }
```

No derived metric ever enters this file. Location:
`~/.pi/agent/power-tool/env.jsonl`, append-only; lines stay small so `O_APPEND`
writes remain atomic.

**Written at `session_start`, not `session_shutdown`.** Shutdown does not fire on a
crash or `kill -9`, and long sessions that die are among the most diagnostic ones.
Everything needed is already known at start. The write is fire-and-forget inside
`try/catch` and fails silently: **a diagnostic tool must never break the session it
is diagnosing.**

### Scope resolution

> in scope = session `cwd` under the repo family prefix
> (`/Users/huangziyu/proj/video_generation*`) **∪** any root from `git worktree list`

The prefix half recovers deleted worktrees and all subdirectories (finding 5, 6);
the worktree-list half recovers live worktrees outside the family prefix. Matching
uses the transcript's `cwd` field (finding 4). The family prefix is derived from the
repo's main worktree path, not hardcoded.

### Metric definitions

**Pathology trend uses occurrence rate** — sessions in which a pathology fired ÷
sessions in the bucket — **not raw counts**. Session lengths vary by an order of
magnitude; a count-based series is dominated by a handful of long sessions, so a
busy week reads as a regression when nothing degraded.

**The denominator is sessions with ≥ 1 tool call, not all sessions.** Measured:
only 1,165 of 3,391 family sessions contain any tool call. The other 2,226 cannot
trigger any detector, so including them dilutes every rate by ~3× and makes the
series track "how many one-shot prompts did I run" instead of agent behaviour.

**Tool health** reuses `tools-metrics`' existing per-tool error rate and p50/p95/max
latency, bucketed over the same windows.

### Regression rule — calibrated against the real corpus

Compare the most recent window of N sessions against the preceding window of N:
flag a regression when the occurrence rate moves by ≥ X percentage points **and**
the baseline window contains ≥ `minEvents` actual occurrences of that pathology.

**No p-values.** `CONTEXT.md` defines a pathology detector as deterministic and
signal-driven, explicitly _Avoid: heuristic_. A significance test here would
manufacture an appearance of rigour over a sample that is neither independent nor
identically distributed.

Measured base rates over 1,165 tool-using sessions spanning 49 days (~24/day):

| pathology | rate | events | expected per 200-session window |
|---|---:|---:|---:|
| long-session-recall-risk | 37.0% | 431 | ~74 |
| consecutive-error | 5.7% | 66 | ~11 |
| error-storm | 1.8% | 21 | ~3.6 |
| retry-loop | 0.9% | 10 | ~1.8 |
| context-saturation | 0% | 0 | 0 |

Chosen: `N = 200` sessions (≈ 8 days at the observed rate), `X = 10` percentage
points, `minEvents = 10`.

**The `minEvents` guard is the important part.** At this data volume only
`long-session-recall-risk` and `consecutive-error` clear it. `error-storm` and
`retry-loop` must therefore report a raw count series plus an explicit
**"insufficient signal for regression detection"** label — never a verdict. Emitting
a confident up/down call on 1.8 expected events would be noise dressed as a finding.

### Honest limitations — must surface in the report, not be papered over

1. **`contextPercent` is resolvable for 84.3% of sessions, and the saturation
   detector has never fired.** Every session carries a `model_change` event with
   `{provider, modelId}`, and `~/.pi/agent/models-store.json` carries
   `contextWindow` per model — 2,858 of 3,391 sessions resolve. The 533 that do not
   are all local `lm-studio` models absent from the store (`gemma-4-26b-a4b-qat`
   ×434 leads). Where the window is unresolvable, emit `null` and label the bucket
   **"unmeasurable"** — never `0`.

   More decisively: across the 2,840 measurable sessions the **highest context fill
   ever observed is 56.2%**, and 97.5% never exceed 25%. Against the 85% threshold
   the saturation series is a permanent zero line. **Context-saturation is therefore
   excluded from the trend views** and reported once as a static fact. Building a
   view over a metric that has never fired in 49 days of history is waste; if the
   85% threshold is itself miscalibrated for this workload, that is a separate
   question for the detector, not for this analyzer.

2. **`turnCount` is an approximation.** The accumulator counts `turn_end` events;
   transcripts have none, so assistant message count is the proxy. This must be
   stated in both the code comment and a report footnote.

3. **The sidecar creates an intentional asymmetry.** History predating rollout has a
   time axis but no `gitSha` axis. The report must draw the sidecar activation date,
   or the reader will infer that no version changed before it.

4. **In-process subagents.** The accumulator partitions by `SessionManager` UUIDv7;
   transcript-derived session identity may group parent and child differently. Any
   divergence is documented rather than silently reconciled.

### Prototype validation (2026-08-16, before any production code)

The mechanism was proven end-to-end against the real corpus by importing the
actual `argsSig` + `analyzePathology` from `src/pathology/detector.ts` and
replaying 3,391 historical transcripts. It ran in **940 ms** and produced real
signal — the base-rate table above is its output, and the top offenders were
`consecutive-error:bash` (35), `consecutive-error:edit` (16),
`consecutive-error:movie` (10), `error-storm:movie` (8), `retry-loop:movie` (5).

Three design claims were corrected by that run and are already folded into this
document: the cache is unnecessary, the denominator must exclude tool-less
sessions, and context-saturation carries no signal.

### CLI

`pi agent-trends [--view pathology|tools] [--since <date>] [--json]` — one scan,
two views. Hand-written under `commands/` (finding 7), beside the relocated
`tools-metrics`.

### Privacy

The analyzer reads full session transcripts, which contain everything typed into
every session. Everything stays local — no upload, no network egress. Reports print
`argsSig` (already bounded and normalized), never raw arguments.

## Non-goals

- No dashboard or web UI. Terminal + `--json`.
- No statistical significance testing (see regression rule).
- No cross-machine aggregation.
- No change to the detectors themselves, or to live/status-line behaviour.
- No change to `schema-cost` — cost trending was deprioritized by the owner.

## Testing

- `replay.ts` and `aggregate.ts`: pure-function unit tests over fixture transcripts,
  matching the existing `pathology/__tests__` layout.
- Scope resolution: table-driven, covering both cwd encodings, a deleted worktree,
  a subdirectory, and an out-of-prefix live worktree.
- Sidecar: verify a write failure is swallowed and never propagates into
  `session_start`.
- A parity check that replaying a synthetic transcript reproduces the findings the
  live accumulator produces from the same call sequence.
