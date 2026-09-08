# t01 — complex case registry + adapters' new evidence needs

Parent: `.planning/2026-09-06-self-arc-15/map.md` (D1, D2, D3, D4, D5, D7).
Package: `bun-apps/s2-agent-ext-subagent`. All code lands in the ONE
implementation PR (D8).

## Goal

A step-scripted complex case suite the driver can run with `--suite complex`,
with lane adapters extended to produce the evidence the four cases need —
without touching the base `CASES` registry or any existing caller's behavior.

## Work items

1. **Step-script types** (`scripts/lib/bench-base-tech/types.ts`):
   - `CaseStep = { kind: "submit" | "abort" | "poll"; text?: string;
     pred?: (v: SettleView, nonce: string, h: StepHelper) => boolean;
     capMs?: number }` — each step gets its own timing + evidence record.
   - `ComplexCaseDef = { id; capMs; steps: CaseStep[]; metric }` in a NEW
     `scripts/lib/bench-base-tech/cases-complex.ts` (base `cases.ts`
     untouched). Export `COMPLEX_CASES` with exactly: `cx-multi-turn`,
     `cx-swarm-abort`, `cx-long-output`, `cx-error-path`, per map D1's
     pre-registered designs (nonce-bearing sentinels `CXK-`, `BSAB-`,
     `BENCLONG-…-END`, error-path wording pinned by item 5's calibration).
   - `RpcCaseHelper` grows DATA-ONLY fields: `entries: unknown` (latest
     get_entries snapshot) and `stepFlags: Record<string, boolean>` (driver-
     recorded facts like abortResponseOk). Predicates stay pure.
2. **Driver** (`scripts/bench-base-tech.ts`): `--suite base|complex|all`
   (default `base`; flag parse at the existing argv block :57–76). Complex
   runs execute steps sequentially against ONE session, writing per-step
   records into `CaseReceipt.timingsMs`/`evidence` (`step<i>Ms`,
   `bytesLatched`, `bytesReceived`, `linesSeen`, abort-visibility fields).
   `--all` keeps base semantics; `--suite complex --all` runs the complex
   matrix.
3. **bun-terminal adapter**: expose abort = `writeRaw("\x1b")` (esc) paced
   per learning 3; add the CUMULATIVE in-loop latch (collect distinct seen
   lines/bytes across poll frames — the F-invalidate answer: rows scroll out,
   final frame alone is untrustworthy) surfaced via a helper the
   `cx-long-output` predicate consumes; conform to the pinned pty rules
   (TERM=xterm-256color, 64-byte awaited feeds, DA answered, kitty silent).
4. **rpc adapter**: wire `abort` and `get_entries` (both already in the
   protocol) into step execution; capture the notification/entries delta
   post-abort and post-child-failure.
5. **Discovery/calibration (cheap, recorded)**: (a) run ONE live
   `cx-error-path` shape against the deployed launcher to pin the
   failing-task wording and capture ≥10 REAL rpc lines showing the error/
   failed-child shapes → append to `adapters/rpc-protocol.fixture.json`;
   (b) grep the DEPLOYED bundle for the `steer` symbol + read the deployed
   TUI keystroke path → record in the receipt whether mid-turn typing is
   plausibly queued (feeds map D5). Both receipts under `output/bench15-calib-*/`
   (scratch; findings land in code + this ticket's completion note).
6. **Unit gates** (extend `tests/bench-base-tech.test.ts`): step-registry
   shape (every step has a kind; every submit has text; caps sane); predicate
   tests over FIXTURE `SettleView`s for all four cases (pass + fail sides);
   `--suite` flag parse; cumulative-latch helper unit test (simulated frames
   where the tail scrolls out — asserts ≥18/20 recovery when frames cover it,
   honest fail when they cannot).

## Constraints

- No production src change → schema-cost +0 by construction (verify the probe
  exits info-only). No new runnable script → NO new allowlist row; VERIFY by
  running `s2-agent-ext-devops` tests (D4) — if a new runnable sneaks in, its
  row ships in this same PR.
- Base suite byte-stable: existing tests untouched and green.
- Model: zai/glm-5.3 only, flash excluded BY NAME; ZAI key from ~/.zshrc
  injected per env.ts precedent.

## Done when

`( cd bun-apps/s2-agent-ext-subagent && bun run check && bun run typecheck && bun test )`
green + `( cd bun-apps/s2-agent-ext-devops && bun test )` green; a scratch
calibration receipt proves one complex case executes end-to-end per lane
against the deployed launcher; error-fixture lines committed; steer-midturn
discovery verdict recorded in the completion note.
