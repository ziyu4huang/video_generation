# Spec — self-arc-13 base-tech benchmark (four lanes × shared cases vs the DEPLOYED s2-agent.sh)

Status: planning · Owner: self-arc-13 · Map: `map.md` (Decisions D1–D10 bind this spec)

## 1. Goal / Non-goals

**Goal**: a committed benchmark suite that runs four candidate driver technologies
against the deployed launcher and produces a generated, evidence-backed recommendation
for which one should drive the self-develop arc.

**Non-goals**: changing the production harness (tui-drive.ts) — evaluation only; a losing
incumbent yields a migration successor goal (D7). No extension-entry / tool-description
changes (schema-cost +0 by construction). No committed receipts (`output/` is scratch).

## 2. Candidates (lane definitions)

| Lane | Mechanism | pty owner | Evidence source |
|---|---|---|---|
| `bun-terminal` | `Bun.spawn([sh], { terminal: { cols, rows, data } })` (incumbent) | Bun terminal API | xterm-headless render |
| `bun-pty` | `Bun.spawn(["script","-q","/dev/null",sh])`, plain stdio pipes (D1) | `script(1)` | xterm-headless render |
| `tmux` | `tmux new-session -d -x <cols> -y <rows>` + `send-keys -l` + `capture-pane -p [-e]` | tmux server | capture frames (→ optional xterm feed) |
| `rpc` | spawn `<sh> --mode rpc`, JSONL on stdin/stdout | none (no tty) | protocol responses + event stream |

All lanes: scratch cwd with seeded files + `.pi/agents/hard-problem.md` (glm-5.3),
ZAI_API_KEY injected (D5), fixed 120×40 geometry, `TERM=xterm-256color` where a tty exists.

## 3. Shared case catalog

Cases are evidence predicates (D2); every lane uses the SAME stimulus text per sweep
(shared nonce → byte-identical prompts across lanes; unique per rep/sweep to defeat caching).

| id | stimulus | PASS — screen lanes | PASS — rpc | metric | cap |
|---|---|---|---|---|---|
| `boot-to-ready` | spawn launcher | banner/composer rendered (rendered-truth boot gate, arc-12 #2208) | process up + first `get_state` success (or ready event) | spawn→ready ms | 120 s |
| `trivial-ask` | "Reply with exactly `BENCHPONG-<nonce>` and nothing else." | sentinel rendered AND live markers absent (D4) | turn completion + `get_last_assistant_text` contains sentinel | submit→settled ms | 180 s |
| `subagent-dispatch` | prompt main agent to dispatch the seeded `hard-problem` agentType on a task ending in a marker | dispatch marker + completion notification rendered | dispatch accepted + completion notification event OR `get_entries` delta (else N/A w/ evidence, D8) | submit→notification ms | 300 s |
| `state-probe` | (no stimulus) | status-bar model line shows glm-5.3, flash absent BY NAME | `get_state` model field glm-5.3, flash absent BY NAME | n/a (capability probe) | 60 s |
| `tui-gesture` | open `/subagents` viewer | viewer chrome rendered | **expected-unreachable** — record ✗ + evidence (D8) | open→rendered ms (screen lanes) | 60 s |
| `robustness-3x` | trivial-ask ×3 sequential, one session | 3× PASS per D4 | 3× PASS | success n/3 + ms spread | 3×180 s |

## 4. Adapter interface

```ts
type TechId = "bun-terminal" | "bun-pty" | "tmux" | "rpc";
interface LaunchCtx { sh: string; cwd: string; env: Record<string,string>; cols: number; rows: number; }
interface BenchAdapter {
  id: TechId;
  evidenceLanes: { renderedTruth: boolean; structured: boolean; dialogs: "keystroke"|"protocol"|"none"; asyncEvents: "screen"|"stream"|"none" };
  launch(ctx: LaunchCtx): Promise<Session>;
}
interface Session {
  submit(text: string): Promise<void>;                  // paced per learning 3
  awaitSettled(deadlineMs: number): Promise<SettleResult>; // semantics per lane, D4
  screenText?(): string | null;                         // rendered-truth lanes only
  stateProbe?(): Promise<StateInfo | null>;             // rpc only
  gesture?(name: string): Promise<GestureResult | null>;// rendered-truth lanes only
  close(): Promise<void>;
}
```

The driver owns: case sequencing, nonces, timeouts, receipt writing, comparison/scoring.
Adapters own: process lifecycle + lane-native evidence only.

## 5. Settle & pacing semantics (D4, learning 3/5)

- Screen lanes: settle = answer-latch present AND live-marker regex absent; poll cadence
  ~150 ms; NEVER treat transcript text as a settle signal. tmux adds the
  two-consecutive-stable-captures (≥300 ms apart) condition.
- Submit pacing: real wall-clock sleeps between keys (a freshly-mounted dialog eats the
  first keypress); verified-submit (deployed host eats the first Enter sent pre-render).
- rpc: settle = response envelope `{success:true}` for the command AND turn-completion
  event observed on the stream (exact event name pinned by t03 fixtures).
- xterm-headless feeds: 64-byte AWAITED chunks in every lane that feeds it (bun-terminal,
  bun-pty, tmux `-e` variant).

## 6. Fairness protocol

One sweep = all four lanes, sequential, same deployed `--sh`, same nonce (byte-identical
stimuli), fixed geometry, cooldown ≥10 s between lanes. Robustness reps share the sweep
nonce + `-r<i>` suffix. Latency reported raw AND p50-of-3; scoring uses p50. LLM variance
is why latency carries only 0.15 weight (D7).

## 7. Receipt schema (per tech per case)

`output/bench13-<tech>-<sweepTs>/case-<id>/receipt.json` (+ `snap-NN.txt` where a screen
exists — never committed):

```json
{
  "tech": "bun-terminal", "case": "trivial-ask", "nonce": "s1738-r1",
  "pass": true,
  "timingsMs": { "launch": 0, "ready": 8431, "submitted": 9100, "settled": 21455 },
  "evidence": { "kind": "rendered", "sentinel": "BENCHPONG-s1738-r1", "liveMarkersAbsent": true },
  "env": { "sh": "/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current/s2-agent.sh",
           "shVersion": "0.10.0+g80419f1", "bun": "1.4.2", "term": "xterm-256color",
           "model": "zai/glm-5.3", "extraProcs": ["tmux 3.7c"] },
  "notes": []
}
```

`tui-gesture` under rpc writes `pass: null` + `verdict: "unreachable"` (D8).

## 8. Scoring & decision rule (pre-registered, D7)

1. **Eligibility**: robustness 3/3 AND no adapter-crash (a lane that cannot run a case it
   is structurally capable of is ineligible, not scored).
2. **Numeric score** (0–1 each, rubric below), per lane over criteria it is structurally
   capable of; denominators reported in comparison.json:
   - evidence-fidelity 0.30 — does the lane's evidence equal what a human sees / what the
     protocol guarantees? (rendered truth: full marks; rpc structured: full marks on its
     own terms; screen-scrape-only tmux text mode: partial)
   - robustness 0.30 — robustness-3× success + boot stability across the whole sweep
   - async-visibility 0.15 — subagent-dispatch evidence quality (notification rendered vs
     structured event vs none)
   - latency 0.15 — p50 trivial-ask + boot, normalized to the sweep's best lane
   - simplicity 0.10 — generated adapter LOC (wc -l, recorded by the driver) + moving
     parts (external procs, escape handling) from `evidenceLanes` + adapter descriptor
3. **Role rule**: the production-harness recommendation is drawn ONLY from lanes with
   rendered-truth capability (bun-terminal, bun-pty, tmux) — today's loop receipts are
   rendered truth. rpc receives a **structured-complement** verdict (recovery passes,
   structured probes — learning 6's fresh-process twin) unless NO screen lane is eligible.
4. **Incumbent margin**: a challenger needs >10% score margin over bun-terminal; ties keep
   the incumbent (switching cost only pays on a clear win).
5. Outcome recorded as a map Decision with the generated numbers; a losing incumbent ⇒
   migration successor goal (out of arc).

## 9. Capability matrix (generated rows in comparison.md)

Rendered-truth fidelity · dialog/UI interactivity (keystroke vs protocol vs none) ·
structured-data access · async-event visibility · TUI-surface reach (/subagents viewer,
task panel, wf badges — rpc ✗ documented) · deploy-compat (flags-only, read-only tree) ·
external deps (none / script(1) / tmux 3.7c) · adapter LOC.

## 10. Artifacts & layout

```
bun-apps/s2-agent-ext-subagent/
  scripts/bench-base-tech/bench.ts        # runnable entry (allowlisted, D10)
  <exempt-lib-path>/bench-base-tech/      # cases.ts, adapters/{bun-terminal,bun-pty,tmux,rpc}.ts,
                                          # screen.ts, receipt.ts, compare.ts, env.ts  (t01 pins path)
  tests/bench-base-tech.test.ts           # pure-fn tests: registry, scoring, compare, rpc parser,
                                          # tmux settle, script arg builder, key parse
.planning/2026-09-06-self-arc-13/results/ # GENERATED comparison.{json,md} committed at t04
output/bench13-*/                         # receipts + snaps (scratch, never committed)
```

Driver CLI: `bun …/bench.ts --tech <id> --sh <deployed> --out DIR [--case <id>] [--nonce S]`
and `--all --sh <deployed> --out DIR [--skip <id>]` → runs lanes sequentially, writes
`comparison.json` + `comparison.md`. `--all` requires `--sh` (matrix runs are
deployed-only by construction; single-lane debug runs may target the source tree, receipt
records which).

## 11. Constraints & gates

- Deployed tree read-only: adapters spawn the launcher with flags only (D9).
- Children/main = zai/glm-5.3, never flash, BY-NAME exclusion (D5).
- ONE implementation PR (t01–t04, including generated `results/`); docs close-out PR (t05).
- Gates: ext-subagent `bun run check && bun run typecheck && bun test` (canonical `test`
  includes build); devops `bun run check && bun test` (allowlist line). schema-cost +0.
- No LLM calls inside unit tests — live lanes run only via explicit bench invocations.

## 12. Risks → mitigations

- rpc shapes differ from upstream recon → t03 discovery-first, fixtures before logic.
- tmux churn false-settle → D4 stability condition; snaps kept as evidence.
- script(1) unusable → D1 arbitration: lane N/A with evidence, recommendation proceeds 3-lane.
- LLM latency noise → shared nonces, p50-of-3, 0.15 weight, raw ms always published.
- Bench drift from harness rules → adapters must satisfy the same pins as
  tui-drive-hardening.test.ts; t01 ports the pin test expectations where applicable.
