---
id: t01
effort: 2026-09-06-self-arc-13
status: open
phase: 1 — build
estimate: M
depends: none
---

# t01 — driver skeleton + shared case registry + bun-terminal control adapter

## Goal

The bench's spine: driver CLI, case registry with evidence predicates, receipt schema,
comparison/scoring generator, and the incumbent lane (bun-terminal) proven green against
the DEPLOYED launcher on `boot-to-ready` + `trivial-ask`. This arm is the CONTROL — a
known-good lane (10/10 sweep, arc-12) that validates the abstraction before new tech wires in.

## Scope

- `scripts/bench-base-tech/bench.ts` — runnable entry (spec §10 CLI): `--tech`, `--sh`,
  `--out`, `--case`, `--nonce`, `--all`, `--skip`.
- Library path: FIRST verify the scripts-dir-contract exemption matcher
  (`bun-apps/s2-agent-ext-devops/tests/scripts-dir-contract.test.ts` header says
  `scripts/lib/` subtree + `*.test.*`), then place `cases.ts`, `receipt.ts`, `compare.ts`,
  `env.ts`, `screen.ts`, `adapters/bun-terminal.ts` under the matching exempt path
  (D10). Pin the choice in the adapter header comment.
- `cases.ts` — the 6-case registry (spec §3) as data + predicate functions; every case
  carries its per-lane PASS predicate and cap.
- `screen.ts` — MINIMAL PORT from tui-drive.ts (D3: port/reimplement, never import —
  importing a side-effectful script RUNS it): xterm-headless UMD shim load, 64-byte
  awaited feeder, DA responder (`\x1b[c` → `\x1b[?1;2c`, kitty `\x1b[?u` silence),
  TERM=xterm-256color forcing, live-marker regexes, latch engine, paced/verified submit.
- `env.ts` — ZAI_API_KEY parse from ~/.zshrc when not exported; scratch cwd seeding
  (sample files + `.pi/agents/hard-problem.md` bound to zai/glm-5.3).
- `compare.ts` — scoring (spec §8) + comparison table renderer; PURE functions.
- Allowlist: add `bun-apps/s2-agent-ext-subagent/scripts/bench-base-tech/bench.ts` to
  `ALLOWED_RUNNABLE_ENTRIES` in the devops contract test.
- `tests/bench-base-tech.test.ts` — no-LLM unit tests: case-registry schema, scoring
  golden case, comparison-renderer golden, nonce/key parsing, 64B feeder chunking, DA
  responder byte contract (mirror tui-drive-hardening pins where they apply).

## Done-when

- `bun bun-apps/s2-agent-ext-subagent/scripts/bench-base-tech/bench.ts --tech bun-terminal
  --sh /Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current/s2-agent.sh --case boot
  --out <dir>` → receipt PASS, and same for `--case trivial-ask` (deployed receipts under
  `output/`, recording sh path + version + model line glm-5.3, flash absent BY NAME).
- Gates green: ext-subagent `bun run check && bun run typecheck && bun test`; devops
  `bun run check && bun test`. schema-cost +0 (scripts/tests only).
- No production file touched; tui-drive.ts byte-identical.

## Out-of-scope

subagent-dispatch/state-probe/tui-gesture cases for this lane (implemented in the
registry now, exercised from t04), all other adapters.
