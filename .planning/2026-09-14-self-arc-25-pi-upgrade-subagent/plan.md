# Arc-25 plan — pi upgrade 0.84.4 → 0.85.1 + s2-agent-ext-subagent upstream-parity

Planner deliverable, written 2026-09-14 in this worktree (branch
`self-arc-25-pi-upgrade-subagent` at `6c3c400f`; ledger 25 active). The
canonical wayfinder map — house shape, frontmatter, full ticket bodies, fog of
war, successor sketch — is **`map.md` in this folder** (same content base; this
file is the adjudication cover). Research evidence:
`evidence/local-tarball-diff.md`, `evidence/cc-ext-sources-digest.md`,
`evidence/sdk-changes-digest.md`.

## Gap adjudication (every candidate verified against code this session)

| # | Candidate | Verdict | Key evidence (measured 2026-09-14 unless attributed) |
|---|---|---|---|
| 1 | pi upgrade (P0) | **Real — t01** | 29 package.json files pin exact `0.84.4` (grep, excl. node_modules); imports root-only → client-subpath removal N/A; REMOVED-and-USED = ∅ (tarball diff) |
| 2 | ctx.cwd delegation (P1) | **Real — t03, verify-then-simplify w/ no-op exit** | `core-runtime/src/agent.ts:358-361` re-binds `createCodingTools(runCwd)` because 0.84.4 tools "capture their cwd at construction"; 0.85.1 honors per-call `ctx?.cwd` (sdk digest §3.1, all 7 tool files verified) |
| 3 | Output cap + details preserve (P1) | **Real — t02** | `subagent-tool.ts:733` returns full child text to the parent LLM; `renderBatchResult` embeds full `slot.output` per slot; no cap on the LLM-visible path (only SALVAGE_MAX_*); durable record already persists full output |
| 4 | Per-message usage ledger (P2) | **Real, priced — t05 land-or-dated-reject** | `onUsage` fires once at completion (`spawn-subagent.ts:143-147`); budget layer already observes per-API-response usage (`agent-budget.ts:103-106`) → plumb, not rebuild; threshold = one seam |
| 5 | Restorable child sessions (P2) | **Charted (D8), successor arc** | `agent.ts:446` calls `inMemory()` no-args (opt-in param, backward compatible); journaling+restore = new persistence layer; deferring costs nothing |
| 6 | Model registry freshness (P2) | **Folded into t01 (d)/(e); presets untouched (D3)** | pi-ai `zai.json` BYTE-IDENTICAL 0.84.4 ↔ 0.85.1 (measured from `/tmp/dl-pi-ai-*` research tarballs — same 7 glm ids); our registration replaces the list anyway (`pre-load-providers.ts:439-470`); `--list-models` + live glm-5.3 smoke = the proof |
| + | Project-agent trust gate (from digest §3 gap-3) | **Real — t04** | `agent-registry.ts:137-141` loads project `.pi/agents` freely, precedence project > pack > user > builtin, no `isProjectTrusted` anywhere in ext-subagent; `ctx.isProjectTrusted()` + `ui.confirm` exist since 0.84.4 (`types.d.ts:234/:72`); upstream gates project agents behind confirm, hasUI=false → block |

**Rejected with reasons** (map Scope/OUT): client/experimental subpath
migration (root-only imports — measured); pi-tui env-defaults + theme-key moves
(zero references — measured); prompt-cache ttl (no explicit-cache-mode config —
measured); new GPT-6 Astra presets (GLM-first stack, no demand — D3);
SessionWorker/RPC-mode orchestration (upstream experimental; our in-process +
subprocess isolation already covers the need — charted); SIGTERM ladder /
json-mode invocation / plan-approval (already at parity — map Context).

## Ticket set

- **t01 (P0, lands FIRST, alone)** — bump 29 files → 0.85.1, bun install
  (chord in / pi-client+pi-protocol out), full local-ci on EVERY package,
  write-tool byte-assertion sweep, setModel audit, zai/glm-5.3 list+smoke,
  version-bump at merge. Deployed contribution: the upgraded core t06 greps
  (0.85.1 version string) + verify-deploy-e2e.
- **t02 (P1)** — `CHILD_OUTPUT_CAP = 50KB` at the parent-visible boundary in
  BOTH tools, full text in `details` + durable record, grep-able marker line
  (t06's bundle-grep target). Boundary-matrix tests.
- **t03 (P1)** — probe FIRST (child cwd ≠ parent cwd: read/bash resolution on
  0.85.1, evidence committed, PB-10), then delete `agent.ts:361` re-binding OR
  documented no-op. A/B test stays as regression pin either way.
- **t04 (P2)** — project-agent trust gate at dispatch: project-source +
  untrusted + hasUI → `ui.confirm`; no-UI → default-DENY naming the file
  (mirrors request-plan-approval's timeout-default-DENY). Matrix tests; t06's
  scratch repo (untrusted) + planted `.pi/agents/evil.md` = the deployed proof.
- **t05 (P2)** — usage ledger: land only if ≤ one new seam through
  dispatchChild; else dated REJECT with committed probe note (PB-14).
- **t06** — deployed verification: pinned immutable version dir (PB-08),
  pre-drive bundle greps incl. core-cache MISS check (PB-09, learning #1),
  scratch-repo isolation (arc-24 pattern), scenarios a–d all GLM-5.3 (flash
  excluded by name), receipts → `evidence/` (PB-18), tui-drive discipline
  (learnings #3/#4/#5).
- **t07** — close-out: Shipped-as + status flip SAME PR (PB-05), ledger
  mergedPr, effort-audit exit 0, back-links both maps (PB-16), successor
  next-goal strict v2 + validator + LATEST repoint + doctor (PB-03/04),
  playbook curation.

PR mechanics: devops chain only; t01 alone first; t02–t05 independently
mergeable in order (collapse allowed only on shared-file diffs, stated in the
PR body); final implementation PR bumps version so the t06 deploy label names
the newest bytes; t06 receipts-only; t07 docs PR.

## Learnings / playbook entries applied

- **Learning #1** (label ≠ content): t06 greps the pi 0.85.1 string + t02
  marker + t04 deny strings in the SHIPPED bundles before driving; core-cache
  MISS verified (pi version is a hash input — a hit means the cache is broken).
- **Learning #2** (`@repo/*` link farm): t01's `bun install` recompute is the
  known re-breaker window; the `#2264` self-heal covers it — t06's greps are
  the backstop.
- **PB-08/09/10/11/13/14/15/18** — pinned dirs, pre-registered checks,
  pre-change probe receipts, preserved failures, retry caps, recorded gaps,
  committed evidence paths (all cited in map D10 + t06).
- **PB-01/02** — tree already synced to tip at `6c3c400f` on the claimed
  branch; ledger 25 active (verified this session).
- **PB-06/07** — independent reviewer pass before each merge; if any ticket
  ships a gate (t04's deny), that gate bites its own PR (the matrix test +
  the arc's own scratch-repo deny attempt).
