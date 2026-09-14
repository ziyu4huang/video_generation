# t02 — deployed verification receipts (self-arc-26)

Date: 2026-09-15 · Model policy: GLM-5.3 on every LLM leg (PB-12); flash excluded by name — no leg requested it; durable run records stamp the actual child model (`mu1nbz9d-orsgio.json` → `zai/glm-5.3` → "ALIVE" = P1's child; `mu1nfkra-0wnwpd.json` → `zai/glm-5.3` → "ANCESTOR-OK" = P2's child). N1 produced NO child (fail-early — that is the pass).

## Deployed truth (PB-08)

- Deploy from branch `self-arc-26-project-trust-wiring` @ `60663aea` (PR #2285 head — identical diff to the PR; main merge deferred, see below) → PINNED dir `~/proj/dist/s2-agent-sh/darwin-arm64/0.10.4+g60663ae/`; deploy e2e verdict `pass`.
- pi-version custody: label `+g60663ae` → this branch → `bun-apps/bun.lock` pins pi 0.85.1 (#2277).

## Pre-drive bundle greps (PB-09) — property names, both bundles

| Target | ext/subagent/ext.cjs | s2-agent.js (core) |
|---|---|---|
| `ProjectTrustStore` | 1 ✅ | 1 ✅ |
| `getAgentDir` | 1 ✅ | 1 ✅ |

(The core-bundle grep is the learning-#1 guard: the ext destructures these from the core-served namespace — a stale core would crash the fresh ext.)

## Legs (pre-registered in the arc-26 map, PB-11; every leg a fresh process; ≤2 attempts, first attempts all green)

**N1 (negative — THE fix proof): PASS.** `t02-N1-evil-deny.log` — cwd `/tmp/arc25-evil/repo` (untrusted, canonical `/private/tmp/...`), `agentType: "evil"` → tool result: `Project-local agentType "evil" is not approved for this project (project is not trusted).` + `File: evil.md` + the trust fix. No child ran (fail-early precedes dispatch). This is the PAIRED POST-FIX receipt to arc-25's PRE-fix `scenario-c2.log` (same fixture, evil then RAN).

**P1 (trusted positive control): PASS.** `t02-P1-hard-problem-runs.log` — cwd = this worktree root (`true` in `~/.pi/agent/trust.json`), real project agentType `hard-problem` → dispatch RAN, child replied `ALIVE`, zero gate text.

**P2 (ancestor-walk control): PASS.** `t02-P2-ancestor-runs.log` — scratch repo `output/arc26-verify/repo` (itself unlisted) UNDER the trusted worktree root, planted project agentType `evil2` → dispatch RAN, child replied `ANCESTOR-OK`, zero gate text. Confirms pi's nearest-ancestor semantics give trusted-root coverage (and re-proves arc-25's scenario-(a) "fixture error" as CORRECT trust semantics, not a bug).

**T1 (TUI confirm stretch): SKIPPED — recorded gap (PB-15).** The confirm-dialog leg needs a tui-drive session; budget went to unblocking the DeepSeek-outage merge instead. The confirm POLICY remains unit-pinned (agent-trust.test.ts, 19 tests incl. dialog text naming `~/.pi/agent/trust.json`).

## External-event note (dated defer, PB-14)

PR #2285's merge is gated by the local-CI deploy-e2e leg `core-tool roundtrip … deepseek flash-vision`, which calls the LIVE DeepSeek API. On 2026-09-15 ~03:00–03:35 CST that provider hung on POST /chat/completions (curl probe: TLS connects, HTTP 401 on bare root instantly, completions 0-bytes-timeout at 25–30s ×2) → the leg timed out at 180s twice (attempt log: `output/ci-logs/pr-2285-20260915-032150|032703`). Two attempts consumed; the blocker is external. Merge retry follows as soon as DeepSeek serves again; t02's legs (zai-only) were unaffected.
